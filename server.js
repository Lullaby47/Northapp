

// --- Worker bridge (VeryRobusVersion) ---
async function startWorkerJob({ action, gameCode, username, amount, uid }) {
  const base = process.env.WORKER_URL || "http://127.0.0.1:9000";
  const url = base.replace(/\/$/, "") + "/api/jobs";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      game_code: gameCode,
      username,
      amount,
      uid
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `Worker request failed (${res.status})`;
    throw new Error(msg);
  }
  return data; // { ok, job_id, status }
}

// server.js (WALLET MODE: username+password + 12-word recovery phrase + QR support)
require("dotenv").config();

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const bip39 = require("bip39");
const QRCode = require("qrcode"); // ✅ local QR generator
const jsQR = require("jsqr");
const PNG = require("pngjs").PNG;

const db = require("./db");
const { requireAuth, requireAdmin, requireAnyRole } = require("./auth");
const multer = require("multer");
const fs = require("fs");
const { encrypt, decrypt } = require("./utils/cryptoSettings");

const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: "50kb" }));
app.use(cookieParser());

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  })
);

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ip=${req.ip}`);
  next();
});

// Frontend
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.get("/", async (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads", "payment-qrs");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer configuration for payment QR uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `qr-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error("Only image files (png, jpg, jpeg, webp) are allowed"));
    }
  },
});

// ---- helpers ----
function cookieSecure() {
  const v = String(process.env.COOKIE_SECURE ?? "true").toLowerCase();
  return v !== "false";
}

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function setAuthCookie(res, token) {
  res.cookie("auth", token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

function clearAuthCookie(res) {
  res.clearCookie("auth", { path: "/" });
}

function isStrongPassword(pw) {
  if (typeof pw !== "string") return false;
  if (pw.length < 6) return false;
  const hasCapital = /[A-Z]/.test(pw);
  const hasNumber = /[0-9]/.test(pw);
  return hasCapital && hasNumber;
}

function normalizePhrase(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function newRecoveryPhrase12() {
  return bip39.generateMnemonic(128);
}

// username base -> add random 2 digits
function normalizeUsernameBase(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
}
function random2Digits() {
  return String(Math.floor(Math.random() * 100)).padStart(2, "0");
}
async function generateUniqueUsername(base) {
  for (let i = 0; i < 50; i++) {
    const candidate = base + random2Digits();
    const exists = await db.prepare("SELECT id FROM users WHERE username = ?").get(candidate);
    if (!exists) return candidate;
  }
  return null;
}

// Game helpers
function generateSlug(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Generate game username: game short code + 3 letters from username + 3 random letters + 2 random numbers
// For "vb link" and "ultrapand", don't use underscores
function generateGameUsername(baseUsername, gameShortCode, gameName) {
  // Get 3 letters from username (take first 3, pad if needed)
  const usernameLetters = baseUsername.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 3);
  const paddedUsername = usernameLetters.padEnd(3, 'x'); // Pad with 'x' if less than 3 chars
  
  // Generate 3 random letters
  const randomLetters = Array.from({ length: 3 }, () => 
    String.fromCharCode(97 + Math.floor(Math.random() * 26)) // Random lowercase letter a-z
  ).join('');
  
  // Generate 2 random numbers (0-9)
  const randomNumbers = Array.from({ length: 2 }, () => 
    Math.floor(Math.random() * 10)
  ).join('');
  
  // Check if game name is "vb link" or "ultrapand" (case insensitive)
  const gameNameLower = (gameName || '').toLowerCase();
  const noUnderscore = gameNameLower === 'vb link' || gameNameLower === 'ultrapand';
  
  // Format: game short code + username part + random letters + random numbers
  // For no-underscore games, just concatenate; otherwise use underscore (but we're not using underscore in new format)
  const gameUsername = `${gameShortCode}${paddedUsername}${randomLetters}${randomNumbers}`;
  
  return gameUsername;
}

function generateShortCode(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0);
  return words.map(w => w[0].toUpperCase()).join("");
}

// ---- rate limits ----
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const recoverLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false });
const qrVerifyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// ---- in-memory brute-force lockout (single server) ----
const fails = new Map();
function nowMs() { return Date.now(); }
function getState(key) {
  const v = fails.get(key);
  if (!v) return null;
  if (v.untilMs && nowMs() > v.untilMs) { fails.delete(key); return null; }
  return v;
}
function hit(key, maxFails = 8, lockMin = 10) {
  const v = getState(key) || { count: 0, untilMs: 0 };
  v.count += 1;
  if (v.count >= maxFails) v.untilMs = nowMs() + lockMin * 60_000;
  fails.set(key, v);
}
function clear(key) { fails.delete(key); }

// ---------------- Routes ----------------

// ✅ QR image generator endpoint (returns PNG)
// Client calls /qr.png?data=<urlencoded>
app.get("/qr.png", async (req, res) => {
  try {
    const data = String(req.query?.data || "");
    if (!data || data.length > 2500) {
      return res.status(400).send("bad data");
    }

    const png = await QRCode.toBuffer(data, {
      errorCorrectionLevel: "H",
      margin: 2,
      width: 320,
      type: "png",
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.send(png);
  } catch (e) {
    return res.status(500).send("qr error");
  }
});

// ✅ QR verification endpoint (verifies QR is decodable)
// Client calls POST /qr-verify with { data: "<string>" }
app.post("/qr-verify", qrVerifyLimiter, async (req, res) => {
  try {
    const data = String(req.body?.data || "");
    
    // Validate input
    if (!data || data.length === 0) {
      return res.status(400).json({ ok: true, verified: false, reason: "Empty data" });
    }
    if (data.length > 2500) {
      return res.status(400).json({ ok: true, verified: false, reason: "Data too long" });
    }

    // Generate QR PNG (same settings as /qr.png)
    const pngBuffer = await QRCode.toBuffer(data, {
      errorCorrectionLevel: "H",
      margin: 2,
      width: 320,
      type: "png",
    });

    // Parse PNG to get pixel data
    const png = PNG.sync.read(pngBuffer);
    const imageData = {
      data: png.data,
      width: png.width,
      height: png.height,
    };

    // Decode QR code
    const decoded = jsQR(imageData.data, imageData.width, imageData.height);

    if (!decoded) {
      return res.json({ ok: true, verified: false, reason: "QR code could not be decoded" });
    }

    // Verify decoded text matches original data
    if (decoded.data === data) {
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ok: true, verified: true });
    } else {
      return res.json({ ok: true, verified: false, reason: "Decoded data does not match original" });
    }
  } catch (e) {
    console.error("QR verify error:", e);
    return res.status(500).json({ ok: false, verified: false, reason: "Server error during verification" });
  }
});

// REGISTER
app.post("/auth/register", registerLimiter, async (req, res) => {
  let base = normalizeUsernameBase(req.body?.username);
  const password = String(req.body?.password || "");

  if (!base || !password) return res.status(400).json({ error: "username and password are required" });
  if (base.length < 3) return res.status(400).json({ error: "username must be at least 3 characters" });
  if (!isStrongPassword(password)) return res.status(400).json({ error: "password must be at least 6 characters with at least one capital letter and one number" });

  const finalUsername = await generateUniqueUsername(base);
  if (!finalUsername) return res.status(500).json({ error: "Could not generate a unique username. Try again." });

  const phrase = newRecoveryPhrase12();
  const phraseNorm = normalizePhrase(phrase);

  const password_hash = await bcrypt.hash(password, 12);
  const recovery_phrase_hash = await bcrypt.hash(phraseNorm, 12);

  // Check if this is the first user (admin)
  const userCount = await db.prepare("SELECT COUNT(*) as count FROM users").get();
  const isFirstUser = userCount.count === 0;
  const role = isFirstUser ? "admin" : "user";

  const info = await db
    .prepare("INSERT INTO users (username, password_hash, recovery_phrase_hash, role) VALUES (?, ?, ?, ?)")
    .run(finalUsername, password_hash, recovery_phrase_hash, role);

  const user = { id: info.lastInsertRowid, username: finalUsername, role };
  
  // Automatically create game username entries for all existing games
  try {
    const games = await db.prepare("SELECT id, short_code, name FROM games").all();
    const insertUsername = db.prepare("INSERT INTO game_usernames (game_id, username, base_username) VALUES (?, ?, ?)");
    
    for (const game of games) {
      const fullUsername = generateGameUsername(finalUsername, game.short_code, game.name);
      try {
        await insertUsername.run(game.id, fullUsername, finalUsername);
      } catch (e) {
        // Ignore unique constraint errors (username might already exist)
        if (!e.message.includes("UNIQUE constraint")) {
          console.error(`Error creating game username for game ${game.id}:`, e);
        }
      }
    }
  } catch (e) {
    console.error("Error creating game usernames during registration:", e);
    // Don't fail registration if game username creation fails
  }
  
  setAuthCookie(res, signToken(user));

  return res.status(201).json({ ok: true, user, recovery_phrase: phrase });
});

// LOGIN
app.post("/auth/login", loginLimiter, async (req, res) => {
  const username = String(req.body?.identifier || req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!username || !password) return res.status(400).json({ error: "username and password are required" });

  const lockKey = `${req.ip}::login::${username.toLowerCase()}`;
  const state = getState(lockKey);
  if (state?.untilMs) {
    const secs = Math.ceil((state.untilMs - nowMs()) / 1000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${secs}s.` });
  }

  const user = await db.prepare("SELECT id, username, password_hash, role, is_banned FROM users WHERE username = ?").get(username);
  if (!user || !user.password_hash) { hit(lockKey); return res.status(401).json({ error: "invalid credentials" }); }

  // Check if banned
  if (user.is_banned) {
    hit(lockKey);
    return res.status(403).json({ error: "Account is banned" });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) { hit(lockKey); return res.status(401).json({ error: "invalid credentials" }); }

  clear(lockKey);
  setAuthCookie(res, signToken(user));
  return res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

// LOGOUT
app.post("/auth/logout", async (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ME
app.get("/auth/me", requireAuth, async (req, res) => {
  const user = await db.prepare("SELECT id, username, role, created_at, is_banned, balance_coins, recovery_phrase_hash FROM users WHERE id = ?").get(req.user.sub);
  if (!user) return res.status(404).json({ error: "user not found" });
  
  // Double-check banned status (should be caught by requireAuth, but extra safety)
  if (user.is_banned) {
    return res.status(403).json({ error: "Account is banned" });
  }
  
  res.json({ 
    user: { 
      id: user.id, 
      username: user.username, 
      role: user.role, 
      created_at: user.created_at,
      balanceCoins: user.balance_coins != null ? Number(user.balance_coins) : 0,
      recoveryPhraseSet: !!(user.recovery_phrase_hash && user.recovery_phrase_hash.trim() !== "")
    } 
  });
});

// RECOVER + RESET
app.post("/auth/recover-reset", recoverLimiter, async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const phraseInput = normalizePhrase(req.body?.recovery_phrase);
  const new_password = String(req.body?.new_password || "");

  if (!username || !phraseInput || !new_password) {
    return res.status(400).json({ error: "username, recovery_phrase, new_password are required" });
  }
  if (!isStrongPassword(new_password)) {
    return res.status(400).json({ error: "new_password must be at least 6 characters with at least one capital letter and one number" });
  }

  const lockKey = `${req.ip}::recover::${username.toLowerCase()}`;
  const state = getState(lockKey);
  if (state?.untilMs) {
    const secs = Math.ceil((state.untilMs - nowMs()) / 1000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${secs}s.` });
  }

  const user = await db.prepare("SELECT id, username, recovery_phrase_hash, is_banned FROM users WHERE username = ?").get(username);
  if (!user || !user.recovery_phrase_hash) { hit(lockKey); return res.status(400).json({ error: "invalid recovery" }); }

  // Check if banned
  if (user.is_banned) {
    hit(lockKey);
    return res.status(403).json({ error: "Account is banned" });
  }

  const ok = await bcrypt.compare(phraseInput, user.recovery_phrase_hash);
  if (!ok) { hit(lockKey); return res.status(400).json({ error: "invalid recovery" }); }

  clear(lockKey);

  const new_hash = await bcrypt.hash(new_password, 12);
  const newPhrase = newRecoveryPhrase12();
  const newPhraseHash = await bcrypt.hash(normalizePhrase(newPhrase), 12);

  await db.prepare("UPDATE users SET password_hash = ?, recovery_phrase_hash = ? WHERE id = ?")
    .run(new_hash, newPhraseHash, user.id);

  // Get updated user with role
  const updatedUser = await db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(user.id);
  setAuthCookie(res, signToken({ id: updatedUser.id, username: updatedUser.username, role: updatedUser.role }));

  return res.json({ ok: true, message: "Password updated. New recovery phrase generated (save it now).", recovery_phrase: newPhrase });
});

// ---------------- Admin Routes ----------------

// GET /admin/users - List all users (Admin/CoAdmin only)
app.get("/admin/users", requireAnyRole("admin", "coadmin"), async (req, res) => {
  const users = await db.prepare("SELECT id, username, role, is_banned, created_at, balance_coins FROM users ORDER BY id ASC").all();
  res.json({ users });
});

// POST /admin/promote - Promote user to coadmin
app.post("/admin/promote", requireAdmin, async (req, res) => {
  const targetUserId = Number(req.body?.user_id);
  const adminId = req.user.sub;

  if (!targetUserId || targetUserId === adminId) {
    return res.status(400).json({ error: "Invalid user or cannot promote yourself" });
  }

  const targetUser = await db.prepare("SELECT id, role FROM users WHERE id = ?").get(targetUserId);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  if (targetUser.role === "coadmin") {
    return res.status(400).json({ error: "User is already coadmin" });
  }

  await db.prepare("UPDATE users SET role = 'coadmin' WHERE id = ?").run(targetUserId);
  res.json({ ok: true, message: "User promoted to coadmin" });
});

// POST /admin/demote - Demote coadmin to user
app.post("/admin/demote", requireAdmin, async (req, res) => {
  const targetUserId = Number(req.body?.user_id);
  const adminId = req.user.sub;

  if (!targetUserId || targetUserId === adminId) {
    return res.status(400).json({ error: "Invalid user or cannot demote yourself" });
  }

  const targetUser = await db.prepare("SELECT id, role FROM users WHERE id = ?").get(targetUserId);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  if (targetUser.role !== "coadmin") {
    return res.status(400).json({ error: "User is not a coadmin" });
  }

  await db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(targetUserId);
  res.json({ ok: true, message: "Coadmin demoted to user" });
});

// POST /admin/ban - Ban a user
app.post("/admin/ban", requireAdmin, async (req, res) => {
  const targetUserId = Number(req.body?.user_id);
  const adminId = req.user.sub;

  if (!targetUserId || targetUserId === adminId) {
    return res.status(400).json({ error: "Invalid user or cannot ban yourself" });
  }

  const targetUser = await db.prepare("SELECT id, is_banned FROM users WHERE id = ?").get(targetUserId);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  if (targetUser.is_banned) {
    return res.status(400).json({ error: "User is already banned" });
  }

  await db.prepare("UPDATE users SET is_banned = 1 WHERE id = ?").run(targetUserId);
  res.json({ ok: true, message: "User banned" });
});

// POST /admin/unban - Unban a user
app.post("/admin/unban", requireAdmin, async (req, res) => {
  const targetUserId = Number(req.body?.user_id);
  const adminId = req.user.sub;

  if (!targetUserId || targetUserId === adminId) {
    return res.status(400).json({ error: "Invalid user or cannot unban yourself" });
  }

  const targetUser = await db.prepare("SELECT id, is_banned FROM users WHERE id = ?").get(targetUserId);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  if (!targetUser.is_banned) {
    return res.status(400).json({ error: "User is not banned" });
  }

  await db.prepare("UPDATE users SET is_banned = 0 WHERE id = ?").run(targetUserId);
  res.json({ ok: true, message: "User unbanned" });
});

// POST /admin/redeem - Redeem (decrease) user balance (Admin only)
app.post("/admin/redeem", requireAdmin, async (req, res) => {
  const targetUserId = Number(req.body?.user_id);
  const amount = Number(req.body?.amount);
  const adminId = req.user.sub;

  if (!targetUserId || !amount) {
    return res.status(400).json({ error: "Invalid user_id or amount" });
  }

  if (amount <= 0) {
    return res.status(400).json({ error: "Amount must be greater than 0" });
  }

  const targetUser = await db.prepare("SELECT id, username, balance_coins FROM users WHERE id = ?").get(targetUserId);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  const currentBalance = Number(targetUser.balance_coins || 0);
  const newBalance = Math.max(0, currentBalance - amount); // Prevent negative balance

  await db.prepare("UPDATE users SET balance_coins = ? WHERE id = ?").run(newBalance, targetUserId);
  
  res.json({ 
    ok: true, 
    message: `Redeemed ${amount} coins from ${targetUser.username}. New balance: ${newBalance}`,
    previousBalance: currentBalance,
    redeemedAmount: amount,
    newBalance: newBalance
  });
});

// POST /admin/recharge - Recharge (increase) user balance (Admin/CoAdmin only)
app.post("/admin/recharge", requireAnyRole("admin", "coadmin"), async (req, res) => {
  const targetUserId = Number(req.body?.user_id);
  const amount = Number(req.body?.amount);
  const requesterId = req.user.sub;

  if (!targetUserId || !amount) {
    return res.status(400).json({ error: "Invalid user_id or amount" });
  }

  if (amount <= 0) {
    return res.status(400).json({ error: "Amount must be greater than 0" });
  }

  // Get requester info (to check role and balance)
  const requester = await db.prepare("SELECT id, username, role, balance_coins FROM users WHERE id = ?").get(requesterId);
  if (!requester) {
    return res.status(404).json({ error: "Requester not found" });
  }

  const isAdmin = requester.id === 1 || requester.role === "admin";
  const isCoAdmin = requester.role === "coadmin";

  if (!isAdmin && !isCoAdmin) {
    return res.status(403).json({ error: "Admin or CoAdmin access required" });
  }

  // Get target user
  const targetUser = await db.prepare("SELECT id, username, balance_coins FROM users WHERE id = ?").get(targetUserId);
  if (!targetUser) {
    return res.status(404).json({ error: "Target user not found" });
  }

  // For CoAdmin: check balance and deduct
  if (isCoAdmin && !isAdmin) {
    const requesterBalance = Number(requester.balance_coins || 0);
    if (amount > requesterBalance) {
      return res.status(400).json({ 
        error: `Insufficient balance. You have ${requesterBalance} coins, cannot recharge ${amount} coins. Please recharge your own account first using the TopUp panel.`,
        insufficientBalance: true,
        currentBalance: requesterBalance,
        requiredAmount: amount
      });
    }

    // Transaction: deduct from requester, add to target
    try {
      await db.transaction(async () => {
        // Deduct from coadmin balance
        const newRequesterBalance = requesterBalance - amount;
        await db.prepare("UPDATE users SET balance_coins = ? WHERE id = ?").run(newRequesterBalance, requesterId);
        
        // Add to target user balance
        const targetBalance = Number(targetUser.balance_coins || 0);
        const newTargetBalance = targetBalance + amount;
        await db.prepare("UPDATE users SET balance_coins = ? WHERE id = ?").run(newTargetBalance, targetUserId);
      })();
      
      res.json({ 
        ok: true, 
        message: `Recharged ${amount} coins to ${targetUser.username}. Your balance: ${requesterBalance - amount} coins.`,
        requesterNewBalance: requesterBalance - amount,
        targetNewBalance: Number(targetUser.balance_coins || 0) + amount
      });
    } catch (e) {
      return res.status(500).json({ error: `Failed to recharge: ${e.message}` });
    }
  } else {
    // For Admin: no balance check, just add to target
    try {
      const targetBalance = Number(targetUser.balance_coins || 0);
      const newTargetBalance = targetBalance + amount;
      await db.prepare("UPDATE users SET balance_coins = ? WHERE id = ?").run(newTargetBalance, targetUserId);
      
      res.json({ 
        ok: true, 
        message: `Recharged ${amount} coins to ${targetUser.username}. New balance: ${newTargetBalance} coins.`,
        targetNewBalance: newTargetBalance
      });
    } catch (e) {
      return res.status(500).json({ error: `Failed to recharge: ${e.message}` });
    }
  }
});

// POST /admin/delete-user - Delete a user (Admin only)
app.post("/admin/delete-user", requireAdmin, async (req, res) => {
  const targetUserId = Number(req.body?.user_id);
  const adminId = req.user.sub;

  if (!targetUserId) {
    return res.status(400).json({ error: "Invalid user_id" });
  }

  if (targetUserId === adminId) {
    return res.status(400).json({ error: "Cannot delete yourself" });
  }

  const targetUser = await db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(targetUserId);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  // Prevent deleting admin users
  if (targetUser.role === "admin") {
    return res.status(400).json({ error: "Cannot delete admin users" });
  }

  // Delete user and all associated data
  await db.transaction(async () => {
    // Delete user's topups
    await db.prepare("DELETE FROM topups WHERE userId = ?").run(targetUserId);
    // Delete user's game usernames
    await db.prepare("DELETE FROM game_usernames WHERE userId = ?").run(targetUserId);
    // Delete user's payment logs (if any reference exists)
    // Note: payment_logs might reference topups, but we're deleting topups first
    // Delete the user
    await db.prepare("DELETE FROM users WHERE id = ?").run(targetUserId);
  })();
  
  res.json({ 
    ok: true, 
    message: `User "${targetUser.username}" deleted successfully`
  });
});

// ---------------- Game Routes ----------------

// GET /games - List all games (all authenticated users for Play view, admin for management)
app.get("/games", requireAuth, async (req, res) => {
  const games = await db.prepare("SELECT id, name, slug, short_code, created_at FROM games ORDER BY name ASC").all();
  res.json({ games });
});

// POST /games - Add a new game (admin only)
app.post("/games", requireAdmin, async (req, res) => {
  const name = String(req.body?.name || "").trim();

  if (!name || name.length < 3) {
    return res.status(400).json({ error: "Game name must be at least 3 characters" });
  }

  const slug = generateSlug(name);
  const shortCode = generateShortCode(name);

  if (!slug || slug.length === 0) {
    return res.status(400).json({ error: "Invalid game name" });
  }

  try {
    const info = await db
      .prepare("INSERT INTO games (name, slug, short_code) VALUES (?, ?, ?)")
      .run(name, slug, shortCode);
    
    const gameId = info.lastInsertRowid;
    
    // Automatically create game username entries for all existing users
    try {
      const users = await db.prepare("SELECT id, username FROM users").all();
      const insertUsername = db.prepare("INSERT INTO game_usernames (game_id, username, base_username) VALUES (?, ?, ?)");
      
      for (const user of users) {
        const fullUsername = generateGameUsername(user.username, shortCode, name);
        try {
          await insertUsername.run(gameId, fullUsername, user.username);
        } catch (e) {
          // Ignore unique constraint errors (username might already exist)
          if (!e.message.includes("UNIQUE constraint")) {
            console.error(`Error creating game username for user ${user.id}:`, e);
          }
        }
      }
    } catch (e) {
      console.error("Error creating game usernames for existing users:", e);
      // Don't fail game creation if username creation fails
    }
    
    res.json({ ok: true, game: { id: gameId, name, slug, short_code: shortCode } });
  } catch (e) {
    if (e.message.includes("UNIQUE constraint")) {
      return res.status(400).json({ error: "Game name already exists" });
    }
    return res.status(500).json({ error: "Failed to create game" });
  }
});

// DELETE /games/:id - Delete a game (admin only)
app.delete("/games/:id", requireAdmin, async (req, res) => {
  const gameId = Number(req.params.id);

  if (!gameId) {
    return res.status(400).json({ error: "Invalid game ID" });
  }

  const game = await db.prepare("SELECT id FROM games WHERE id = ?").get(gameId);
  if (!game) {
    return res.status(404).json({ error: "Game not found" });
  }

  await db.prepare("DELETE FROM games WHERE id = ?").run(gameId);
  res.json({ ok: true, message: "Game deleted" });
});

// ---------------- Game Username Routes ----------------

// GET /game-usernames - List game usernames for the current user, grouped by game
app.get("/game-usernames", requireAuth, async (req, res) => {
  const currentUsername = req.user.username;
  
  const usernames = db
    .prepare(`
      SELECT 
        gu.id,
        gu.username,
        gu.base_username,
        gu.created_at,
        g.id as game_id,
        g.name as game_name,
        g.short_code
      FROM game_usernames gu
      INNER JOIN games g ON gu.game_id = g.id
      WHERE gu.base_username = ?
      ORDER BY g.name ASC, gu.username ASC
    `)
    .all(currentUsername);

  // Group by game
  const grouped = {};
  usernames.forEach(u => {
    const key = u.game_id;
    if (!grouped[key]) {
      grouped[key] = {
        game_id: u.game_id,
        game_name: u.game_name,
        short_code: u.short_code,
        usernames: []
      };
    }
    grouped[key].usernames.push({
      id: u.id,
      username: u.username,
      base_username: u.base_username,
      created_at: u.created_at
    });
  });

  res.json({ games: Object.values(grouped) });
});

// POST /game-usernames - Add a game username (admin only)
app.post("/game-usernames", requireAdmin, async (req, res) => {
  const gameId = Number(req.body?.game_id);
  const baseUsername = String(req.body?.base_username || "").trim();

  if (!gameId) {
    return res.status(400).json({ error: "game_id is required" });
  }

  if (!baseUsername || baseUsername.length < 3) {
    return res.status(400).json({ error: "base_username must be at least 3 characters" });
  }

  // Validate base_username: letters, numbers, underscore only
  if (!/^[a-zA-Z0-9_]+$/.test(baseUsername)) {
    return res.status(400).json({ error: "base_username can only contain letters, numbers, and underscores" });
  }

  const game = await db.prepare("SELECT id, short_code FROM games WHERE id = ?").get(gameId);
  if (!game) {
    return res.status(404).json({ error: "Game not found" });
  }

  const fullUsername = `${baseUsername}_${game.short_code}`;

  try {
    const info = await db
      .prepare("INSERT INTO game_usernames (game_id, username, base_username) VALUES (?, ?, ?)")
      .run(gameId, fullUsername, baseUsername);
    
    res.json({ ok: true, username: { id: info.lastInsertRowid, username: fullUsername, base_username: baseUsername } });
  } catch (e) {
    if (e.message.includes("UNIQUE constraint")) {
      return res.status(400).json({ error: "Username already exists" });
    }
    return res.status(500).json({ error: "Failed to create username" });
  }
});

// DELETE /game-usernames/:id - Delete a game username (admin only)
app.delete("/game-usernames/:id", requireAdmin, async (req, res) => {
  const usernameId = Number(req.params.id);

  if (!usernameId) {
    return res.status(400).json({ error: "Invalid username ID" });
  }

  const username = await db.prepare("SELECT id FROM game_usernames WHERE id = ?").get(usernameId);
  if (!username) {
    return res.status(404).json({ error: "Username not found" });
  }

  await db.prepare("DELETE FROM game_usernames WHERE id = ?").run(usernameId);
  res.json({ ok: true, message: "Username deleted" });
});

// ---------------- Game Recharge Routes (All Users) ----------------

// POST /api/game-recharges - Create a game recharge
app.post("/api/game-recharges", requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const gameId = Number(req.body?.game_id);
  const gameUsername = String(req.body?.game_username || "").trim();
  const amount = Number(req.body?.amount);

  if (!gameId || !gameUsername || !amount) {
    return res.status(400).json({ error: "game_id, game_username, and amount are required" });
  }

  if (amount <= 0) {
    return res.status(400).json({ error: "Amount must be greater than 0" });
  }

  // Verify game exists
  const game = await db.prepare("SELECT id, name FROM games WHERE id = ?").get(gameId);
  if (!game) {
    return res.status(404).json({ error: "Game not found" });
  }

  // Verify user has the game username
  const username = await db.prepare(`
    SELECT id, username FROM game_usernames 
    WHERE game_id = ? AND username = ? AND base_username = (
      SELECT username FROM users WHERE id = ?
    )
  `).get(gameId, gameUsername, userId);

  if (!username) {
    return res.status(403).json({ error: "Game username not found or does not belong to you" });
  }

  // Get user balance
  const user = await db.prepare("SELECT id, username, balance_coins FROM users WHERE id = ?").get(userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const currentBalance = Number(user.balance_coins || 0);
  if (amount > currentBalance) {
    return res.status(400).json({ 
      error: "Insufficient balance",
      currentBalance,
      requiredAmount: amount
    });
  }

  // Transaction: deduct from user balance and create recharge record
  try {
    await db.transaction(async () => {
      // Deduct from user balance
      const newBalance = currentBalance - amount;
      await db.prepare("UPDATE users SET balance_coins = ? WHERE id = ?").run(newBalance, userId);

      // Create recharge record
      await db.prepare(`
        INSERT INTO game_recharges (user_id, game_id, game_username, amount)
        VALUES (?, ?, ?, ?)
      `).run(userId, gameId, gameUsername, amount);
    })();

    // Get the created recharge record
    const recharge = await db.prepare(`
      SELECT id, user_id, game_id, game_username, amount, created_at
      FROM game_recharges
      WHERE user_id = ? AND game_id = ? AND game_username = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(userId, gameId, gameUsername);

    // Start automation worker (best-effort). If worker is down, recharge is still recorded.
    let worker = null;
    try {
      const g = await db.prepare("SELECT short_code FROM games WHERE id = ?").get(gameId);
      worker = await startWorkerJob({
        action: "recharge",
        gameCode: g?.short_code || "",
        username: gameUsername,
        amount: String(amount),
        uid: `WEB_RECHARGE_${recharge?.id || Date.now()}`
      });
    } catch (e) {
      console.error("Worker start failed:", e?.message || e);
    }

    res.json({
      ok: true,
      message: `Successfully recharged ${amount} coins to ${game.name}`,
      recharge: {
        id: recharge.id,
        game_id: recharge.game_id,
        game_name: game.name,
        game_username: recharge.game_username,
        amount: recharge.amount,
        created_at: recharge.created_at
      },
      newBalance: currentBalance - amount
    });
  } catch (e) {
    console.error("Game recharge error:", e);
    return res.status(500).json({ error: `Failed to create game recharge: ${e.message}` });
  }
});


// ---------------- Game Redeem Routes (All Users) ----------------

// POST /api/game-redeems - Create a game redeem request (starts automation)
app.post("/api/game-redeems", requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const gameId = Number(req.body?.game_id);
  const gameUsername = String(req.body?.game_username || "").trim();
  const amount = Number(req.body?.amount);

  if (!gameId || !gameUsername || !amount) {
    return res.status(400).json({ error: "game_id, game_username, and amount are required" });
  }

  if (amount <= 0) {
    return res.status(400).json({ error: "Amount must be greater than 0" });
  }

  // Verify game exists
  const game = await db.prepare("SELECT id, name, short_code FROM games WHERE id = ?").get(gameId);
  if (!game) {
    return res.status(404).json({ error: "Game not found" });
  }

  // Verify user has the game username
  const username = await db.prepare(`
    SELECT id, username FROM game_usernames 
    WHERE game_id = ? AND username = ? AND base_username = (
      SELECT username FROM users WHERE id = ?
    )
  `).get(gameId, gameUsername, userId);

  if (!username) {
    return res.status(403).json({ error: "Game username not found or does not belong to you" });
  }

  try {
    await db.prepare(`
      INSERT INTO game_redeems (user_id, game_id, game_username, amount)
      VALUES (?, ?, ?, ?)
    `).run(userId, gameId, gameUsername, amount);

    const redeem = await db.prepare(`
      SELECT id, user_id, game_id, game_username, amount, created_at
      FROM game_redeems
      WHERE user_id = ? AND game_id = ? AND game_username = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(userId, gameId, gameUsername);

    // Start automation worker (best-effort)
    let worker = null;
    try {
      worker = await startWorkerJob({
        action: "redeem",
        gameCode: game.short_code || "",
        username: gameUsername,
        amount: String(amount),
        uid: `WEB_REDEEM_${redeem?.id || Date.now()}`
      });
    } catch (e) {
      console.error("Worker start failed:", e?.message || e);
    }

    res.json({
      ok: true,
      message: `Redeem request queued for ${game.name}`,
      redeem: {
        id: redeem.id,
        game_id: redeem.game_id,
        game_name: game.name,
        game_username: redeem.game_username,
        amount: redeem.amount,
        created_at: redeem.created_at
      },
      worker
    });
  } catch (e) {
    console.error("Game redeem error:", e);
    res.status(500).json({ error: "Server error" });
  }
});


// ---------------- Payment QRs Routes (Admin/Co-Admin only) ----------------

// GET /api/payment-qrs - List all payment QRs
app.get("/api/payment-qrs", requireAnyRole("admin", "coadmin"), (req, res) => {
  const qrs = db
    .prepare(`
      SELECT id, name, imageUrl, createdBy, createdAt 
      FROM payment_qrs 
      ORDER BY createdAt DESC
    `)
    .all();
  
  res.json({ qrs });
});

// POST /api/payment-qrs - Upload new payment QR
app.post("/api/payment-qrs", requireAnyRole("admin", "coadmin"), upload.single("image"), (req, res) => {
  const name = String(req.body?.name || "").trim();
  const file = req.file;

  if (!name || name.length < 1) {
    return res.status(400).json({ error: "Name is required" });
  }

  if (!file) {
    return res.status(400).json({ error: "Image file is required" });
  }

  const userId = req.user.sub;
  const imageUrl = `/uploads/payment-qrs/${file.filename}`;

  try {
    const info = db
      .prepare("INSERT INTO payment_qrs (name, imageUrl, createdBy) VALUES (?, ?, ?)")
      .run(name, imageUrl, userId);
    
    res.json({ 
      ok: true, 
      qr: { 
        id: info.lastInsertRowid, 
        name, 
        imageUrl, 
        createdBy: userId,
        createdAt: new Date().toISOString()
      } 
    });
  } catch (e) {
    // Clean up uploaded file on error
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
    return res.status(500).json({ error: "Failed to create payment QR" });
  }
});

// DELETE /api/payment-qrs/:id - Delete payment QR
app.delete("/api/payment-qrs/:id", requireAnyRole("admin", "coadmin"), async (req, res) => {
  const qrId = Number(req.params.id);

  if (!qrId) {
    return res.status(400).json({ error: "Invalid QR ID" });
  }

  const qr = await db.prepare("SELECT id, imageUrl FROM payment_qrs WHERE id = ?").get(qrId);
  if (!qr) {
    return res.status(404).json({ error: "Payment QR not found" });
  }

  // Delete the file
  if (qr.imageUrl && qr.imageUrl.startsWith("/uploads/")) {
    const filePath = path.join(__dirname, qr.imageUrl);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  await db.prepare("DELETE FROM payment_qrs WHERE id = ?").run(qrId);
  res.json({ ok: true, message: "Payment QR deleted" });
});

// ---------------- TopUp Routes (All authenticated users) ----------------

// Helper: Generate unique 4-word phrase code
function generateTopUpCode() {
  // Word parts for generating word-like strings
  const consonants = "bcdfghjklmnpqrstvwxyz";
  const vowels = "aeiou";
  
  function generateWord() {
    const length = 4 + Math.floor(Math.random() * 3); // 4-6 characters
    let word = "";
    for (let i = 0; i < length; i++) {
      if (i % 2 === 0) {
        // Even positions: consonants
        word += consonants[Math.floor(Math.random() * consonants.length)];
      } else {
        // Odd positions: vowels
        word += vowels[Math.floor(Math.random() * vowels.length)];
      }
    }
    return word;
  }
  
  // Generate 4 unique words
  const words = [];
  while (words.length < 4) {
    const word = generateWord();
    if (!words.includes(word)) {
      words.push(word);
    }
  }
  
  return words.join(" ");
}

// POST /api/topups - Create new topup
app.post("/api/topups", requireAuth, async (req, res) => {
  const userId = req.user.sub;

  // Get random payment QR
  const qrs = await db.prepare("SELECT id, name, imageUrl FROM payment_qrs").all();
  
  if (qrs.length === 0) {
    return res.status(400).json({ error: "No payment QR configured. Contact admin." });
  }

  const randomQr = qrs[Math.floor(Math.random() * qrs.length)];
  const qrId = randomQr.id;

  // Generate unique code (retry on collision)
  let code;
  let attempts = 0;
  do {
    code = generateTopUpCode();
    const existing = await db.prepare("SELECT id FROM topups WHERE code = ?").get(code);
    if (!existing) break;
    attempts++;
    if (attempts > 10) {
      return res.status(500).json({ error: "Failed to generate unique code" });
    }
  } while (true);

  // Calculate expiration (15 minutes from now)
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  // Get Gmail UIDNEXT to "arm" the poller for this topup
  let armedUidnext = null;
  try {
    const { getGmailUidNext } = require("./services/gmailPoller");
    const gmailAddress = (await db.prepare("SELECT value FROM app_settings WHERE key = 'gmail_address'").get())?.value;
    const gmailAppPasswordEncrypted = (await db.prepare("SELECT value FROM app_settings WHERE key = 'gmail_app_password'").get())?.value;
    
    if (gmailAddress && gmailAppPasswordEncrypted) {
      const gmailAppPassword = decrypt(gmailAppPasswordEncrypted);
      if (gmailAppPassword) {
        armedUidnext = await getGmailUidNext(gmailAddress, gmailAppPassword);
      }
    }
  } catch (e) {
    console.error("Failed to get Gmail UIDNEXT for topup:", e.message);
    // Continue without armed_uidnext - poller will use fallback
  }

  try {
    // Create topup without amount_coins (will be set from email when confirmed)
    const info = db
      .prepare("INSERT INTO topups (userId, code, qrId, status, expiresAt, armed_uidnext, amount_coins) VALUES (?, ?, ?, 'PENDING', ?, ?, NULL)")
      .run(userId, code, qrId, expiresAt, armedUidnext);
    
    // Generate phrase_topup_line for testing
    const phraseTopupLine = `TOPUP: ${code}`;
    
    res.json({
      ok: true,
      topup: {
        id: info.lastInsertRowid,
        code,
        phrase: code, // Alias for clarity
        phrase_topup_line: phraseTopupLine, // For testing email body
        expiresAt,
        amount_coins: null, // Will be set from email when payment is confirmed
        qr: {
          id: randomQr.id,
          name: randomQr.name,
          imageUrl: randomQr.imageUrl,
        },
      },
    });
  } catch (e) {
    console.error("Failed to create topup:", e);
    return res.status(500).json({ error: "Failed to create topup" });
  }
});

// GET /api/topups/:code - Get topup status
app.get("/api/topups/:code", requireAuth, async (req, res) => {
  const code = String(req.params.code || "").trim();
  const userId = req.user.sub;

  if (!code) {
    return res.status(400).json({ error: "Code is required" });
  }

  const topup = await db
    .prepare(`
      SELECT t.id, t.code, t.status, t.expiresAt, t.createdAt, t.amount_coins,
             q.id as qrId, q.name as qrName, q.imageUrl as qrImageUrl
      FROM topups t
      LEFT JOIN payment_qrs q ON t.qrId = q.id
      WHERE t.code = ? AND t.userId = ?
    `)
    .get(code, userId);

  if (!topup) {
    return res.status(404).json({ error: "Topup not found" });
  }

  // Check if expired
  const now = new Date();
  const expiresAt = new Date(topup.expiresAt);
  
  if (topup.status === "PENDING" && now > expiresAt) {
    // Update to expired
    await db.prepare("UPDATE topups SET status = 'EXPIRED' WHERE id = ?").run(topup.id);
    topup.status = "EXPIRED";
  }

  // Generate phrase_topup_line for testing
  const phraseTopupLine = `TOPUP: ${topup.code}`;
  
  res.json({
    ok: true,
    topup: {
      code: topup.code,
      phrase: topup.code, // Alias for clarity
      phrase_topup_line: phraseTopupLine, // For testing email body
      status: topup.status,
      expiresAt: topup.expiresAt,
      amountCoins: topup.amount_coins != null ? Number(topup.amount_coins) : 0,
      qr: topup.qrId ? {
        id: topup.qrId,
        name: topup.qrName,
        imageUrl: topup.qrImageUrl,
      } : null,
    },
  });
});

// ---------------- Payment Monitor Settings API (Admin/Co-Admin only) ----------------

// Helper: Get setting value
async function getSetting(key, defaultValue = null) {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  return row ? row.value : defaultValue;
}

// Helper: Set setting value
async function setSetting(key, value) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) 
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
  `).run(key, value, now, value, now);
}

// GET /api/admin/payment-monitor/settings
app.get("/api/admin/payment-monitor/settings", requireAnyRole("admin", "coadmin"), async (req, res) => {
  const gmailAddress = await getSetting("gmail_address", "");
  const gmailPollEnabled = await getSetting("gmail_poll_enabled", "0") === "1";
  const encryptedPassword = await getSetting("gmail_app_password", "");
  const lastCheckedAt = await getSetting("gmail_last_checked_at", null);
  const lastUid = await getSetting("gmail_last_uid", null);

  res.json({
    ok: true,
    settings: {
      gmailAddress,
      gmailPollEnabled,
      hasAppPassword: !!encryptedPassword,
      lastCheckedAt,
      lastUid,
    },
  });
});

// POST /api/admin/payment-monitor/settings
app.post("/api/admin/payment-monitor/settings", requireAnyRole("admin", "coadmin"), async (req, res) => {
  const gmailAddress = String(req.body?.gmailAddress || "").trim();
  const gmailAppPassword = String(req.body?.gmailAppPassword || "").trim();
  const gmailPollEnabled = req.body?.gmailPollEnabled === true || req.body?.gmailPollEnabled === "true";

  // If gmailAddress is empty, clear all Gmail settings
  if (!gmailAddress) {
    await setSetting("gmail_address", "");
    await setSetting("gmail_app_password", "");
    await setSetting("gmail_poll_enabled", "0");
    return res.json({ ok: true, message: "Gmail settings cleared" });
  }

  // Save Gmail address
  await setSetting("gmail_address", gmailAddress);

  // Save app password if provided (normalize by removing spaces)
  if (gmailAppPassword) {
    // Remove spaces from app password (common mistake: copying with spaces)
    const normalizedPassword = gmailAppPassword.replace(/\s+/g, "");
    const encrypted = encrypt(normalizedPassword);
    await setSetting("gmail_app_password", encrypted);
  }

  // Save poll enabled status
  await setSetting("gmail_poll_enabled", gmailPollEnabled ? "1" : "0");

  res.json({ ok: true, message: "Settings saved" });
});

// GET /api/admin/payment-logs - Get payment logs (Admin/Co-Admin only)
app.get("/api/admin/payment-logs", requireAnyRole("admin", "coadmin"), (req, res) => {
  const { getPaymentLogs } = require("./utils/paymentLogger");
  
  const code = req.query.code || null;
  const decision = req.query.decision || null;
  const startDate = req.query.startDate || null;
  const endDate = req.query.endDate || null;
  const limit = Math.min(Number(req.query.limit) || 500, 1000); // Max 1000
  const offset = Number(req.query.offset) || 0;

  const logs = getPaymentLogs({
    code,
    decision,
    startDate,
    endDate,
    limit,
    offset,
  });

  res.json({ ok: true, logs });
});

// GET /api/admin/payment-logs/:id - Get single payment log (Admin/Co-Admin only)
app.get("/api/admin/payment-logs/:id", requireAnyRole("admin", "coadmin"), (req, res) => {
  const { getPaymentLogById } = require("./utils/paymentLogger");
  
  const logId = Number(req.params.id);
  if (!logId) {
    return res.status(400).json({ error: "Invalid log ID" });
  }

  const log = getPaymentLogById(logId);
  if (!log) {
    return res.status(404).json({ error: "Log not found" });
  }

  res.json({ ok: true, log });
});

// POST /api/admin/payment-monitor/test
app.post("/api/admin/payment-monitor/test", requireAnyRole("admin", "coadmin"), async (req, res) => {
  // Use provided credentials or fall back to saved settings
  let gmailAddress = String(req.body?.gmailAddress || "").trim();
  let gmailAppPassword = String(req.body?.gmailAppPassword || "").trim();

  // If not provided in request, use saved settings
  if (!gmailAddress) {
    gmailAddress = await getSetting("gmail_address", "");
  }
  if (!gmailAppPassword) {
    const encryptedPassword = await getSetting("gmail_app_password", "");
    if (encryptedPassword) {
      gmailAppPassword = decrypt(encryptedPassword);
    }
  }

  if (!gmailAddress || !gmailAppPassword) {
    return res.status(400).json({ error: "Gmail address and app password are required for testing" });
  }

  try {
    // Test Gmail connection
    const { testGmailConnection } = require("./services/gmailPoller");
    const result = await testGmailConnection(gmailAddress, gmailAppPassword);
    
    if (result.success) {
      res.json({ ok: true, message: "Gmail connection successful" });
    } else {
      res.status(400).json({ error: result.error || "Gmail connection failed" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message || "Test failed" });
  }
});

// Start Gmail poller if enabled
let gmailPollerService = null;
async function startGmailPoller() {
  const gmailPollEnabled = await getSetting("gmail_poll_enabled", "0") === "1";
  const gmailAddress = await getSetting("gmail_address", "");
  const encryptedPassword = await getSetting("gmail_app_password", "");

  // Check if settings are present
  const canStart = gmailPollEnabled && gmailAddress && encryptedPassword;
  if (!canStart) {
    console.log("ℹ️  Gmail poller disabled (missing settings)");
    return;
  }

  // Decrypt password
  const gmailAppPassword = decrypt(encryptedPassword);
  if (!gmailAppPassword) {
    console.warn("⚠️  Gmail poller disabled: failed to decrypt password");
    return;
  }

  // Normalize password (remove spaces)
  const normalizedPassword = gmailAppPassword.replace(/\s+/g, "");

  try {
    const { startPoller } = require("./services/gmailPoller");
    gmailPollerService = await startPoller(db, gmailAddress, normalizedPassword);
    
    if (gmailPollerService) {
      console.log("✅ Gmail poller started successfully");
    } else {
      console.log("❌ Gmail poller failed to start (check credentials)");
    }
  } catch (e) {
    console.error("Failed to start Gmail poller:", e);
  }
}

// Start
const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // Start Gmail poller after server starts
  setTimeout(async () => {
    await startGmailPoller();
  }, 1000);
});
