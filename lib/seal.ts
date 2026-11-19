import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/**
 * Authenticated encryption for secrets the hub must store and read back:
 * Odoo trusted-device keys (2FA bypass tokens) and proposal passwords.
 *
 * Postgres at-rest encryption protects the disk, not the row: anyone who can
 * read the table can read the value. Sealing here means a database dump is
 * useless without the key, which lives only in the server environment.
 *
 * AES-256-GCM, so tampering is detected rather than silently decrypted into
 * something else. Format is:  v<version>.<iv>.<authTag>.<ciphertext>  with each
 * part base64url. The version prefix makes a key rotation a migration rather
 * than an outage.
 */

const VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard

/** A 32-byte key from a base64 value, or derived from a passphrase of 32+ characters. */
export function keyFromEnv(name: string): Buffer {
  const raw = process.env[name]?.trim();
  if (!raw) {
    throw new Error(
      `${name} is not set. Generate one with: ` +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  if (raw.length >= 32) return createHash("sha256").update(raw).digest();
  throw new Error(`${name} must be a base64-encoded 32-byte key, or a passphrase of at least 32 characters.`);
}

export function sealWithKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [`v${VERSION}`, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Null on anything malformed, tampered with, or sealed under a different key. */
export function openWithKey(key: Buffer, sealed: string): string | null {
  try {
    const parts = sealed.split(".");
    if (parts.length !== 4) return null;
    const [version, ivPart, tagPart, dataPart] = parts;
    if (version !== `v${VERSION}`) return null;
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// --- Odoo trusted-device keys (ODOO_TD_ENCRYPTION_KEY) ----------------------

const ODOO_KEY = "ODOO_TD_ENCRYPTION_KEY";

/** True when a usable key is configured, so callers can degrade rather than throw. */
export function sealingAvailable(): boolean {
  try {
    keyFromEnv(ODOO_KEY);
    return true;
  } catch {
    return false;
  }
}

export function seal(plaintext: string): string {
  return sealWithKey(keyFromEnv(ODOO_KEY), plaintext);
}

/**
 * A trusted-device key that cannot be opened is not an error worth failing a
 * sign-in over; the caller just prompts for a code instead.
 */
export function open(sealed: string): string | null {
  try {
    return openWithKey(keyFromEnv(ODOO_KEY), sealed);
  } catch {
    return null;
  }
}

export const SEAL_VERSION = VERSION;
