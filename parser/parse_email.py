#!/usr/bin/env python3
"""
Email parser for payment confirmations
Outputs JSON to stdout, logs debug info to stderr

Goal:
- Pick the REAL transaction amount from payment emails.
- Reject "note/memo/message/for/remark" dollar amounts that appear later in the email.
- DO NOT hard-reject everything just because a note marker appears early in raw HTML.
"""

import json
import sys
import re
import os
from html.parser import HTMLParser


# ----------------------------
# HTML stripping + normalization
# ----------------------------

class HTMLStripper(HTMLParser):
    """Simple HTML tag stripper"""
    def __init__(self):
        super().__init__()
        self.text = []

    def handle_data(self, data):
        self.text.append(data)

    def get_text(self):
        return " ".join(self.text)


def strip_html(html_content: str) -> str:
    """Strip HTML tags from content"""
    if not html_content:
        return ""
    try:
        stripper = HTMLStripper()
        stripper.feed(html_content)
        return stripper.get_text()
    except Exception:
        # If HTML parsing fails, return original (will be handled by regex)
        return html_content


def normalize_text(text: str) -> str:
    """Normalize text: strip html, lowercase, collapse whitespace"""
    if not text:
        return ""
    text = strip_html(text)
    text = re.sub(r"\s+", " ", text)
    return text.lower().strip()


# ----------------------------
# Note-region detection (soft guidance only)
# ----------------------------

def find_note_region_start(text: str):
    """
    Find an approximate "note/memo/message" region start.

    IMPORTANT:
    - This is a *soft* signal only.
    - Some email HTML puts the word "note" early in the markup even if the actual note is later.
    - So we NEVER blanket-reject all amounts after this index.
    """
    # Prefer markers with ":" or " - " which are more like fields
    marker_patterns = [
        r"\bnote\s*:",
        r"\bmemo\s*:",
        r"\bmessage\s*:",
        r"\bremark\s*:",
        r"\bdescription\s*:",
        r"\bfor\s*:",

        # Also allow looser markers, but these are weaker signals
        r"\bnote\b",
        r"\bmemo\b",
        r"\bmessage\b",
        r"\bremark\b",
        r"\bdescription\b",
        r"\bfor\b",
    ]

    earliest_pos = None
    earliest_marker = None

    for pat in marker_patterns:
        for m in re.finditer(pat, text, re.IGNORECASE):
            pos = m.start()
            if earliest_pos is None or pos < earliest_pos:
                earliest_pos = pos
                earliest_marker = pat

    return (earliest_pos, earliest_marker) if earliest_pos is not None else (None, None)


# ----------------------------
# Currency candidate extraction
# ----------------------------

def extract_currency_candidates(text: str):
    """
    Extract possible currency candidates.

    Returns list of dict:
      { value, start, end, matched, full_match }
    """
    candidates = []

    # Covers: $10, $10.00, 10.00, 1,234.56, 10.00 usd, etc.
    patterns = [
        r"\$[\s]*([\d,]+(?:\.\d+)?)",                 # $10, $10.00, $1,234.56
        r"([\d,]+\.\d{2})\s*(?:dollars?|usd|us\s*\$)", # 10.00 usd
        r"([\d,]+\.\d{2})\b",                          # 10.00
        r"\$[\s]*([\d,]+)\b",                          # $10 (no decimal)
    ]

    for pat in patterns:
        for match in re.finditer(pat, text, re.IGNORECASE):
            raw = match.group(1)
            amt_str = raw.replace(",", "")
            try:
                value = float(amt_str)
                if value > 0:
                    candidates.append({
                        "value": value,
                        "start": match.start(),
                        "end": match.end(),
                        "matched": match.group(0),
                        "full_match": match.group(0),
                    })
            except ValueError:
                continue

    # De-dup: same value at same start index
    seen = set()
    uniq = []
    for c in candidates:
        key = (c["value"], c["start"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(c)

    return uniq


# ----------------------------
# Scoring
# ----------------------------

def score_amount_candidate(candidate, text, transaction_keywords, bad_context_keywords, note_region_start):
    """
    Returns:
      (final_score, matched_keyword, reason, tx_score, strong_tx_score, note_penalty, tx_override, in_note_region)

    Rules:
    - Strongly prefer amounts near transaction keywords (received/paid/credited/completed).
    - Penalize amounts near note/memo/message/etc.
    - Penalize (softly) amounts after note_region_start, but DO NOT hard reject.
    - If strong transaction proximity is high enough, override note penalties.
    """

    start = candidate["start"]
    end = candidate["end"]

    # context window around candidate
    ctx_start = max(0, start - 140)
    ctx_end = min(len(text), end + 140)
    ctx = text[ctx_start:ctx_end]

    # Strong keywords for override (must be meaningful real-payment signals)
    strong_tx_keywords = [
        "you just received",
        "you received",
        "you got paid",
        "received",
        "credited",
        "completed",
        "deposit",
        "payment received",
        "transaction completed",
    ]

    matched_keyword = None
    reasons = []

    # ---- transaction score ----
    tx_score = 0
    strong_tx_score = 0

    for kw in transaction_keywords:
        pos = ctx.find(kw)
        if pos >= 0:
            dist = abs(pos - (start - ctx_start))
            prox = max(0, 120 - dist)  # 0..120
            tx_score += prox
            if kw in strong_tx_keywords:
                strong_tx_score += prox
            if matched_keyword is None:
                matched_keyword = kw
            reasons.append(f"near_{kw}")

    # ---- note penalties ----
    note_penalty = 0
    in_note_region = False

    # Soft penalty if after note region start
    if note_region_start is not None and start >= note_region_start:
        in_note_region = True
        note_penalty -= 180
        reasons.append("after_note_region")

    # Penalize if note-ish keywords are in the near context
    bad_hits = 0
    for bad_kw in bad_context_keywords:
        bad_pos = ctx.find(bad_kw)
        if bad_pos >= 0:
            # If this is likely the note marker itself and the amount is before note region, ignore it
            if note_region_start is not None and start < note_region_start:
                abs_bad_pos = ctx_start + bad_pos
                if abs(abs_bad_pos - note_region_start) <= 40:
                    continue
            bad_hits += 1

    if bad_hits > 0:
        note_penalty -= 220 * bad_hits
        reasons.append(f"bad_context_hits:{bad_hits}")

    # ---- override logic ----
    # If strong tx score is high enough, override note penalties
    tx_override = False
    if strong_tx_score >= 60:
        tx_override = True
        note_penalty = 0
        reasons.append("tx_override_note_penalty")

    # ---- position bonus (small) ----
    # Slight preference for earlier occurrences but NOT enough to beat tx signals
    position_bonus = max(0, 300 - (start // 40))  # 0..300-ish

    # ---- final score ----
    final_score = tx_score + note_penalty + position_bonus

    reason = ",".join(reasons) if reasons else "no_signals"
    return (final_score, matched_keyword, reason, tx_score, strong_tx_score, note_penalty, tx_override, in_note_region)


# ----------------------------
# Amount picker
# ----------------------------

def pick_transaction_amount(email_content: str, email_subject: str):
    """
    Returns: (amount_string, debug_info_dict)
    """
    combined_text = normalize_text(f"{email_subject} {email_content}")

    note_region_start, note_marker = find_note_region_start(combined_text)

    transaction_keywords = [
        "you just received",
        "you received",
        "you got paid",
        "payment received",
        "transaction completed",
        "received",
        "paid",
        "payment",
        "sent",
        "transfer",
        "transaction",
        "amount",
        "deposit",
        "credited",
        "completed",
    ]

    bad_context_keywords = [
        "note",
        "memo",
        "message",
        "remark",
        "description",
        "for example",
        "example",
        "sample",
        "illustration",
        "e.g.",
        "such as",
    ]

    candidates = extract_currency_candidates(combined_text)

    debug = {
        "note_region_start": note_region_start,
        "note_marker": note_marker,
        "total_candidates": len(candidates),
        "rejected_due_to_low_confidence": 0,
        "accepted_by_tx_override": 0,
    }

    if not candidates:
        debug.update({
            "reason": "no_candidates",
            "chosen_amount": None,
            "matched_keyword": None,
            "chosen_index": None,
            "chosen_matched_text": None,
        })
        return ("", debug)

    scored = []
    for idx, cand in enumerate(candidates):
        (score, mk, reason, tx_score, strong_tx_score, note_penalty, tx_override, in_note_region) = score_amount_candidate(
            cand, combined_text, transaction_keywords, bad_context_keywords, note_region_start
        )

        if tx_override:
            debug["accepted_by_tx_override"] += 1

        scored.append({
            "candidate": cand,
            "score": score,
            "matched_keyword": mk,
            "reason": reason,
            "tx_score": tx_score,
            "strong_tx_score": strong_tx_score,
            "note_penalty": note_penalty,
            "tx_override": tx_override,
            "in_note_region": in_note_region,
            "index": idx,
        })

    # sort: score desc, then earlier occurrence
    scored.sort(key=lambda x: (-x["score"], x["candidate"]["start"]))

    # top 3 debug summary
    top3 = []
    for s in scored[:3]:
        top3.append({
            "value": s["candidate"]["value"],
            "start": s["candidate"]["start"],
            "score": s["score"],
            "tx_score": s["tx_score"],
            "strong_tx_score": s["strong_tx_score"],
            "note_penalty": s["note_penalty"],
            "tx_override": s["tx_override"],
            "in_note_region": s["in_note_region"],
            "reason": s["reason"],
        })
    debug["top3_candidates"] = top3

    best = scored[0]

    # Acceptance rules (safe):
    # - If strong_tx_score is decent OR tx_score is decent and not heavily penalized
    # - Avoid accepting a pure note amount:
    #   If it's in note region AND has no strong tx score, reject.
    best_tx = best["tx_score"]
    best_strong = best["strong_tx_score"]
    best_in_note = best["in_note_region"]

    confident = False

    # Strong approval path: strong tx context
    if best_strong >= 60:
        confident = True

    # Normal approval path: good tx_score and final score positive, and not in_note without strong tx
    if not confident:
        if best["score"] > 0 and best_tx >= 40:
            if not (best_in_note and best_strong < 60):
                confident = True

    if confident:
        amount_value = best["candidate"]["value"]
        debug.update({
            "chosen_amount": amount_value,
            "matched_keyword": best["matched_keyword"],
            "chosen_index": best["candidate"]["start"],
            "chosen_matched_text": best["candidate"]["matched"][:80],
            "score": best["score"],
            "tx_score": best_tx,
            "strong_tx_score": best_strong,
            "note_penalty": best["note_penalty"],
            "tx_override": best["tx_override"],
            "reason": best["reason"],
        })
        return (str(amount_value), debug)

    debug["rejected_due_to_low_confidence"] = 1
    debug.update({
        "reason": "no_strong_match",
        "best_score": best["score"],
        "best_tx_score": best_tx,
        "best_strong_tx_score": best_strong,
        "best_in_note": best_in_note,
        "best_reason": best["reason"],
        "chosen_amount": None,
        "matched_keyword": None,
        "chosen_index": None,
        "chosen_matched_text": None,
    })
    return ("", debug)


# ----------------------------
# Main parse
# ----------------------------

def parse_email(email_content: str, email_subject: str):
    """
    Returns dict with:
      amount, pay_type, request_status, is_expired, receipt_memo, note_part, subject, (optional) amount_debug
    """
    result = {
        "amount": "",
        "pay_type": "",
        "request_status": "",
        "is_expired": False,
        "receipt_memo": "",
        "note_part": "",
        "subject": email_subject or "",
    }

    combined_text = normalize_text(f"{email_subject} {email_content}")

    amount_str, amount_debug = pick_transaction_amount(email_content, email_subject)
    result["amount"] = amount_str

    # include debug only if short
    if amount_debug:
        debug_str = json.dumps(amount_debug, separators=(",", ":"))
        # allow a bit larger; if it grows, we still keep it safe
        if len(debug_str) < 900:
            result["amount_debug"] = debug_str

    # pay_type
    if any(w in combined_text for w in ["sent", "paid", "payment", "transferred", "received", "deposit", "credited"]):
        result["pay_type"] = "sent"
    elif any(w in combined_text for w in ["request", "requested", "asking"]):
        result["pay_type"] = "request"
    else:
        result["pay_type"] = "unknown"

    # expired
    if any(w in combined_text for w in ["expired", "expiry", "invalid", "cancelled"]):
        result["is_expired"] = True

    # request_status
    if "expired" in combined_text:
        result["request_status"] = "expired"
    elif "active" in combined_text:
        result["request_status"] = "active"
    else:
        result["request_status"] = ""

    # keep backward-compat fields
    result["receipt_memo"] = ""
    result["note_part"] = ""

    return result


# ----------------------------
# Self-test mode
# ----------------------------

def self_test():
    tests = [
        {
            "name": "Real amount $10, note contains $50",
            "content": "You just received $10.00 from John Doe. Note: $50 for services",
            "subject": "Payment received",
            "expect": "10.0",
        },
        {
            "name": "Amount before note marker",
            "content": "Payment of $25.00 completed. Memo: $100 tip",
            "subject": "Payment",
            "expect": "25.0",
        },
        {
            "name": "Multiple amounts, message has $200",
            "content": "You received $15.50. Transaction completed. Message: $200 refund",
            "subject": "Received",
            "expect": "15.5",
        },
        {
            "name": "Only note amount should reject",
            "content": "Note: $30.00",
            "subject": "Payment",
            "expect": "",
        },
    ]

    print("Running parser self-tests...", file=sys.stderr)
    ok = 0
    bad = 0
    for t in tests:
        r = parse_email(t["content"], t["subject"])
        got = r.get("amount", "")
        if got == t["expect"]:
            print(f"✓ PASS {t['name']} -> {got}", file=sys.stderr)
            ok += 1
        else:
            print(f"✗ FAIL {t['name']} expected {t['expect']} got {got}", file=sys.stderr)
            if r.get("amount_debug"):
                print(f"  debug={r['amount_debug']}", file=sys.stderr)
            bad += 1

    print(f"Tests done: {ok} passed, {bad} failed", file=sys.stderr)
    sys.exit(0 if bad == 0 else 1)


# ----------------------------
# Entrypoint
# ----------------------------

def main():
    if os.getenv("PARSER_SELFTEST") == "1":
        self_test()
        return

    try:
        raw = sys.stdin.read()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            print(f"Error parsing input JSON: {e}", file=sys.stderr)
            sys.exit(1)

        email_content = data.get("content", "")
        email_subject = data.get("subject", "")

        result = parse_email(email_content, email_subject)

        # log debug to stderr
        if result.get("amount_debug"):
            print(f"Amount picker debug: {result['amount_debug']}", file=sys.stderr)

        print(json.dumps(result, ensure_ascii=False))

    except Exception as e:
        print(f"Parser error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)

        error_result = {
            "amount": "",
            "pay_type": "",
            "request_status": "",
            "is_expired": True,
            "receipt_memo": "",
            "note_part": "",
            "subject": "",
        }
        print(json.dumps(error_result))
        sys.exit(1)


if __name__ == "__main__":
    main()
