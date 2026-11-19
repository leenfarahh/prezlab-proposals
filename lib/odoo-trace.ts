import "server-only";

/**
 * In-memory ring buffer for Odoo sign-in steps that went wrong.
 *
 * Sign-in drives Odoo's login *pages*, so a failure is usually "the markup is
 * not what we expected" — and that is impossible to diagnose from the outside,
 * because the designer sees only a generic message and the page itself is never
 * shown to us. This records the page's shape.
 *
 * What it deliberately does NOT record: any HTML body, any CSRF or trusted
 * device value, any password, any code, and no identifier for the designer. Only
 * the structure of what Odoo served — status, final path, which input fields
 * were present. That is enough to fix a parser and nothing more.
 *
 * Held on globalThis because Next bundles each route handler separately, so a
 * module-level array is written by one route and read as empty by another.
 */

export type OdooPageShape = {
  status: number;
  finalPath: string;
  bytes: number;
  looksLikeHtml: boolean;
  hasTotpField: boolean;
  mentionsCsrf: boolean;
  inputNames: string[];
  titleHint: string;
};

export type OdooTraceEntry = {
  at: string;
  step: "totp_page" | "totp_submit" | "trusted_device" | "session";
  outcome: string;
  page?: OdooPageShape;
  note?: string;
};

const MAX_ENTRIES = 20;
const KEY = "__prezlabProposalsOdooTrace" as const;

type TraceGlobal = typeof globalThis & { [KEY]?: OdooTraceEntry[] };

function buffer(): OdooTraceEntry[] {
  const g = globalThis as TraceGlobal;
  if (!g[KEY]) g[KEY] = [];
  return g[KEY];
}

export function traceOdoo(entry: OdooTraceEntry) {
  const entries = buffer();
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  // Also to the server log, so it is visible in the host logs without the endpoint.
  console.warn(
    `[odoo] ${entry.step} ${entry.outcome}`,
    entry.page ? JSON.stringify(entry.page) : (entry.note ?? ""),
  );
}

export function readOdooTrace(): OdooTraceEntry[] {
  return [...buffer()].reverse();
}
