import "server-only";

import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { keyFromEnv, openWithKey, sealWithKey } from "@/lib/seal";

/**
 * Client access to password-protected proposals.
 *
 *  - Passwords are sealed with a key derived from HUB_SECRET, so the team can
 *    read them back (to resend to a client) but a database dump can't.
 *  - Entering the right password sets a signed cookie for that proposal only
 *    (path /prezlab/<link-name>/). It carries the proposal's password version, so
 *    changing the password logs out everyone who opened the old one.
 *  - Team members get a short-lived cookie of the same shape when they open a
 *    proposal. Pages are sandboxed for them, and a sandboxed page only sends
 *    SameSite=None cookies with its image and CSS requests (tested in Chrome),
 *    so their normal login cookie can't authorize those requests.
 */

export const ACCESS_COOKIE = "pz_access";
const CLIENT_DAYS = 30;
const TEAM_HOURS = 4;

function subkey(purpose: string): Buffer {
  return createHmac("sha256", keyFromEnv("HUB_SECRET")).update(purpose).digest();
}

export function hubSecretConfigured(): boolean {
  try {
    keyFromEnv("HUB_SECRET");
    return true;
  } catch {
    return false;
  }
}

// --- proposal passwords -----------------------------------------------------

export function sealPassword(password: string): string {
  return sealWithKey(subkey("proposal-password"), password);
}

export function openPassword(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  try {
    return openWithKey(subkey("proposal-password"), sealed);
  } catch {
    return null;
  }
}

/** Constant-time comparison that doesn't leak the length. */
export function passwordMatches(attempt: string, actual: string): boolean {
  const a = createHash("sha256").update(attempt).digest();
  const b = createHash("sha256").update(actual).digest();
  return timingSafeEqual(a, b);
}

// --- access cookies ---------------------------------------------------------

type Grant = { p: string; v: number; k: "c" | "t"; e: number };

function sign(body: string): string {
  return createHmac("sha256", subkey("access-cookie")).update(body).digest("base64url");
}

export function issueAccess(proposalId: string, passwordVersion: number, kind: "client" | "team") {
  const ttl = kind === "client" ? CLIENT_DAYS * 86400 : TEAM_HOURS * 3600;
  const grant: Grant = {
    p: proposalId,
    v: passwordVersion,
    k: kind === "client" ? "c" : "t",
    e: Math.floor(Date.now() / 1000) + ttl,
  };
  const body = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return { value: `${body}.${sign(body)}`, maxAge: ttl };
}

/** Which kind of access the cookie grants for this proposal, if any. */
export function readAccess(
  cookie: string | undefined,
  proposalId: string,
  passwordVersion: number,
): "client" | "team" | null {
  if (!cookie) return null;
  const [body, mac] = cookie.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const grant = JSON.parse(Buffer.from(body, "base64url").toString()) as Grant;
    if (grant.p !== proposalId || grant.e < Date.now() / 1000) return null;
    if (grant.k === "t") return "team";
    return grant.v === passwordVersion ? "client" : null;
  } catch {
    return null;
  }
}

/**
 * SameSite=None needs Secure. Browsers accept Secure cookies on https and on
 * http://localhost; anywhere else (a LAN IP in dev) falls back to Lax.
 */
export function cookieSecurity(url: URL): { secure: boolean; sameSite: "none" | "lax" } {
  const secure =
    url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return { secure, sameSite: secure ? "none" : "lax" };
}
