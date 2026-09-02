import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM. The key never touches the database — only OAUTH_TOKEN_ENC_KEY
// (env, 32 raw bytes as base64) does, so a DB leak alone can't recover tokens.
// Stored ciphertext format: base64(iv[12] || authTag[16] || ciphertext) — one
// blob per token (see schema.sql platform_connections comment) rather than
// three separate columns that could drift out of sync with each other.
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const raw = process.env.OAUTH_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "OAUTH_TOKEN_ENC_KEY is not set — cannot store or read platform OAuth tokens without it. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`OAUTH_TOKEN_ENC_KEY must decode to exactly 32 bytes, got ${key.length}`);
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptToken(stored: string): string {
  const key = getKey();
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
