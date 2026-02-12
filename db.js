// db.js (WALLET MODE + RECOVERY PHRASE + ROLE SYSTEM)
// Supports both SQLite (local) and PostgreSQL (Railway)

const fs = require("fs");
const path = require("path");

// Determine which database to use
const DATABASE_URL = process.env.DATABASE_URL;
const USE_POSTGRES = !!DATABASE_URL;

let db;

if (USE_POSTGRES) {
  // ============= PostgreSQL Setup =============
  const { Pool } = require("pg");
  
  console.log(`[DB] backend=postgres url set: true`);
  
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  // PostgreSQL wrapper to mimic better-sqlite3 API
  class PostgresDB {
    constructor(pool) {
      this.pool = pool;
      this._inTransaction = false;
      this._transactionClient = null;
    }

    async _query(sql, params = []) {
      const client = this._transactionClient || this.pool;
      return await client.query(sql, params);
    }

    prepare(sql) {
      // Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
      let paramIndex = 1;
      const pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
      
      return {
        run: async (...params) => {
          const result = await this._query(pgSql, params);
          return { 
            changes: result.rowCount,
            lastInsertRowid: result.rows[0]?.id || null
          };
        },
        get: async (...params) => {
          const result = await this._query(pgSql, params);
          return result.rows[0] || null;
        },
        all: async (...params) => {
          const result = await this._query(pgSql, params);
          return result.rows;
        }
      };
    }

    async exec(sql) {
      await this._query(sql, []);
    }

    transaction(fn) {
      return async () => {
        const client = await this.pool.connect();
        this._transactionClient = client;
        this._inTransaction = true;
        
        try {
          await client.query('BEGIN');
          const result = await fn();
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          this._transactionClient = null;
          this._inTransaction = false;
          client.release();
        }
      };
    }

    pragma() {
      // PostgreSQL doesn't use PRAGMA, ignore
      return null;
    }
  }

  db = new PostgresDB(pool);

  // Initialize PostgreSQL schema
  (async () => {
    try {
      // Users table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          recovery_phrase_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          is_banned INTEGER NOT NULL DEFAULT 0,
          balance_coins INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);`);

      // Games table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS games (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          slug TEXT NOT NULL UNIQUE,
          short_code TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_games_slug ON games(slug);`);

      // Game usernames table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS game_usernames (
          id SERIAL PRIMARY KEY,
          game_id INTEGER NOT NULL,
          username TEXT NOT NULL UNIQUE,
          base_username TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
        );
      `);
      
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_game_usernames_game_id ON game_usernames(game_id);`);

      // Payment QRs table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS payment_qrs (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          imageUrl TEXT NOT NULL,
          createdBy INTEGER NOT NULL,
          createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE CASCADE
        );
      `);
      
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_qrs_createdBy ON payment_qrs(createdBy);`);

      // Topups table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS topups (
          id SERIAL PRIMARY KEY,
          userId INTEGER NOT NULL,
          code TEXT NOT NULL UNIQUE,
          qrId INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING',
          expiresAt TIMESTAMP NOT NULL,
          amount_coins REAL DEFAULT NULL,
          armed_uidnext INTEGER DEFAULT NULL,
          createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (qrId) REFERENCES payment_qrs(id) ON DELETE SET NULL
        );
      `);
      
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_topups_userId ON topups(userId);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_topups_code ON topups(code);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_topups_status ON topups(status);`);

      // App settings table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Payment logs table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS payment_logs (
          id SERIAL PRIMARY KEY,
          timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
      
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_logs_code ON payment_logs(extracted_code);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_logs_decision ON payment_logs(decision);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_logs_timestamp ON payment_logs(timestamp);`);
      await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_logs_email_uid ON payment_logs(email_uid) WHERE email_uid IS NOT NULL;`);

      // Mail markers table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS mail_markers (
          uid TEXT PRIMARY KEY,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_markers_created ON mail_markers(created_at);`);

      // Game recharges table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS game_recharges (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          game_id INTEGER NOT NULL,
          game_username TEXT NOT NULL,
          amount INTEGER NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
        );
      `);
      
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_game_recharges_user_id ON game_recharges(user_id);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_game_recharges_game_id ON game_recharges(game_id);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_game_recharges_created_at ON game_recharges(created_at);`);

      // Game redeems table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS game_redeems (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          game_id INTEGER NOT NULL,
          game_username TEXT NOT NULL,
          amount INTEGER NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
        );
      `);
      
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_game_redeems_user_id ON game_redeems(user_id);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_game_redeems_game_id ON game_redeems(game_id);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_game_redeems_created_at ON game_redeems(created_at);`);

      console.log("[DB] PostgreSQL schema initialized");
    } catch (e) {
      console.error("[DB] PostgreSQL schema initialization error:", e);
      throw e;
    }
  })();

} else {
  // ============= SQLite Setup =============
  const Database = require("better-sqlite3");
  
  const dbPath = process.env.DB_PATH || "./app.db";
  const dbDir = path.dirname(dbPath);
  
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  
  console.log(`[DB] backend=sqlite path=${dbPath}`);
  
  const sqliteDb = new Database(dbPath);
  sqliteDb.pragma("journal_mode = WAL");
  sqliteDb.pragma("foreign_keys = ON");

  // SQLite wrapper to provide async API (matching PostgreSQL)
  class SQLiteDBWrapper {
    constructor(db) {
      this._db = db;
    }

    prepare(sql) {
      const stmt = this._db.prepare(sql);
      return {
        run: (...params) => Promise.resolve(stmt.run(...params)),
        get: (...params) => Promise.resolve(stmt.get(...params)),
        all: (...params) => Promise.resolve(stmt.all(...params))
      };
    }

    exec(sql) {
      return Promise.resolve(this._db.exec(sql));
    }

    transaction(fn) {
      return this._db.transaction(fn);
    }

    pragma(str) {
      return this._db.pragma(str);
    }
  }

  db = new SQLiteDBWrapper(sqliteDb);

  // Initialize SQLite schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      recovery_phrase_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      is_banned INTEGER NOT NULL DEFAULT 0,
      balance_coins INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      short_code TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  
  db.exec(`CREATE INDEX IF NOT EXISTS idx_games_slug ON games(slug);`);

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
  
  db.exec(`CREATE INDEX IF NOT EXISTS idx_game_usernames_game_id ON game_usernames(game_id);`);

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
  
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_qrs_createdBy ON payment_qrs(createdBy);`);

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
  
  db.exec(`CREATE INDEX IF NOT EXISTS idx_topups_userId ON topups(userId);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_topups_code ON topups(code);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_topups_status ON topups(status);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

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
  
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_logs_code ON payment_logs(extracted_code);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_logs_decision ON payment_logs(decision);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_logs_timestamp ON payment_logs(timestamp);`);

  try {
    const indexExists = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='index' AND name='idx_payment_logs_email_uid'
    `).get();
    
    if (!indexExists) {
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
        db.exec(`
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
      
      db.exec(`CREATE UNIQUE INDEX idx_payment_logs_email_uid ON payment_logs(email_uid);`);
      console.log("✅ Created unique index on payment_logs.email_uid");
    }
  } catch (e) {
    console.error("⚠️  Could not create unique index on payment_logs.email_uid:", e.message);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_markers (
      uid TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_markers_created ON mail_markers(created_at);`);

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
  
  db.exec(`CREATE INDEX IF NOT EXISTS idx_game_recharges_user_id ON game_recharges(user_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_game_recharges_game_id ON game_recharges(game_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_game_recharges_created_at ON game_recharges(created_at);`);

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
  
  db.exec(`CREATE INDEX IF NOT EXISTS idx_game_redeems_user_id ON game_redeems(user_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_game_redeems_game_id ON game_redeems(game_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_game_redeems_created_at ON game_redeems(created_at);`);
}

module.exports = db;
