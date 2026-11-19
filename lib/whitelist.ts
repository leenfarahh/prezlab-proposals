import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Two lists decide who can do what:
 *
 *  - Members (members.txt): everyone at Prezlab. They can sign in, browse the
 *    hub, open any proposal and copy client links.
 *  - Whitelist (HUB_WHITELIST): the people who can also upload, edit, share,
 *    retire links and delete. Whitelisted people are always members too.
 *
 * Both are checked locally on every request, with no database round trip. The
 * database can't read either, so lib/whitelist-sync.ts mirrors them into
 * team_whitelist for its access rules (RLS).
 *
 * No "server-only" import here on purpose: the proxy uses this, and the proxy
 * can't load server-only modules. Neither list ever reaches the browser.
 */

// ---------------------------------------------------------------------------
// Whitelist (editors), from the environment
// ---------------------------------------------------------------------------

export function whitelist(): string[] {
  return Array.from(new Set(extractEmails(process.env.HUB_WHITELIST ?? ""))).sort();
}

/** On HUB_WHITELIST: can upload, edit, share, retire and delete. */
export function isEditor(email: string | null | undefined): boolean {
  if (!email) return false;
  return whitelist().includes(email.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Members (everyone who can sign in), from members.txt
// ---------------------------------------------------------------------------

/** Everyone who can sign in: members.txt plus the whitelist. */
export function members(): string[] {
  return Array.from(new Set([...memberFile().emails, ...whitelist()])).sort();
}

/** Can sign in and view. */
export function isMember(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return memberFile().emails.has(e) || whitelist().includes(e);
}

/** Where the member list was read from, or null when no file was found. */
export function memberFilePath(): string | null {
  return memberFile().file;
}

/**
 * Locations checked, first match wins:
 *   HUB_MEMBERS_FILE        explicit path, if set
 *   ./members.txt           local development (gitignored)
 *   /etc/secrets/members.txt  Render "Secret File" named members.txt
 */
function candidatePaths(): string[] {
  const custom = process.env.HUB_MEMBERS_FILE?.trim();
  if (custom) return [path.resolve(custom)];
  return [path.join(process.cwd(), "members.txt"), "/etc/secrets/members.txt"];
}

// Kept on globalThis so every route bundle shares one copy. The file is
// re-checked every few seconds and re-read only when it changes, so edits
// apply without a restart.
const KEY = "__prezlabHubMembers" as const;
const RECHECK_MS = 5_000;
type MemberCache = { checkedAt: number; file: string | null; mtimeMs: number; emails: Set<string> };
type MemberGlobal = typeof globalThis & { [KEY]?: MemberCache };

function memberFile(): MemberCache {
  const g = globalThis as MemberGlobal;
  const now = Date.now();
  const cached = g[KEY];
  if (cached && now - cached.checkedAt < RECHECK_MS) return cached;

  for (const file of candidatePaths()) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (cached && cached.file === file && cached.mtimeMs === mtimeMs) {
      cached.checkedAt = now;
      return cached;
    }
    try {
      const next = { checkedAt: now, file, mtimeMs, emails: new Set(parseMemberFile(readFileSync(file, "utf8"))) };
      g[KEY] = next;
      return next;
    } catch (error) {
      console.error(`[members] could not read ${file}`, error);
      // Keep the last good list rather than locking everyone out.
      if (cached) return cached;
    }
  }

  const empty = { checkedAt: now, file: null, mtimeMs: 0, emails: new Set<string>() };
  g[KEY] = empty;
  return empty;
}

/**
 * One person per line. Anything that looks like an email is picked up and the
 * rest of the line is ignored, so a list pasted straight from an Odoo export
 * (CSV or copied from Excel) works as is. Lines starting with # are comments.
 */
export function parseMemberFile(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .flatMap(extractEmails);
}

const EMAIL = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

function extractEmails(text: string): string[] {
  return (text.match(EMAIL) ?? []).map((e) => e.toLowerCase());
}
