// utils/cryptoSettings.js
// Encryption utility for app settings (Gmail app password, etc.)
const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 64;

function getEncryptionKey() {
  const key = process.env.SETTINGS_ENC_KEY;
  if (!key) {
    console.warn("⚠️  SETTINGS_ENC_KEY not set. Settings will be stored unencrypted.");
    return null;
  }
  // Derive a 32-byte key from the env var using SHA-256
  return crypto.createHash("sha256").update(key).digest();
}

function encrypt(text) {
  const key = getEncryptionKey();
  if (!key) {
    // No encryption key - return plaintext with prefix
    return `PLAIN:${text}`;
  }

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    
    const authTag = cipher.getAuthTag();
    
    // Combine: iv + authTag + encrypted
    return `ENC:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  } catch (e) {
    console.error("Encryption error:", e);
    return `PLAIN:${text}`;
  }
}

function decrypt(encryptedText) {
  if (!encryptedText || typeof encryptedText !== "string") {
    return null;
  }

  // Handle plaintext (no encryption key was set)
  if (encryptedText.startsWith("PLAIN:")) {
    return encryptedText.slice(6);
  }

  // Handle encrypted
  if (!encryptedText.startsWith("ENC:")) {
    // Legacy: assume plaintext
    return encryptedText;
  }

  const key = getEncryptionKey();
  if (!key) {
    console.warn("Cannot decrypt: SETTINGS_ENC_KEY not set");
    return null;
  }

  try {
    const parts = encryptedText.slice(4).split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid encrypted format");
    }

    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (e) {
    console.error("Decryption error:", e);
    return null;
  }
}

module.exports = { encrypt, decrypt };

