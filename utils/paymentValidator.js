// utils/paymentValidator.js
// Strict payment validation (exact phrase matching against active topups)

const { logPayment } = require("./paymentLogger");

/**
 * Normalize text for exact phrase matching:
 * - Lowercase
 * - Collapse multiple whitespace into single spaces
 * - Trim
 * @param {string} text - Text to normalize
 * @returns {string} - Normalized text
 */
function normalizePhrase(text) {
  if (!text || typeof text !== "string") return "";
  
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")        // Collapse multiple spaces
    .trim();
}

/**
 * Extract TOPUP line from email body (testing helper)
 * Matches: "TOPUP: <passphrase>" (case-insensitive, multiline)
 * Extracts everything after "TOPUP:" and trims spaces
 * @param {string} emailBody - Email body text
 * @returns {string|null} - Extracted passphrase (normalized) or null
 */
function extractTopupLine(emailBody) {
  if (!emailBody || typeof emailBody !== "string") return null;
  
  // Match line starting with "TOPUP:" (case-insensitive, multiline)
  // Extract everything after the colon and trim
  const match = emailBody.match(/^\s*topup\s*:\s*(.+)\s*$/im);
  if (match && match[1]) {
    // Normalize: lowercase, collapse whitespace, trim
    return normalizePhrase(match[1]);
  }
  
  return null;
}

/**
 * Extract passphrase from SAFE ZONES only (in priority order)
 * Priority: TOPUP: line (for testing) > note_part > receipt_memo > subject
 * @param {Object} parserData - Data from Python parser
 * @param {string} emailBody - Full email body text (for TOPUP: line extraction)
 * @param {string} emailSubject - Email subject
 * @returns {Object} - { code: string|null, code_source: string|null }
 */
function extractPassphraseFromSafeZones(parserData, emailBody, emailSubject) {
  const {
    receipt_memo = "",
    note_part = "",
    subject = "",
  } = parserData;

  // Priority order: TOPUP line (testing) > note_part > receipt_memo > subject
  // Check TOPUP: line FIRST (highest priority for testing)
  const topupLine = extractTopupLine(emailBody || "");
  if (topupLine) {
    console.log(`🔍 [VALIDATOR] ✅ Found TOPUP: line in email body: "${topupLine}"`);
    return { code: topupLine, code_source: "topup_line" };
  }

  // Fallback to other safe zones
  const candidates = [
    { text: note_part, source: "note_part" },
    { text: receipt_memo, source: "receipt_memo" },
    { text: emailSubject || subject, source: "subject" },
  ];

  // Pick first non-empty candidate
  for (const candidate of candidates) {
    const normalized = normalizePhrase(candidate.text);
    if (normalized && normalized.length > 0) {
      console.log(`🔍 [VALIDATOR] ✅ Extracted passphrase from ${candidate.source}: "${normalized}"`);
      return { code: normalized, code_source: candidate.source };
    }
  }

  console.log(`🔍 [VALIDATOR] ❌ No passphrase found in any safe zone`);
  return { code: null, code_source: null };
}

/**
 * Validate payment data from Python parser
 * @param {Object} parserData - Data from Python parser
 * @param {string} parserData.amount - Amount string
 * @param {string} parserData.pay_type - "sent" | "request" | others
 * @param {string} parserData.request_status - "active" | "expired" | "not_actionable" | ""
 * @param {boolean|null} parserData.is_expired - Is expired flag
 * @param {string} parserData.receipt_memo - Memo text
 * @param {string} parserData.note_part - Note text
 * @param {string} parserData.subject - Subject text
 * @param {string} emailBody - Full email body text
 * @param {string} emailSubject - Email subject
 * @param {string} emailUid - Email UID
 * @returns {Object} - Validation result
 */
function validatePayment(parserData, emailBody, emailSubject, emailUid) {
  const {
    amount,
    pay_type,
    request_status = "",
    is_expired = null,
    receipt_memo = "",
    note_part = "",
    subject = "",
  } = parserData;

  // Extract passphrase from SAFE ZONES only
  const { code: codeCandidate, code_source } = extractPassphraseFromSafeZones(
    parserData,
    emailBody || "",
    emailSubject || ""
  );

  // Log initial validation attempt
  const logData = {
    email_uid: emailUid,
    parser_pay_type: pay_type,
    parser_amount: amount,
    parser_request_status: request_status,
    parser_is_expired: is_expired,
    extracted_code: codeCandidate,
    matched_topup_id: null,
    decision: "IGNORED",
    reason: null,
    raw_subject: emailSubject || subject,
    short_body_preview: (receipt_memo || note_part || emailSubject || subject || "").substring(0, 200),
  };

  // Rule 1: Must be "sent" payment type
  if (pay_type !== "sent") {
    logData.decision = "REJECTED";
    logData.reason = `Invalid pay_type: ${pay_type} (only "sent" payments accepted)`;
    logPayment(logData);
    return { valid: false, reason: logData.reason, codeCandidate: null, code_source: null };
  }

  // Rule 2: Amount must exist and be > 0
  if (!amount || amount.trim() === "") {
    logData.decision = "REJECTED";
    logData.reason = "Amount missing or empty";
    logPayment(logData);
    return { valid: false, reason: logData.reason, codeCandidate: null, code_source: null };
  }

  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    logData.decision = "REJECTED";
    logData.reason = `Invalid amount: ${amount} (must be > 0)`;
    logPayment(logData);
    return { valid: false, reason: logData.reason, codeCandidate: null, code_source: null };
  }

  // Rule 3: Request status must be empty or "active"
  if (request_status && request_status !== "" && request_status !== "active") {
    logData.decision = "REJECTED";
    logData.reason = `Invalid request_status: ${request_status}`;
    logPayment(logData);
    return { valid: false, reason: logData.reason, codeCandidate: null, code_source: null };
  }

  // Rule 4: Must not be expired
  if (is_expired === true) {
    logData.decision = "REJECTED";
    logData.reason = "Payment marked as expired by parser";
    logPayment(logData);
    return { valid: false, reason: logData.reason, codeCandidate: null, code_source: null };
  }

  // Rule 5: Must have code candidate from safe zones
  if (!codeCandidate) {
    logData.reason = "No passphrase found in safe zones (receipt_memo, note_part, subject, TOPUP line)";
    logPayment(logData);
    return { valid: false, reason: logData.reason, codeCandidate: null, code_source: null };
  }

  // If we get here, basic validation passed
  // Exact matching will be done in confirmTopupFromEmail
  return {
    valid: true,
    amount: amountNum,
    codeCandidate,
    code_source,
    reason: `Basic validation passed - passphrase extracted from ${code_source}`,
  };
}

/**
 * Validate topup status and expiry
 * @param {Object} topup - Topup record from database
 * @param {string} code - TopUp code
 * @param {string} emailUid - Email UID for logging
 * @returns {Object} - Validation result
 */
function validateTopupStatus(topup, code, emailUid) {
  const logData = {
    email_uid: emailUid,
    extracted_code: code,
    matched_topup_id: topup ? topup.id : null,
    decision: "REJECTED",
    reason: null,
  };

  // Rule 6: Topup must exist
  if (!topup) {
    logData.reason = "TopUp code not found in database";
    logPayment(logData);
    return { valid: false, reason: logData.reason };
  }

  logData.matched_topup_id = topup.id;

  // Rule 7: Topup must be PENDING
  if (topup.status !== "PENDING") {
    logData.reason = `TopUp already ${topup.status}`;
    logPayment(logData);
    return { valid: false, reason: logData.reason };
  }

  // Rule 8: Topup must not be expired
  const now = new Date();
  const expiresAt = new Date(topup.expiresAt);

  if (now > expiresAt) {
    logData.reason = "Payment arrived after TopUp expiry";
    logPayment(logData);
    return { valid: false, reason: logData.reason };
  }

  return { valid: true };
}

module.exports = {
  normalizePhrase,
  extractTopupLine,
  extractPassphraseFromSafeZones,
  validatePayment,
  validateTopupStatus,
};

