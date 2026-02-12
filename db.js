// db.js (WALLET MODE + RECOVERY PHRASE + ROLE SYSTEM)
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

// Use DB_PATH env var if set, otherwise default to ./app.db
const dbPath = process.env.DB_PATH || "./app.db";

// Ensure parent directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log(`[DB] Using sqlite path: ${dbPath}`);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Users (NO email)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,

    -- Recovery phrase (store HASH only; never store plaintext)
    recovery_phrase_hash TEXT NOT NULL,

    -- Role system: admin, coadmin, user
    role TEXT NOT NULL DEFAULT 'user',
    
    -- Ban system
    is_banned INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
`);

// Games table
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    short_code TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_games_slug ON games(slug);
`);

// Game usernames table
db.exec(`
  CREATE TABLE IF NOT EXISTS game_usernames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    username TEXT NOT NULL UNIQUE,
    base_username TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_game_usernames_game_id ON game_usernames(game_id);
`);

// Payment QRs table
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_qrs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    imageUrl TEXT NOT NULL,
    createdBy INTEGER NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_payment_qrs_createdBy ON payment_qrs(createdBy);
`);

// Topups table
db.exec(`
  CREATE TABLE IF NOT EXISTS topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    code TEXT NOT NULL UNIQUE,
    qrId INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    expiresAt TEXT NOT NULL,
    amount_coins REAL DEFAULT NULL,
    armed_uidnext INTEGER DEFAULT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (qrId) REFERENCES payment_qrs(id) ON DELETE SET NULL
  );
`);

// Safe migration: add armed_uidnext column if it doesn't exist
try {
  const topupsTableInfo = db.prepare("PRAGMA table_info(topups)").all();
  const hasArmedUidnext = topupsTableInfo.some(col => col.name === 'armed_uidnext');
  
  if (!hasArmedUidnext) {
    db.exec(`ALTER TABLE topups ADD COLUMN armed_uidnext INTEGER DEFAULT NULL;`);
  }
} catch (e) {
  console.error("Topups armed_uidnext migration error:", e);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_topups_userId ON topups(userId);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_topups_code ON topups(code);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_topups_status ON topups(status);
`);

// App settings table for Gmail monitoring and other settings
db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Payment logs table for tracking all email parsing attempts
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    email_uid TEXT,
    parser_pay_type TEXT,
    parser_amount TEXT,
    parser_request_status TEXT,
    parser_is_expired INTEGER,
    extracted_code TEXT,
    matched_topup_id INTEGER,
    decision TEXT NOT NULL,
    reason TEXT,
    raw_subject TEXT,
    short_body_preview TEXT,
    full_email_data TEXT,
    FOREIGN KEY (matched_topup_id) REFERENCES topups(id) ON DELETE SET NULL
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_payment_logs_code ON payment_logs(extracted_code);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_payment_logs_decision ON payment_logs(decision);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_payment_logs_timestamp ON payment_logs(timestamp);
`);

// Unique index on email_uid to prevent double-crediting (idempotency)
// Note: SQLite unique indexes allow multiple NULL values, so NULL email_uid is fine
try {
  // Check if index already exists
  const indexExists = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='index' AND name='idx_payment_logs_email_uid'
  `).get();
  
  if (!indexExists) {
    // Check for duplicates (excluding NULL values)
    const duplicateCount = db.prepare(`
      SELECT COUNT(*) as count FROM (
        SELECT email_uid 
        FROM payment_logs 
        WHERE email_uid IS NOT NULL
        GROUP BY email_uid 
        HAVING COUNT(*) > 1
      )
    `).get();
    
    if (duplicateCount && duplicateCount.count > 0) {
      console.log(`⚠️  Found ${duplicateCount.count} duplicate email_uid values, cleaning up...`);
      
      // Remove duplicates before creating unique index
      // Keep the most recent log entry per email_uid (highest id = most recent)
      const deleteResult = db.exec(`
        DELETE FROM payment_logs
        WHERE id NOT IN (
          SELECT MAX(id) 
          FROM payment_logs 
          WHERE email_uid IS NOT NULL
          GROUP BY email_uid
        )
        AND email_uid IS NOT NULL
        AND email_uid IN (
          SELECT email_uid 
          FROM payment_logs 
          WHERE email_uid IS NOT NULL
          GROUP BY email_uid 
          HAVING COUNT(*) > 1
        );
      `);
      
      console.log(`✅ Cleaned up duplicate email_uid entries`);
    }
    
    // Now create the unique index (NULL values are allowed multiple times)
    db.exec(`
      CREATE UNIQUE INDEX idx_payment_logs_email_uid ON payment_logs(email_uid);
    `);
    console.log("✅ Created unique index on payment_logs.email_uid");
  }
} catch (e) {
  // If index creation fails, log but don't crash
  console.error("⚠️  Could not create unique index on payment_logs.email_uid:", e.message);
  console.error("   Duplicate email_uid values may exist. Consider cleaning the database manually.");
  // Don't throw - allow app to continue without unique index (idempotency check in code will still work)
}

// Mail markers table for deduplication
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_markers (
    uid TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_mail_markers_created ON mail_markers(created_at);
`);

// Safe migration: add role and is_banned columns if they don't exist
try {
  const tableInfo = db.prepare("PRAGMA table_info(users)").all();
  const hasRole = tableInfo.some(col => col.name === 'role');
  const hasBanned = tableInfo.some(col => col.name === 'is_banned');
  const hasBalanceCoins = tableInfo.some(col => col.name === 'balance_coins');
  
  if (!hasRole) {
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';`);
    // First user (id=1) becomes admin
    db.exec(`UPDATE users SET role = 'admin' WHERE id = 1;`);
  }
  
  if (!hasBanned) {
    db.exec(`ALTER TABLE users ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0;`);
  }
  
  if (!hasBalanceCoins) {
    db.exec(`ALTER TABLE users ADD COLUMN balance_coins INTEGER NOT NULL DEFAULT 0;`);
  }
} catch (e) {
  console.error("Users migration error:", e);
}

// Safe migration: add amount_coins to topups if it doesn't exist
try {
  const topupsTableInfo = db.prepare("PRAGMA table_info(topups)").all();
  const hasAmountCoins = topupsTableInfo.some(col => col.name === 'amount_coins');
  
  if (!hasAmountCoins) {
    db.exec(`ALTER TABLE topups ADD COLUMN amount_coins INTEGER NOT NULL DEFAULT 0;`);
  }
} catch (e) {
  console.error("Topups migration error:", e);
}

// Game recharges table
db.exec(`
  CREATE TABLE IF NOT EXISTS game_recharges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    game_username TEXT NOT NULL,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_game_recharges_user_id ON game_recharges(user_id);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_game_recharges_game_id ON game_recharges(game_id);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_game_recharges_created_at ON game_recharges(created_at);
`);


// Game redeems table
db.exec(`
  CREATE TABLE IF NOT EXISTS game_redeems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    game_username TEXT NOT NULL,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_game_redeems_user_id ON game_redeems(user_id);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_game_redeems_game_id ON game_redeems(game_id);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_game_redeems_created_at ON game_redeems(created_at);
`);

module.exports = db;
