// utils/paymentLogger.js
// Central payment logging system
const db = require("../db");

/**
 * Log a payment processing attempt
 * @param {Object} logData - Log entry data
 * @param {string} logData.email_uid - Email UID
 * @param {string} logData.parser_pay_type - Payment type from parser ("sent", "request", etc.)
 * @param {string} logData.parser_amount - Amount from parser
 * @param {string} logData.parser_request_status - Request status ("active", "expired", etc.)
 * @param {boolean|null} logData.parser_is_expired - Is expired flag
 * @param {string} logData.extracted_code - Extracted TopUp code (if any)
 * @param {number|null} logData.matched_topup_id - Matched topup ID (if any)
 * @param {string} logData.decision - Decision: "ACCEPTED", "REJECTED", "IGNORED", "ERROR"
 * @param {string} logData.reason - Human-readable reason
 * @param {string} logData.raw_subject - Email subject
 * @param {string} logData.short_body_preview - First 200 chars of body
 * @param {string} logData.full_email_data - Full email data (optional, for debugging)
 */
async function logPayment(logData) {
  try {
    const {
      email_uid = null,
      parser_pay_type = null,
      parser_amount = null,
      parser_request_status = null,
      parser_is_expired = null,
      extracted_code = null,
      matched_topup_id = null,
      decision,
      reason = null,
      raw_subject = null,
      short_body_preview = null,
      full_email_data = null,
    } = logData;

    if (!decision) {
      console.error("Payment log missing required 'decision' field");
      return;
    }

    await db.prepare(`
      INSERT INTO payment_logs (
        email_uid,
        parser_pay_type,
        parser_amount,
        parser_request_status,
        parser_is_expired,
        extracted_code,
        matched_topup_id,
        decision,
        reason,
        raw_subject,
        short_body_preview,
        full_email_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      email_uid,
      parser_pay_type,
      parser_amount,
      parser_request_status,
      parser_is_expired === true ? 1 : (parser_is_expired === false ? 0 : null),
      extracted_code,
      matched_topup_id,
      decision,
      reason,
      raw_subject,
      short_body_preview ? short_body_preview.substring(0, 200) : null,
      full_email_data
    );
  } catch (e) {
    // Handle unique constraint violation (idempotency - email_uid already logged)
    if (e.message && e.message.includes("UNIQUE constraint") && e.message.includes("email_uid")) {
      console.log(`⚠️  Payment log skipped (duplicate email_uid: ${logData.email_uid})`);
      return; // Silently skip duplicate logs
    }
    console.error("Failed to write payment log:", e);
    // Don't throw - logging failures shouldn't break the system
  }
}

/**
 * Get payment logs with filters
 * @param {Object} filters - Filter options
 * @param {string} filters.code - Filter by extracted code
 * @param {string} filters.decision - Filter by decision
 * @param {string} filters.startDate - Start date (ISO string)
 * @param {string} filters.endDate - End date (ISO string)
 * @param {number} filters.limit - Limit results (default 500)
 * @param {number} filters.offset - Offset for pagination
 */
async function getPaymentLogs(filters = {}) {
  const {
    code = null,
    decision = null,
    startDate = null,
    endDate = null,
    limit = 500,
    offset = 0,
  } = filters;

  let query = `
    SELECT 
      pl.*,
      u.username,
      t.code as topup_code
    FROM payment_logs pl
    LEFT JOIN topups t ON pl.matched_topup_id = t.id
    LEFT JOIN users u ON t.userId = u.id
    WHERE 1=1
  `;
  const params = [];

  if (code) {
    query += " AND pl.extracted_code = ?";
    params.push(code);
  }

  if (decision) {
    query += " AND pl.decision = ?";
    params.push(decision);
  }

  if (startDate) {
    query += " AND pl.timestamp >= ?";
    params.push(startDate);
  }

  if (endDate) {
    query += " AND pl.timestamp <= ?";
    params.push(endDate);
  }

  query += " ORDER BY pl.timestamp DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  return await db.prepare(query).all(...params);
}

/**
 * Get payment log by ID
 */
async function getPaymentLogById(id) {
  return await db.prepare(`
    SELECT 
      pl.*,
      u.username,
      t.code as topup_code
    FROM payment_logs pl
    LEFT JOIN topups t ON pl.matched_topup_id = t.id
    LEFT JOIN users u ON t.userId = u.id
    WHERE pl.id = ?
  `).get(id);
}

module.exports = {
  logPayment,
  getPaymentLogs,
  getPaymentLogById,
};

