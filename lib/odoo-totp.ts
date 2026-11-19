import "server-only";

import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { seal, open, sealingAvailable } from "@/lib/seal";
import { traceOdoo } from "@/lib/odoo-trace";

/**
 * Odoo sign-in that survives two-factor authentication.
 *
 * Background: Odoo blocks password-based RPC authentication outright for any
 * user with 2FA enabled, and `common.authenticate` has no second-factor
 * parameter. The only supported alternative is a per-user API key.
 *
 * This takes the other route already in use elsewhere at Prezlab: drive Odoo's
 * *browser* login endpoints, which do understand TOTP. That means this module
 * depends on pages rather than an API, so it can break on an Odoo upgrade in a
 * way a real API would not. Every request below is therefore defensive, and
 * every failure degrades to "ask for a code again" rather than locking a
 * team member out.
 *
 * Flow:
 *   1. POST /web/session/authenticate. A uid means no 2FA and we are done. No
 *      uid plus a session cookie means Odoo is waiting for a code.
 *   2. If a sealed trusted-device key exists for this login, GET
 *      /web/login/totp carrying it. Odoo finalises the session with no prompt.
 *      This bypass only works on that page, not on the RPC endpoint.
 *   3. Otherwise the caller collects a 6-digit code, and we GET the page to
 *      read its CSRF token, then POST the code with remember=1. Odoo returns a
 *      td_id cookie, which is sealed and stored for next time.
 *   4. Either way, finish by reading session info to get the uid and identity.
 *
 * The stored td_id is a 2FA bypass key. It is sealed with AES-256-GCM before it
 * touches the database, is never logged, and expires.
 */

const TIMEOUT_MS = 20_000;
const TRUSTED_DEVICE_DAYS = 30;

/** Odoo rejects requests to its login pages without a browser-shaped agent. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** The fields read back from res.users. Odoo returns false, not null, for empty. */
type OdooUserRecord = {
  login?: string;
  name?: string;
  email?: string | false;
  active?: boolean;
};

export type OdooIdentity = {
  uid: number;
  login: string;
  name: string;
  email: string;
};

export type OdooLoginOutcome =
  | { ok: true; user: OdooIdentity; usedTrustedDevice: boolean }
  /** Credentials were fine, but Odoo wants a code and we had no usable key. */
  | { ok: false; reason: "totp_required"; pendingSession: string }
  | { ok: false; reason: OdooLoginFailure; detail?: string };

export type OdooLoginFailure =
  | "invalid_credentials"
  | "invalid_totp"
  | "inactive_user"
  | "no_email"
  | "domain_not_allowed"
  | "odoo_unreachable"
  | "odoo_error"
  | "totp_unsupported";

// ---------------------------------------------------------------------------
// Cookie plumbing. Node's fetch has no cookie jar, so sessions are carried by
// hand — which is also what keeps this explicit about what is being sent where.
// ---------------------------------------------------------------------------

function parseSetCookie(response: Response, name: string): string | null {
  // getSetCookie() returns every Set-Cookie header separately, which matters:
  // a naive headers.get() joins them and corrupts values containing commas.
  const all =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];

  for (const line of all) {
    if (!line) continue;
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(line);
    if (match) return match[1];
  }
  return null;
}

function cookieHeader(parts: Record<string, string | null | undefined>): string {
  return Object.entries(parts)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

async function odooFetch(
  path: string,
  init: RequestInit & {
    cookies?: Record<string, string | null | undefined>;
    /**
     * Defaults to "manual". Fetching a page needs "follow", because Odoo
     * redirects to its login pages and a manual redirect yields an empty body —
     * which looks exactly like a page whose markup we cannot parse.
     */
    follow?: boolean;
  } = {},
): Promise<Response> {
  const { cookies, headers, follow, ...rest } = init;
  const url = `${env.odooUrl()}${path}`;
  return fetch(url, {
    ...rest,
    headers: {
      "User-Agent": BROWSER_UA,
      ...(cookies && Object.keys(cookies).length
        ? { Cookie: cookieHeader(cookies) }
        : {}),
      ...(headers as Record<string, string> | undefined),
    },
    redirect: follow ? "follow" : "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
}

// ---------------------------------------------------------------------------
// Trusted-device storage
// ---------------------------------------------------------------------------

async function readTrustedDevice(login: string): Promise<string | null> {
  if (!sealingAvailable()) return null;
  const { data } = await createAdminClient()
    .from("odoo_trusted_devices")
    .select("sealed_td_id, expires_at")
    .eq("odoo_login", login)
    .maybeSingle();

  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  // A key sealed under a rotated encryption key opens as null; that is a prompt,
  // not an error.
  return open(data.sealed_td_id);
}

async function storeTrustedDevice(login: string, tdId: string): Promise<void> {
  if (!sealingAvailable()) return;
  const expires = new Date(Date.now() + TRUSTED_DEVICE_DAYS * 86400_000);
  const { error } = await createAdminClient().from("odoo_trusted_devices").upsert(
    {
      odoo_login: login,
      sealed_td_id: seal(tdId),
      expires_at: expires.toISOString(),
      last_used_at: new Date().toISOString(),
      failed_at: null,
      failure_count: 0,
    },
    { onConflict: "odoo_login" },
  );
  if (error) console.error("[odoo-totp] could not store trusted device", error.message);
}

async function noteTrustedDeviceFailure(login: string): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("odoo_trusted_devices")
    .select("failure_count")
    .eq("odoo_login", login)
    .maybeSingle();
  if (!data) return;
  await admin
    .from("odoo_trusted_devices")
    .update({
      failed_at: new Date().toISOString(),
      failure_count: (data.failure_count ?? 0) + 1,
    })
    .eq("odoo_login", login);
}

async function touchTrustedDevice(login: string): Promise<void> {
  await createAdminClient()
    .from("odoo_trusted_devices")
    .update({ last_used_at: new Date().toISOString() })
    .eq("odoo_login", login);
}

/** Forgets a team member's trusted device, so their next sign-in asks for a code. */
export async function revokeTrustedDevice(login: string): Promise<void> {
  await createAdminClient()
    .from("odoo_trusted_devices")
    .delete()
    .eq("odoo_login", login.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type AuthenticateResult =
  | { kind: "authenticated"; sessionId: string; uid: number }
  | { kind: "totp_pending"; sessionId: string }
  | { kind: "rejected" }
  | { kind: "error"; detail: string };

/** Step 1: credentials. */
async function startSession(login: string, password: string): Promise<AuthenticateResult> {
  let response: Response;
  try {
    // Deliberately does NOT follow redirects, unlike the page fetches. The
    // session_id cookie is read from *this* response, and fetch does not expose
    // Set-Cookie from intermediate hops — following would silently lose it.
    response = await odooFetch("/web/session/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { db: env.odooDb(), login, password },
      }),
    });
  } catch (error) {
    return {
      kind: "error",
      detail:
        error instanceof Error && error.name === "TimeoutError"
          ? "Odoo did not respond in time."
          : "Could not reach Odoo.",
    };
  }

  const sessionId = parseSetCookie(response, "session_id");
  const bodyText = await response.text();

  let payload: {
    result?: { uid?: number | false | null };
    error?: { data?: { message?: string; name?: string }; message?: string };
  };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    // A redirect body, an HTML error page, or a proxy interstitial all land
    // here. Record the shape: guessing between them wasted a round already.
    traceOdoo({
      at: new Date().toISOString(),
      step: "session",
      outcome: `non_json_${response.status}`,
      page: describePage(response.status, response.url, bodyText),
      note: sessionId ? "a session cookie was set" : "no session cookie",
    });
    return { kind: "error", detail: "Odoo returned a non-JSON response to the login request." };
  }

  if (payload.error) {
    const message = payload.error.data?.message ?? payload.error.message ?? "";
    const errorName = payload.error.data?.name ?? "";

    // Odoo reports bad credentials as a fault here rather than a null uid.
    if (/access denied|wrong login|credential/i.test(message)) return { kind: "rejected" };

    // Some versions signal a pending second factor as a fault rather than a
    // null uid. If a session cookie came with it, treat it as the challenge it
    // is instead of a hard error.
    if (sessionId && /totp|two.?factor|2fa|mfa/i.test(`${errorName} ${message}`)) {
      return { kind: "totp_pending", sessionId };
    }

    traceOdoo({
      at: new Date().toISOString(),
      step: "session",
      outcome: "odoo_fault",
      note: `${errorName}: ${message}`.slice(0, 300),
    });
    return { kind: "error", detail: message.slice(0, 200) };
  }

  const uid = payload.result?.uid;
  if (typeof uid === "number" && uid > 0) {
    if (!sessionId) {
      traceOdoo({
        at: new Date().toISOString(),
        step: "session",
        outcome: "authenticated_without_cookie",
        note: "Odoo returned a uid but set no session_id cookie, so no page request can be made.",
      });
      return { kind: "error", detail: "Odoo authenticated but set no session cookie." };
    }
    return { kind: "authenticated", sessionId, uid };
  }

  // No uid and no cookie: record it, because "rejected" and "something else
  // entirely" look the same to the person signing in.
  if (!sessionId) {
    traceOdoo({
      at: new Date().toISOString(),
      step: "session",
      outcome: "no_uid_no_cookie",
      note: `result was ${JSON.stringify(payload.result ?? null).slice(0, 160)}`,
    });
  }

  // No uid. A session cookie alongside it is Odoo saying "now the second
  // factor"; no cookie at all means the credentials were simply wrong.
  if (sessionId) return { kind: "totp_pending", sessionId };
  return { kind: "rejected" };
}

/** Pulls the CSRF token out of the TOTP page's HTML. */
export function extractCsrf(html: string): string | null {
  // Odoo renders the token in several shapes across versions, and attribute
  // order is not guaranteed. Matching one exact spelling is how this broke the
  // first time, so try every plausible form rather than assuming.
  const patterns = [
    // <input name="csrf_token" value="..."> in either attribute order
    /name=["']csrf_token["'][^>]*?value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*?name=["']csrf_token["']/i,
    // odoo.csrf_token = "..."  /  csrf_token: "..."
    /csrf_token\s*[:=]\s*["']([^"']+)["']/i,
    // JSON blobs
    /["']csrf_token["']\s*:\s*["']([^"']+)["']/i,
    // data-csrf-token="..."
    /data-csrf(?:-token)?=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    // Odoo tokens are long hex-ish strings; a one-character match means the
    // pattern latched onto the wrong thing.
    if (match && match[1] && match[1].length >= 8) return match[1];
  }
  return null;
}

/**
 * What a login page looked like, for diagnosis. Deliberately records shape
 * rather than content: no token values, no HTML body, nothing anyone typed.
 */
function describePage(status: number, url: string, html: string) {
  const fields = [...html.matchAll(/<input[^>]*?name=["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, 12);
  return {
    status,
    finalPath: (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return url;
      }
    })(),
    bytes: html.length,
    looksLikeHtml: /<html|<!doctype/i.test(html),
    hasTotpField: /name=["']totp_token["']/i.test(html),
    mentionsCsrf: /csrf/i.test(html),
    inputNames: fields,
    titleHint: (/<title>([^<]{0,80})<\/title>/i.exec(html)?.[1] ?? "").trim(),
  };
}

/**
 * Step 2: try the stored trusted device. A GET to the TOTP page carrying td_id
 * finalises the session with no code. Returns true when Odoo accepted it.
 */
async function tryTrustedDevice(
  sessionId: string,
  tdId: string,
): Promise<OdooIdentity | null> {
  let response: Response;
  try {
    // Manual, not follow: finalising with a trusted device rotates the session
    // exactly as entering a code does, and a followed redirect would not expose
    // that Set-Cookie. Querying with the pre-rotation id returned "Odoo Session
    // Expired", which then looked like a rejected key.
    response = await odooFetch("/web/login/totp", {
      method: "GET",
      cookies: { session_id: sessionId, td_id: tdId },
    });
  } catch {
    return null;
  }

  const rotated = parseSetCookie(response, "session_id");
  const effectiveSession = rotated ?? sessionId;

  // A 2xx that still renders the code form means the key was not accepted.
  if (response.status >= 200 && response.status < 300) {
    const html = await response.text();
    if (/name=["']totp_token["']/i.test(html)) return null;
  }

  // Judge by whether the session resolves to a user, not by reading HTML. A
  // redirect to /web/login has no totp_token field either, so "the form is
  // gone" was a false positive.
  const identity = await readIdentity(effectiveSession);
  return identity.ok ? identity.identity : null;
}

/** Step 3: submit a code, and capture the trusted-device key Odoo returns. */
async function submitTotp(
  sessionId: string,
  code: string,
): Promise<
  | { ok: true; tdId: string | null; sessionId: string }
  | { ok: false; reason: OdooLoginFailure; detail?: string }
> {
  let page: Response;
  try {
    page = await odooFetch("/web/login/totp", {
      method: "GET",
      cookies: { session_id: sessionId },
      // Follow: Odoo redirects to its login pages, and a manual redirect would
      // hand us an empty body that looks like unparseable markup.
      follow: true,
    });
  } catch {
    return { ok: false, reason: "odoo_unreachable" };
  }

  const html = await page.text();

  // The GET can land on /web/login instead, when the session is not actually in
  // a two-factor pending state. That page carries its own csrf_token, and using
  // it posts a token the TOTP endpoint will reject — a confusing failure two
  // steps later. Insist on being on the right page first.
  if (!/name=["']totp_token["']/i.test(html)) {
    traceOdoo({
      at: new Date().toISOString(),
      step: "totp_page",
      outcome: "wrong_page",
      page: describePage(page.status, page.url, html),
      note: "no totp_token field, so this is not the two-factor page",
    });
    return {
      ok: false,
      reason: "totp_unsupported",
      detail: "Odoo did not serve its two-factor page for this session.",
    };
  }

  const csrf = extractCsrf(html);
  if (!csrf) {
    // Record the page's shape so this is diagnosable without another round of
    // guessing. No token values, no body, nothing the person typed.
    traceOdoo({
      at: new Date().toISOString(),
      step: "totp_page",
      outcome: "no_csrf_token",
      page: describePage(page.status, page.url, html),
    });
    // The page shape changed, or Odoo served something unexpected. Worth
    // naming distinctly: this is the failure mode of driving pages, not an API.
    return {
      ok: false,
      reason: "totp_unsupported",
      detail: "Could not find a CSRF token on Odoo's two-factor page.",
    };
  }

  traceOdoo({
    at: new Date().toISOString(),
    step: "totp_page",
    outcome: "csrf_found",
    page: describePage(page.status, page.url, html),
  });

  const body = new URLSearchParams({
    csrf_token: csrf,
    totp_token: code.replace(/\s+/g, ""),
    // Asks Odoo to issue the trusted-device cookie.
    remember: "1",
  });

  let submitted: Response;
  try {
    // Also deliberately manual: the td_id cookie is read from this exact
    // response, and the redirect itself is how success is recognised.
    submitted = await odooFetch("/web/login/totp", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      cookies: { session_id: sessionId },
      body: body.toString(),
    });
  } catch {
    return { ok: false, reason: "odoo_unreachable" };
  }

  const tdId = parseSetCookie(submitted, "td_id");

  // Odoo rotates the session on a successful second factor — standard defence
  // against session fixation. Carrying on with the pre-TOTP session id is why
  // get_session_info came back with no user: the old session was discarded the
  // moment the code was accepted.
  const rotatedSession = parseSetCookie(submitted, "session_id");
  const effectiveSession = rotatedSession ?? sessionId;

  if (rotatedSession && rotatedSession !== sessionId) {
    traceOdoo({
      at: new Date().toISOString(),
      step: "totp_submit",
      outcome: "session_rotated",
      note: "Odoo issued a new session_id after the code; using it from here.",
    });
  }

  // A redirect means accepted. A 200 that still renders the form means the code
  // was wrong.
  if (submitted.status >= 300 && submitted.status < 400) {
    return { ok: true, tdId, sessionId: effectiveSession };
  }

  const after = await submitted.text();
  // Quote-agnostic, like extractCsrf: Odoo's markup is not guaranteed to use
  // double quotes, and a missed match here would read a rejected code as
  // accepted.
  if (/name=["']totp_token["']/i.test(after)) {
    return { ok: false, reason: "invalid_totp" };
  }

  // Neither a redirect nor the form still showing. Ambiguous, so record the
  // shape rather than silently treating it as success.
  traceOdoo({
    at: new Date().toISOString(),
    step: "totp_submit",
    outcome: `unexpected_${submitted.status}`,
    page: describePage(submitted.status, submitted.url, after),
    note: tdId ? "a td_id cookie was returned" : "no td_id cookie returned",
  });
  return { ok: true, tdId, sessionId: effectiveSession };
}

/** Step 4: identity, from the now-complete web session. */
async function readIdentity(
  sessionId: string,
): Promise<{ ok: true; identity: OdooIdentity } | { ok: false; reason: OdooLoginFailure; detail?: string }> {
  let response: Response;
  try {
    response = await odooFetch("/web/session/get_session_info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cookies: { session_id: sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: {} }),
      // Follow, for the same reason as the login pages: a manual redirect hands
      // back an empty body, which then fails to parse as JSON and surfaces to
      // the person signing in as "Odoo rejected the sign-in request" — a message about
      // nothing at all.
      follow: true,
    });
  } catch {
    return { ok: false, reason: "odoo_unreachable" };
  }

  const bodyText = await response.text();
  let payload: {
    result?: { uid?: number | false; username?: string; name?: string; partner_id?: number };
    error?: { data?: { name?: string; message?: string }; message?: string };
  };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    traceOdoo({
      at: new Date().toISOString(),
      step: "session",
      outcome: `session_info_non_json_${response.status}`,
      page: describePage(response.status, response.url, bodyText),
    });
    return { ok: false, reason: "odoo_error", detail: "Session info was not JSON." };
  }

  const uid = payload.result?.uid;
  if (typeof uid !== "number" || uid <= 0) {
    // Log the fault as well as the result. Reporting only "result was null" hid
    // the actual reason for a round of debugging: an error response has no
    // result at all, so the two are indistinguishable without this.
    const fault = payload.error
      ? `error=${JSON.stringify(payload.error).slice(0, 260)}`
      : "no error key";
    traceOdoo({
      at: new Date().toISOString(),
      step: "session",
      outcome: "session_info_no_uid",
      note: `result=${JSON.stringify(payload.result ?? null).slice(0, 200)} ${fault}`,
    });
    return { ok: false, reason: "odoo_error", detail: "Session did not resolve to a user." };
  }

  // get_session_info carries the login but not reliably the email or active
  // flag, so read the user record over the authenticated session.
  let record: OdooUserRecord | null = null;
  try {
    const read = await odooFetch("/web/dataset/call_kw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cookies: { session_id: sessionId },
      follow: true,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: {
          model: "res.users",
          method: "read",
          args: [[uid], ["login", "name", "email", "active"]],
          kwargs: {},
        },
      }),
    });
    const readPayload = (await read.json()) as { result?: OdooUserRecord[] };
    record = readPayload.result?.[0] ?? null;
  } catch {
    // Fall through to the session-info values below.
  }

  const login = (record?.login ?? payload.result?.username ?? "").trim();
  const name = (record?.name ?? payload.result?.name ?? login).trim();
  const rawEmail = typeof record?.email === "string" ? record.email.trim() : "";
  const email = (rawEmail || (login.includes("@") ? login : "")).toLowerCase();

  if (record && record.active === false) {
    return { ok: false, reason: "inactive_user" };
  }
  if (!email) {
    return { ok: false, reason: "no_email" };
  }

  const allowedDomain = env.odooAllowedEmailDomain();
  if (allowedDomain && !email.endsWith(`@${allowedDomain}`)) {
    return { ok: false, reason: "domain_not_allowed" };
  }

  return { ok: true, identity: { uid, login: login || email, name: name || email, email } };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Signs a team member in, handling 2FA.
 *
 * Pass `totpCode` only when a previous call returned `totp_required`. Passing
 * `pendingSession` from that same call reuses Odoo's half-finished session, so
 * the password is not sent a second time.
 */
export async function loginToOdoo(input: {
  login: string;
  password?: string;
  totpCode?: string;
  pendingSession?: string;
}): Promise<OdooLoginOutcome> {
  const login = input.login.trim();
  const normalisedLogin = login.toLowerCase();

  if (!login) return { ok: false, reason: "invalid_credentials" };

  // --- resuming a 2FA challenge -------------------------------------------
  if (input.pendingSession && input.totpCode) {
    const submitted = await submitTotp(input.pendingSession, input.totpCode);
    if (!submitted.ok) return { ok: false, reason: submitted.reason, detail: submitted.detail };

    // Use the session Odoo issued *after* the code, not the one from before it.
    const identity = await readIdentity(submitted.sessionId);
    if (!identity.ok) return { ok: false, reason: identity.reason, detail: identity.detail };

    // Store the key only now that the sign-in has actually succeeded. Storing it
    // straight after the code left rows behind for people who never got in,
    // which made the trusted-device table lie about who had signed in.
    if (submitted.tdId) await storeTrustedDevice(normalisedLogin, submitted.tdId);

    return { ok: true, user: identity.identity, usedTrustedDevice: false };
  }

  // --- fresh attempt ------------------------------------------------------
  if (!input.password) return { ok: false, reason: "invalid_credentials" };

  const started = await startSession(login, input.password);

  if (started.kind === "rejected") return { ok: false, reason: "invalid_credentials" };
  if (started.kind === "error") {
    return {
      ok: false,
      reason: /reach|respond in time/i.test(started.detail) ? "odoo_unreachable" : "odoo_error",
      detail: started.detail,
    };
  }

  if (started.kind === "authenticated") {
    const identity = await readIdentity(started.sessionId);
    if (!identity.ok) return { ok: false, reason: identity.reason, detail: identity.detail };
    return { ok: true, user: identity.identity, usedTrustedDevice: false };
  }

  // --- 2FA pending --------------------------------------------------------
  const storedTdId = await readTrustedDevice(normalisedLogin);

  let pendingSession = started.sessionId;

  if (storedTdId) {
    const identity = await tryTrustedDevice(started.sessionId, storedTdId);
    if (identity) {
      await touchTrustedDevice(normalisedLogin);
      return { ok: true, user: identity, usedTrustedDevice: true };
    }

    // The attempt consumed the pending session — Odoo reports it expired — so a
    // code entered against it cannot work, and the code page would redirect to
    // /web/login. Start a clean session before prompting. The password is still
    // in hand here, which is why this happens now rather than being deferred.
    await revokeTrustedDevice(normalisedLogin);
    traceOdoo({
      at: new Date().toISOString(),
      step: "trusted_device",
      outcome: "not_accepted",
      note: "stored key did not finalise the session; discarded it and restarting for a code prompt",
    });

    const restarted = await startSession(login, input.password);

    if (restarted.kind === "authenticated") {
      // 2FA was turned off between the two calls. Unlikely, but cheap to honour.
      const identity = await readIdentity(restarted.sessionId);
      if (!identity.ok) return { ok: false, reason: identity.reason, detail: identity.detail };
      return { ok: true, user: identity.identity, usedTrustedDevice: false };
    }
    if (restarted.kind === "totp_pending") {
      pendingSession = restarted.sessionId;
    } else if (restarted.kind === "rejected") {
      return { ok: false, reason: "invalid_credentials" };
    } else {
      return { ok: false, reason: "odoo_error", detail: restarted.detail };
    }
  }

  // Hand the pending session back so the code step does not need the password.
  return { ok: false, reason: "totp_required", pendingSession };
}

/** Client-facing copy. Deliberately vague about which half of a credential failed. */
export function describeOdooLoginFailure(reason: OdooLoginFailure): string {
  switch (reason) {
    case "invalid_credentials":
      return "That Odoo login and password combination was not recognised.";
    case "invalid_totp":
      return "That authentication code was not accepted. Codes expire quickly, so try the current one.";
    case "inactive_user":
      return "This Odoo account is archived. Contact Operations to reactivate it.";
    case "no_email":
      return "Your Odoo account has no email address on it, which the Proposals Hub needs. Ask Operations to add one.";
    case "domain_not_allowed":
      return "This account is outside the domain approved for the Proposals Hub.";
    case "odoo_unreachable":
      return "Odoo is not responding right now. Try again in a moment.";
    case "totp_unsupported":
      return "The Proposals Hub could not complete Odoo's two-factor step. This usually means Odoo changed its login page; flag it to Operations.";
    case "odoo_error":
      return "Odoo rejected the sign-in request. If this repeats, flag it to Operations.";
  }
}
