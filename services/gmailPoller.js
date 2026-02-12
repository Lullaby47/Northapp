// services/gmailPoller.js
// Gmail polling service for payment confirmations
const { ImapFlow } = require("imapflow");
const { parseEmail } = require("./emailParser");
const { validatePayment, validateTopupStatus } = require("../utils/paymentValidator");
const { logPayment } = require("../utils/paymentLogger");
const { confirmTopupFromEmail } = require("../utils/topupConfirmer");

let pollerInterval = null;
let isPolling = false;
let pollerClient = null;
let pollLoopRunning = false;
let pollLoopStopFlag = false; // Flag to stop the polling loop

// Helper: Get setting value
function getSetting(db, key, defaultValue = null) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  return row ? row.value : defaultValue;
}

// Helper: Set setting value
function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) 
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}

// Helper: Get start UID (gmail_start_uid)
function getStartUid(db) {
  const startUid = getSetting(db, "gmail_start_uid", null);
  return startUid ? parseInt(startUid) : null;
}

// Helper: Set start UID
function setStartUid(db, uid) {
  setSetting(db, "gmail_start_uid", String(uid));
}

// Helper: Check if email UID marker exists (dedupe)
function markerExists(db, mailbox, uid) {
  const markerKey = `${mailbox}:${uid}`;
  try {
    const row = db.prepare("SELECT uid FROM mail_markers WHERE uid = ?").get(markerKey);
    return !!row;
  } catch (e) {
    // If table doesn't exist, create it and return false (not processed)
    if (e.message && e.message.includes("no such table: mail_markers")) {
      try {
        initMailMarkersTable(db);
        return false; // Table didn't exist, so marker doesn't exist
      } catch (initError) {
        return false; // Fail-safe: assume not processed
      }
    }
    throw e; // Re-throw other errors
  }
}

// Helper: Mark email UID as processed (dedupe)
function markProcessed(db, mailbox, uid) {
  const markerKey = `${mailbox}:${uid}`;
  try {
    db.prepare(`
      INSERT INTO mail_markers (uid, created_at) 
      VALUES (?, datetime('now'))
    `).run(markerKey);
    return true;
  } catch (e) {
    // Ignore duplicate key errors (race condition)
    if (e.message && e.message.includes("UNIQUE constraint")) {
      return false;
    }
    throw e;
  }
}

// Initialize mail_markers table (call on startup)
function initMailMarkersTable(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mail_markers (
        uid TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mail_markers_created ON mail_markers(created_at);
    `);
    console.log("✅ Mail markers table initialized");
  } catch (e) {
    console.error("❌ Failed to initialize mail_markers table:", e.message);
    throw e;
  }
}

// Note: Code extraction is now handled by paymentValidator.js

// Helper: Get Gmail UIDNEXT (used when creating topup to "arm" the poller)
async function getGmailUidNext(gmailAddress, gmailAppPassword) {
  let client = null;
  try {
    const normalizedPassword = gmailAppPassword.replace(/\s+/g, "");
    client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: {
        user: gmailAddress,
        pass: normalizedPassword,
      },
      logger: false,
    });

    await client.connect();
    const mailboxInfo = await client.mailboxOpen("INBOX");
    
    if (mailboxInfo && mailboxInfo.uidNext != null) {
      const uidNext = typeof mailboxInfo.uidNext === "number" 
        ? mailboxInfo.uidNext 
        : parseInt(String(mailboxInfo.uidNext || "0"));
      return isNaN(uidNext) ? null : uidNext;
    }
    return null;
  } catch (e) {
    console.error("Failed to get Gmail UIDNEXT:", e.message);
    return null;
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch {}
    }
  }
}

// Test Gmail connection
async function testGmailConnection(gmailAddress, gmailAppPassword) {
  let client = null;
  try {
    // Normalize app password (remove spaces if any)
    const originalLength = gmailAppPassword.length;
    const normalizedPassword = gmailAppPassword.replace(/\s+/g, "");
    const normalizedLength = normalizedPassword.length;
    const hadSpaces = originalLength !== normalizedLength;

    // Debug info (without exposing password)
    console.log("🔍 Gmail connection debug:");
    console.log(`   Email: ${gmailAddress}`);
    console.log(`   Password length: ${originalLength} chars`);
    if (hadSpaces) {
      console.log(`   ⚠️  Password contained spaces (removed ${originalLength - normalizedLength} spaces)`);
    }
    console.log(`   Normalized length: ${normalizedLength} chars`);
    console.log(`   Expected: 16 chars (Gmail app password)`);

    // Check for non-printable characters or encoding issues
    const hasNonPrintable = /[^\x20-\x7E]/.test(normalizedPassword);
    const hasSpecialChars = /[^a-zA-Z0-9]/.test(normalizedPassword);
    
    if (hasNonPrintable) {
      console.warn(`   ⚠️  Warning: Password contains non-printable characters`);
    }
    
    // Show first and last char (masked) for debugging
    if (normalizedLength > 0) {
      const firstChar = normalizedPassword[0];
      const lastChar = normalizedPassword[normalizedLength - 1];
      console.log(`   First char: "${firstChar}" (code: ${firstChar.charCodeAt(0)})`);
      console.log(`   Last char: "${lastChar}" (code: ${lastChar.charCodeAt(0)})`);
      console.log(`   Contains special chars: ${hasSpecialChars}`);
    }

    if (normalizedLength !== 16) {
      console.warn(`   ⚠️  Warning: App password should be exactly 16 characters`);
    }
    
    // Additional validation
    if (normalizedPassword.includes(" ") || normalizedPassword.includes("\t") || normalizedPassword.includes("\n")) {
      console.error(`   ❌ ERROR: Password still contains whitespace after normalization!`);
    }

    // Trim email address to ensure no leading/trailing spaces
    const trimmedEmail = gmailAddress.trim();
    if (trimmedEmail !== gmailAddress) {
      console.log(`   ⚠️  Email had leading/trailing spaces (trimmed)`);
    }

    client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: {
        user: trimmedEmail,
        pass: normalizedPassword,
      },
      logger: false, // Disable verbose logging (set to false to suppress imapflow logs)
    });

    await client.connect();
    await client.mailboxOpen("INBOX");
    
    console.log("✅ Gmail connection successful!");
    return { success: true };
  } catch (err) {
    // Enhanced error details
    const errorDetails = {
      message: err?.message,
      responseText: err?.responseText,
      serverResponseCode: err?.serverResponseCode,
      authenticationFailed: err?.authenticationFailed,
      executedCommand: err?.executedCommand,
    };
    
    let errorMsg = err?.message || "Connection failed";
    
    // Provide helpful error messages
    if (err?.authenticationFailed || err?.responseText?.includes("AUTHENTICATIONFAILED")) {
      errorMsg = "Authentication failed. Check:\n" +
        "1. 2-Step Verification is enabled for this Gmail account\n" +
        "2. App Password is correct (exactly 16 characters, no spaces)\n" +
        "3. IMAP is enabled in Gmail settings\n" +
        "4. You're using the App Password, not your regular Gmail password";
    } else if (err?.responseText?.includes("LOGIN")) {
      errorMsg = "Login failed. Invalid credentials.";
    } else if (err?.responseText?.includes("NO")) {
      errorMsg = "Gmail server error: " + (err?.responseText || err?.message);
    }
    
    return { 
      success: false, 
      error: errorMsg,
      details: errorDetails 
    };
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch {}
    }
  }
}

// Helper: Try to open mailbox with fallback and get UIDNEXT
async function openMailboxWithFallback(client, db) {
  const mailboxes = ["INBOX", "[Gmail]/All Mail", "[Google Mail]/All Mail", "All Mail"];
  
  for (const mailbox of mailboxes) {
    try {
      console.log(`📬 [MAILBOX] Trying to open: ${mailbox}`);
      const mailboxInfo = await client.mailboxOpen(mailbox);
      console.log(`📬 [MAILBOX] ✅ Successfully opened: ${mailbox}`);
      
      // Validate mailboxInfo structure
      if (!mailboxInfo || typeof mailboxInfo !== "object") {
        console.log(`📬 [MAILBOX] ⚠️  Invalid mailboxInfo structure, using defaults`);
        return { mailbox, mailboxInfo: { uidNext: null } };
      }
      
      // On first successful open, save UIDNEXT as start boundary if not set
      const currentStartUid = getStartUid(db);
      if (mailboxInfo && mailboxInfo.uidNext != null && currentStartUid === null) {
        const uidNextValue = mailboxInfo.uidNext;
        const uidNext = typeof uidNextValue === "number" 
          ? uidNextValue 
          : (typeof uidNextValue === "string" ? parseInt(uidNextValue) : parseInt(String(uidNextValue || "0")));
        if (!isNaN(uidNext) && uidNext > 0) {
          console.log(`📬 [MAILBOX] First open detected, saving UIDNEXT: ${uidNext} as start boundary`);
          setStartUid(db, uidNext);
        }
      }
      
      return { mailbox, mailboxInfo };
    } catch (e) {
      console.log(`📬 [MAILBOX] ❌ Failed to open ${mailbox}: ${e.message}`);
      continue;
    }
  }
  
  throw new Error("Could not open any mailbox");
}

// Process emails and update topups
async function processEmails(db, client) {
  let mailboxName = "INBOX";
  try {
    // Try to open mailbox with fallback
    const mailboxResult = await openMailboxWithFallback(client, db);
    if (!mailboxResult || !mailboxResult.mailbox) {
      throw new Error("Failed to open mailbox");
    }
    
    const { mailbox } = mailboxResult;
    mailboxName = mailbox;
    
    // Get min armed_uidnext from PENDING topups (poller is "armed" only when topup exists)
    const minArmedTopup = db
      .prepare(`
        SELECT MIN(armed_uidnext) as min_uidnext 
        FROM topups 
        WHERE status = 'PENDING' AND armed_uidnext IS NOT NULL
      `)
      .get();
    
    if (!minArmedTopup || minArmedTopup.min_uidnext === null) {
      // No armed topups, nothing to process
      setSetting(db, "gmail_last_checked_at", new Date().toISOString());
      return { processed: 0, found: 0, parsed: 0, confirmed: 0, rejected: 0, mailbox: mailboxName };
    }
    
    const startUid = minArmedTopup.min_uidnext;
    
    // Search emails from armed_uidnext onwards
    const searchUid = `${startUid}:*`;
    const debugMode = getSetting(db, "gmail_debug_mode", "0") === "1";
    const searchCriteria = debugMode 
      ? { uid: searchUid }
      : { unseen: true, uid: searchUid };
    
    // Search for emails
    const uids = await client.search(searchCriteria, { uid: true });
    
    if (!uids || uids.length === 0) {
      setSetting(db, "gmail_last_checked_at", new Date().toISOString());
      return { processed: 0, found: 0, parsed: 0, confirmed: 0, rejected: 0, mailbox: mailboxName };
    }

    let processedCount = 0;
    let parsedCount = 0;
    let confirmedCount = 0;
    let rejectedCount = 0;
    let highestProcessedUid = startUid - 1; // Track highest successfully processed UID

    for (let i = 0; i < uids.length; i++) {
      // uids[i] is already a UID number (e.g., 388101), not an object
      const uidNum = typeof uids[i] === "number" ? uids[i] : parseInt(String(uids[i]));
      
      // Validate UID
      if (isNaN(uidNum) || uidNum < startUid) {
        continue;
      }
      
      const uid = String(uidNum);
      console.log(`📧 Email received (UID: ${uid})`);
      
      // Check dedupe marker BEFORE processing
      if (markerExists(db, mailboxName, uid)) {
        console.log(`   → Already processed, ignored`);
        // Still advance highestProcessedUid if this was successfully processed before
        if (uidNum > highestProcessedUid) {
          highestProcessedUid = uidNum;
        }
        continue;
      }
      
      // Track if anything was saved for this email (for marker insertion)
      let savedAny = false;
      
      try {
        // Fetch email content - get full source for Python parser
        const message = await client.fetchOne(uid, {
          source: true,
          envelope: true,
        }, { uid: true });

        if (!message || !message.source) {
          console.log(`   → Could not fetch email source, ignored`);
          logPayment({
            email_uid: uid,
            decision: "IGNORED",
            reason: "Could not fetch email source",
            raw_subject: message?.envelope?.subject?.[0] || "Unknown",
          });
          savedAny = true;
          try {
            await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          } catch {}
          continue;
        }

        const emailSource = message.source ? String(message.source) : "";
        const envelope = message.envelope || {};
        const emailSubject = envelope.subject?.[0] || "";
        const emailFrom = envelope.from?.[0]?.address || envelope.from?.[0]?.name || "Unknown";
        const emailDate = envelope.date ? new Date(envelope.date).toISOString() : "Unknown";

        // Extract body text (for code extraction fallback)
        let bodyText = "";
        try {
          const bodyMatch = emailSource.match(/\r?\n\r?\n([\s\S]*)$/);
          if (bodyMatch) {
            bodyText = bodyMatch[1];
          } else {
            bodyText = emailSource;
          }
        } catch (e) {
          bodyText = emailSource;
        }

        // Call Python parser
        let parserData;
        try {
          parserData = await parseEmail(emailSource, emailSubject);
          parsedCount++;
          
          // Log parser amount and debug info
          const parserAmount = parserData.amount || "";
          const amountDebug = parserData.amount_debug || "";
          
          if (parserAmount) {
            console.log(`   → Parser amount: ${parserAmount}${amountDebug ? ` (debug: ${amountDebug})` : ""}`);
          } else {
            console.log(`   → Parser amount: empty/invalid${amountDebug ? ` (debug: ${amountDebug})` : ""}`);
          }
          
          // Validate parser amount
          if (!parserAmount || parserAmount.trim() === "") {
            console.log(`   → Invalid or empty parser amount, will reject`);
          } else {
            const amountNum = parseFloat(parserAmount);
            if (isNaN(amountNum) || amountNum <= 0) {
              console.log(`   → Parser amount is invalid (${parserAmount}), will reject`);
            }
          }
        } catch (e) {
          console.log(`   → Parser error: ${e.message}, ignored`);
          logPayment({
            email_uid: uid,
            decision: "ERROR",
            reason: `Python parser error: ${e.message}`,
            raw_subject: emailSubject,
            short_body_preview: bodyText.substring(0, 200),
            full_email_data: JSON.stringify({ error: e.message, stack: e.stack }),
          });
          rejectedCount++;
          savedAny = true;
          try {
            await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          } catch {}
          continue;
        }

        // Validate payment data (extracts passphrase from safe zones)
        const validation = validatePayment(parserData, bodyText, emailSubject, uid);
        
        if (!validation.valid) {
          console.log(`   → No condition found: ${validation.reason}, ignored`);
          rejectedCount++;
          savedAny = true;
          // Always mark as seen and insert marker even on rejection to avoid loops
          try {
            await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
            markProcessed(db, mailboxName, uid);
          } catch {}
          continue;
        }

        // Use strict confirmation handler with exact phrase matching
        const confirmation = confirmTopupFromEmail(
          {
            codeCandidate: validation.codeCandidate,
            code_source: validation.code_source,
            amountString: parserData.amount,
            email_uid: uid,
            subject: emailSubject,
            bodyPreview: bodyText.substring(0, 200),
            emailDate: emailDate,
          },
          db
        );

        if (confirmation.success) {
          console.log(`   → ✅ Confirmed: ${confirmation.coins} coins credited (code: ${confirmation.extracted_code || "N/A"})`);
          processedCount++;
          confirmedCount++;
          savedAny = true;
        } else {
          console.log(`   → Not confirmed: ${confirmation.reason}, ignored`);
          rejectedCount++;
          savedAny = true;
        }

        // Always mark as seen and insert marker even on rejection to avoid loops
        try {
          await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          markProcessed(db, mailboxName, uid);
        } catch {}
      } catch (e) {
        console.log(`   → Error processing: ${e.message}, ignored`);
        logPayment({
          email_uid: uid,
          decision: "ERROR",
          reason: `Email processing error: ${e.message}`,
          raw_subject: "Unknown",
          full_email_data: JSON.stringify({ error: e.message, stack: e.stack }),
        });
        savedAny = true;
      }
      
      // Only mark as processed and advance start UID if something was saved
      if (savedAny) {
        try {
          markProcessed(db, mailboxName, uid);
          // Advance highest processed UID
          if (uidNum > highestProcessedUid) {
            highestProcessedUid = uidNum;
          }
        } catch (e) {
          // Silent fail
        }
      }
    }

    // Update start UID only if we successfully processed emails
    // Advance to highestProcessedUid + 1 so next run starts after it
    if (highestProcessedUid >= startUid) {
      const newStartUid = highestProcessedUid + 1;
      setStartUid(db, newStartUid);
    }
    
    setSetting(db, "gmail_last_checked_at", new Date().toISOString());
    
    return { 
      processed: processedCount,
      found: uids.length,
      parsed: parsedCount,
      confirmed: confirmedCount,
      rejected: rejectedCount,
      mailbox: mailboxName,
      startUid: startUid,
      highestProcessedUid: highestProcessedUid,
    };
  } catch (e) {
    console.error(`📬 Error processing emails: ${e.message}`);
    // Log error but don't throw - allow retry
    logPayment({
      email_uid: null,
      decision: "ERROR",
      reason: `Batch processing error: ${e.message}`,
      full_email_data: JSON.stringify({ error: e.message, stack: e.stack }),
    });
    throw e;
  }
}

// Helper: Sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main polling loop with backoff retry
let backoffMs = 2000; // Start with 2 seconds

async function pollGmail(db, gmailAddress, gmailAppPassword) {
  if (isPolling) {
    return; // Skip if already polling
  }

  isPolling = true;
  let client = null;

  try {
    // Normalize app password (remove spaces if any)
    const normalizedPassword = gmailAppPassword.replace(/\s+/g, "");

    // Create IMAP client
    client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: {
        user: gmailAddress,
        pass: normalizedPassword,
      },
      logger: false, // Disable verbose logging
    });

    await client.connect();
    await processEmails(db, client);
    
    // Reset backoff on success
    backoffMs = 2000;
  } catch (err) {
    // Increase backoff on error (exponential backoff, max 60s)
    backoffMs = Math.min(backoffMs * 2, 60000);
  } finally {
    isPolling = false;
    if (client) {
      try {
        await client.logout();
      } catch (e) {
        // Silent fail
      }
    }
  }
}

// Polling loop wrapper with backoff (runs continuously)
async function pollLoop(db, gmailAddress, gmailAppPassword) {
  const POLL_INTERVAL = 20000; // 20 seconds normal interval
  
  console.log("📬 Listening for messages...");
  
  // Initial delay before first poll
  await sleep(2000);
  
  while (!pollLoopStopFlag) {
    try {
      await pollGmail(db, gmailAddress, gmailAppPassword);
      // Success - reset backoff and wait normal interval
      backoffMs = 2000;
      await sleep(POLL_INTERVAL);
    } catch (err) {
      // Error - wait with backoff
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60000); // Max 60s
    }
  }
  
  pollLoopRunning = false;
  console.log("📬 Stopped listening");
}

// Start poller with validation
async function startPoller(db, gmailAddress, gmailAppPassword) {
  // Stop existing poller if any
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }

  // Normalize app password (remove spaces)
  const normalizedPassword = gmailAppPassword.replace(/\s+/g, "");

  // Validate credentials before starting
  console.log("🔐 Testing Gmail credentials...");
  const testResult = await testGmailConnection(gmailAddress, normalizedPassword);
  
  if (!testResult.success) {
    console.error("❌ Gmail poller disabled (invalid credentials)");
    console.error("   Error:", testResult.error);
    if (testResult.details) {
      console.error("   Details:", testResult.details);
    }
    return null;
  }

  console.log("✅ Gmail credentials validated, starting poller...");

  // Initialize mail_markers table (ensure it exists before starting poller)
  try {
    initMailMarkersTable(db);
  } catch (e) {
    console.error("❌ Failed to initialize mail_markers table:", e.message);
    console.error("   Poller will continue, but dedupe may not work correctly");
  }

  // Reset backoff and flags on successful start
  backoffMs = 2000;
  pollLoopStopFlag = false;
  pollLoopRunning = true;

  // Start polling loop (runs continuously with backoff, non-blocking)
  pollLoop(db, gmailAddress, normalizedPassword).catch((err) => {
    console.error("Fatal poll loop error:", err);
    pollLoopRunning = false;
  });

  return {
    stop: () => {
      pollLoopStopFlag = true;
      pollLoopRunning = false;
      if (pollerInterval) {
        clearInterval(pollerInterval);
        pollerInterval = null;
      }
      if (pollerClient) {
        pollerClient.logout().catch(() => {});
        pollerClient = null;
      }
    },
  };
}

// Stop poller
function stopPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
  if (pollerClient) {
    pollerClient.logout().catch(() => {});
    pollerClient = null;
  }
}

module.exports = {
  startPoller,
  stopPoller,
  testGmailConnection,
  getGmailUidNext,
};

