// Encrypted-at-rest store for the player's linked account.
//
// The game server only understands username/password, so "sign in with
// Google" on the client works by remembering the game credentials after a
// one-time link step and replaying them on later launches. They live under
// userData, AES-256-GCM encrypted with a per-install key file (mode 0600).
//
// Honest threat model: the key sits on the same disk as the data (Electron 8
// has no safeStorage), so this is the same protection tier as Chromium's
// "basic" password store on Linux — it stops casual file browsing and backup
// leakage, not malware running as the same user. Don't upgrade its claims
// without moving the key into an OS keyring.

const { app } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function storePath() {
  return path.join(app.getPath("userData"), "account-vault.bin");
}

function keyPath() {
  return path.join(app.getPath("userData"), "account-vault.key");
}

function getKey() {
  try {
    const existing = fs.readFileSync(keyPath());
    if (existing.length === 32) return existing;
  } catch (e) {}
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath(), key, { mode: 0o600 });
  return key;
}

function save(data) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  fs.writeFileSync(storePath(), Buffer.concat([iv, cipher.getAuthTag(), enc]), { mode: 0o600 });
}

// Returns the stored object, or null when absent/corrupt (treated as signed out).
function load() {
  try {
    const payload = fs.readFileSync(storePath());
    const decipher = crypto.createDecipheriv(ALGO, getKey(), payload.slice(0, IV_LEN));
    decipher.setAuthTag(payload.slice(IV_LEN, IV_LEN + TAG_LEN));
    const dec = Buffer.concat([decipher.update(payload.slice(IV_LEN + TAG_LEN)), decipher.final()]);
    return JSON.parse(dec.toString("utf8"));
  } catch (e) {
    return null;
  }
}

function clear() {
  try {
    fs.unlinkSync(storePath());
  } catch (e) {}
}

module.exports = { save, load, clear };
