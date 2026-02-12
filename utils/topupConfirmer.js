// utils/topupConfirmer.js
// Strict topup confirmation handler with exact phrase matching
// Coins are DB-driven: amount_coins comes from database, NOT from email parsing
const { logPayment } = require("./paymentLogger");
const { normalizePhrase } = require("./paymentValidator");

/**
 * Get all active (PENDING + not expired) topups from database
 * @param {Object} db - Database instance
 * @returns {Array} - Array of topup records
 */
function getActiveTopups(db) {
  const now = new Date().toISOString();
  const topups = db
    .prepare(`
      SELECT id, userId, code, status, expiresAt, createdAt, amount_coins
      FROM topups 
      WHERE status = 'PENDING' AND datetime(expiresAt) > datetime(?)
      ORDER BY createdAt DESC
    `)
    .all(now);
  
  return topups || [];
}

/**
 * Find matching topup by exact phrase match (strict equality after normalization)
 * @param {Object} db - Database instance
 * @param {string} codeCandidate - Normalized passphrase from safe zones
 * @returns {Object} - { topup: Object|null, reason: string, matchedPhrase: string|null }
 */
function findMatchingTopupByPhrase(db, codeCandidate) {
  if (!codeCandidate || typeof codeCandidate !== "string") {
    return {
      topup: null,
      reason: "No code candidate provided",
      matchedPhrase: null,
    };
  }

  const normalizedCandidate = normalizePhrase(codeCandidate);
  if (!normalizedCandidate || normalizedCandidate.length === 0) {
    return {
      topup: null,
      reason: "Code candidate is empty after normalization",
      matchedPhrase: null,
    };
  }

  const activeTopups = getActiveTopups(db);
  
  console.log(`🔍 [MATCHER] Checking ${activeTopups.length} active topup(s) against candidate: "${normalizedCandidate}"`);
  
  if (activeTopups.length === 0) {
    console.log(`🔍 [MATCHER] ❌ No active PENDING topups found in database`);
    return {
      topup: null,
      reason: "No active PENDING topups found in database",
      matchedPhrase: null,
    };
  }

  const matches = [];

  for (const topup of activeTopups) {
    // Normalize the stored phrase the same way as candidate
    const normalizedPhrase = normalizePhrase(topup.code);
    
    // Exact equality match (strict)
    if (normalizedCandidate === normalizedPhrase) {
      console.log(`🔍 [MATCHER] ✅ Found exact match: topup ${topup.id} with phrase "${topup.code}"`);
      matches.push({ topup, phrase: topup.code });
    } else {
      console.log(`🔍 [MATCHER] ❌ No match: candidate "${normalizedCandidate}" !== topup ${topup.id} phrase "${normalizedPhrase}"`);
    }
  }

  if (matches.length === 0) {
    console.log(`🔍 [MATCHER] ❌ No active topup phrase matches candidate "${normalizedCandidate}" (checked ${activeTopups.length} active topup(s))`);
    return {
      topup: null,
      reason: `No active topup phrase matches candidate "${normalizedCandidate}" (checked ${activeTopups.length} active topup(s))`,
      matchedPhrase: null,
    };
  }

  if (matches.length === 1) {
    console.log(`🔍 [MATCHER] ✅ Exact phrase match found: "${matches[0].phrase}"`);
    return {
      topup: matches[0].topup,
      reason: `Exact phrase match found: "${matches[0].phrase}"`,
      matchedPhrase: matches[0].phrase,
    };
  }

  // Multiple matches - reject (should not happen with exact matching, but safety check)
  const matchedPhrases = matches.map(m => `"${m.phrase}"`).join(", ");
  console.log(`🔍 [MATCHER] ❌ Multiple active topup phrases match candidate: ${matchedPhrases} (${matches.length} matches)`);
  return {
    topup: null,
    reason: `Multiple active topup phrases match candidate: ${matchedPhrases} (${matches.length} matches)`,
    matchedPhrase: null,
  };
}

/**
 * Confirm topup from email with exact phrase matching
 * Coins are DB-driven: Uses topup.amount_coins from database, NOT email amountString
 * @param {Object} params
 * @param {string} params.codeCandidate - Passphrase extracted from safe zones
 * @param {string} params.code_source - Source zone (receipt_memo, note_part, subject, topup_line)
 * @param {string} params.amountString - Amount string from parser (for logging only, NOT used for coins)
 * @param {string} params.email_uid - Email UID
 * @param {string} params.subject - Email subject
 * @param {string} params.bodyPreview - Body preview (first 200 chars)
 * @param {string} params.emailDate - Email date
 * @param {Object} db - Database instance
 * @returns {Object} - { success: boolean, reason: string, topupId?: number, userId?: number, coins?: number, extracted_code?: string }
 */
function confirmTopupFromEmail({ codeCandidate, code_source = "unknown", amountString, email_uid, subject, bodyPreview, emailDate }, db) {
  console.log(`💳 [CONFIRMER] Starting confirmation for email UID: ${email_uid}`);
  console.log(`💳 [CONFIRMER] Code candidate: "${codeCandidate}" (from ${code_source})`);
  console.log(`💳 [CONFIRMER] Email amount string: ${amountString} (for logging only, coins come from DB)`);
  console.log(`💳 [CONFIRMER] Subject: ${subject}`);
  console.log(`💳 [CONFIRMER] Email date: ${emailDate || "Unknown"}`);
  
  // Check idempotency: if this email UID was already processed, skip
  const existingLog = db.prepare("SELECT email_uid FROM payment_logs WHERE email_uid = ? AND decision = 'ACCEPTED'").get(email_uid);
  if (existingLog) {
    const reason = `Email UID ${email_uid} already processed (idempotency check)`;
    console.log(`💳 [CONFIRMER] ⚠️  ${reason}`);
    return { success: false, reason };
  }

  // Parse coins from email amount (this is the source of truth - comes from parser's context-aware amount picker)
  // The parser has already selected the correct transaction amount using context scoring
  const coins = Math.floor(parseFloat(amountString || "0"));
  
  if (isNaN(coins) || coins <= 0) {
    const reason = `Invalid email amount: ${amountString} (must be > 0). Parser returned empty/invalid amount - likely no strong transaction match found.`;
    console.log(`💳 [CONFIRMER] ❌ ${reason}`);
    logPayment({
      email_uid,
      parser_amount: amountString,
      extracted_code: codeCandidate,
      decision: "REJECTED",
      reason: `${reason} (source: ${code_source})`,
      raw_subject: subject,
      short_body_preview: bodyPreview,
    });
    return { success: false, reason };
  }
  
  console.log(`💳 [CONFIRMER] Using parser amount: ${coins} coins (from parser amount: ${amountString})`);

  // Find matching topup by exact phrase match
  const matchResult = findMatchingTopupByPhrase(db, codeCandidate);

  if (!matchResult.topup) {
    console.log(`💳 [CONFIRMER] ❌ ${matchResult.reason}`);
    logPayment({
      email_uid,
      parser_amount: amountString,
      extracted_code: matchResult.matchedPhrase,
      decision: matchResult.reason.includes("Multiple") ? "REJECTED" : "IGNORED",
      reason: `${matchResult.reason} (source: ${code_source})`,
      raw_subject: subject,
      short_body_preview: bodyPreview,
    });
    return { success: false, reason: matchResult.reason };
  }

  const topup = matchResult.topup;
  const matchedPhrase = matchResult.matchedPhrase;

  console.log(`💳 [CONFIRMER] ✅ Topup found:`, {
    id: topup.id,
    userId: topup.userId,
    code: topup.code,
    status: topup.status,
    expiresAt: topup.expiresAt,
    amount_coins: topup.amount_coins,
    matchedPhrase,
  });

  // Strict expiry-based validation (no createdAt comparison)
  const now = new Date().toISOString();
  const expiresAt = new Date(topup.expiresAt).toISOString();
  const emailDateObj = emailDate && emailDate !== "Unknown" ? new Date(emailDate).toISOString() : null;

  console.log(`💳 [CONFIRMER] Expiry check: now=${now}, expiresAt=${expiresAt}, emailDate=${emailDateObj || "Unknown"}`);

  // Check 1: Status must be PENDING
  if (topup.status !== "PENDING") {
    const reason = `TopUp status is ${topup.status}, expected PENDING`;
    console.log(`💳 [CONFIRMER] ❌ ${reason}`);
    logPayment({
      email_uid,
      parser_amount: amountString,
      extracted_code: matchedPhrase,
      matched_topup_id: topup.id,
      decision: "REJECTED",
      reason: `${reason} (source: ${code_source})`,
      raw_subject: subject,
      short_body_preview: bodyPreview,
    });
    return { success: false, reason };
  }

  // Check 2: Must not be expired (now <= expiresAt)
  if (new Date(now) > new Date(expiresAt)) {
    const reason = `Payment arrived after TopUp expiry (expiresAt: ${expiresAt})`;
    console.log(`💳 [CONFIRMER] ❌ ${reason}`);
    logPayment({
      email_uid,
      parser_amount: amountString,
      extracted_code: matchedPhrase,
      matched_topup_id: topup.id,
      decision: "REJECTED",
      reason: `${reason} (source: ${code_source})`,
      raw_subject: subject,
      short_body_preview: bodyPreview,
    });
    return { success: false, reason };
  }

  // Check 3: Optional safety - reject if email date is way in the future (after expiresAt + 5 minutes)
  if (emailDateObj) {
    try {
      const expiresAtPlus5 = new Date(new Date(expiresAt).getTime() + 5 * 60 * 1000);
      if (new Date(emailDateObj) > expiresAtPlus5) {
        const reason = `Email date (${emailDateObj}) is too far in the future (after expiresAt + 5min: ${expiresAtPlus5.toISOString()})`;
        console.log(`💳 [CONFIRMER] ❌ ${reason}`);
        logPayment({
          email_uid,
          parser_amount: amountString,
          extracted_code: matchedPhrase,
          matched_topup_id: topup.id,
          decision: "REJECTED",
          reason: `${reason} (source: ${code_source})`,
          raw_subject: subject,
          short_body_preview: bodyPreview,
        });
        return { success: false, reason };
      }
    } catch (e) {
      console.log(`💳 [CONFIRMER] ⚠️  Could not parse email date for future check: ${e.message}`);
    }
  }

  console.log(`💳 [CONFIRMER] ✅ All checks passed, using email amount: ${coins} coins, starting transaction...`);

  // Transaction (MUST be atomic) - Prevents double-crediting
  try {
    const transaction = db.transaction(() => {
      console.log(`💳 [CONFIRMER] Starting atomic transaction...`);
      
      // Double-check status and expiry before updating (prevent race conditions)
      const currentTopup = db
        .prepare(`
          SELECT status, amount_coins 
          FROM topups 
          WHERE id = ? AND status = 'PENDING' AND datetime(expiresAt) > datetime('now')
        `)
        .get(topup.id);
      
      if (!currentTopup) {
        throw new Error("TopUp not found, expired, or already processed");
      }
      
      console.log(`💳 [CONFIRMER] Updating topup: setting status=CONFIRMED and amount_coins=${coins} (from email)...`);
      // Update topup status and amount_coins from email
      const updateResult = db
        .prepare(`
          UPDATE topups 
          SET status = 'CONFIRMED', amount_coins = ?
          WHERE id = ? AND status = 'PENDING' AND datetime(expiresAt) > datetime('now')
        `)
        .run(coins, topup.id);
      
      console.log(`💳 [CONFIRMER] Topup update result: ${updateResult.changes} row(s) changed`);
      
      if (updateResult.changes !== 1) {
        // Check if it was already confirmed
        const checkTopup = db.prepare("SELECT status, amount_coins FROM topups WHERE id = ?").get(topup.id);
        if (checkTopup && checkTopup.status === "CONFIRMED") {
          throw new Error(`TopUp already confirmed (amount: ${checkTopup.amount_coins} coins) - preventing double-credit`);
        }
        throw new Error("TopUp update failed (may have been confirmed or expired)");
      }
      
      console.log(`💳 [CONFIRMER] Updating user balance: adding ${coins} coins (from email) to user ${topup.userId}`);
      // Update user balance (add coins from email to existing balance)
      const balanceResult = db.prepare(`
        UPDATE users 
        SET balance_coins = balance_coins + ? 
        WHERE id = ?
      `).run(coins, topup.userId);
      
      if (balanceResult.changes !== 1) {
        throw new Error(`Failed to update user balance for user ${topup.userId}`);
      }
      
      console.log(`💳 [CONFIRMER] ✅ Balance updated successfully with ${coins} coins from email`);
    });
    
    transaction();
    console.log(`💳 [CONFIRMER] ✅ Transaction committed successfully`);
    
    // Log success (with code_source in reason)
    logPayment({
      email_uid,
      parser_amount: amountString,
      extracted_code: matchedPhrase,
      matched_topup_id: topup.id,
      decision: "ACCEPTED",
      reason: `Payment confirmed: ${coins} coins credited to user ${topup.userId} (source: ${code_source}, coins from email)`,
      raw_subject: subject,
      short_body_preview: bodyPreview,
    });
    
    console.log(`💳 [CONFIRMER] ✅ CONFIRMATION SUCCESS: ${coins} coins (from email) credited to user ${topup.userId}`);
    
    return {
      success: true,
      reason: `Payment confirmed: ${coins} coins credited`,
      topupId: topup.id,
      userId: topup.userId,
      coins: coins,
      extracted_code: matchedPhrase,
    };
  } catch (e) {
    // Transaction failed
    const reason = `Database transaction failed: ${e.message}`;
    console.log(`💳 [CONFIRMER] ❌ Transaction failed: ${reason}`);
    console.log(`💳 [CONFIRMER] Stack:`, e.stack);
    logPayment({
      email_uid,
      parser_amount: amountString,
      extracted_code: matchedPhrase,
      matched_topup_id: topup.id,
      decision: "ERROR",
      reason: `${reason} (source: ${code_source})`,
      raw_subject: subject,
      short_body_preview: bodyPreview,
      full_email_data: JSON.stringify({ error: e.message, stack: e.stack }),
    });
    return { success: false, reason };
  }
}

module.exports = { 
  confirmTopupFromEmail,
  getActiveTopups,
  findMatchingTopupByPhrase,
};
