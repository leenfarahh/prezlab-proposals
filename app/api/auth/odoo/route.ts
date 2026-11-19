import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { loginToOdoo, describeOdooLoginFailure, type OdooIdentity } from "@/lib/odoo-totp";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { clientIp, rateLimit, resetRateLimit } from "@/lib/ratelimit";
import { odooConfigured, supabaseConfigured } from "@/lib/env";
import { isMember } from "@/lib/whitelist";
import { syncTeam } from "@/lib/whitelist-sync";

/**
 * POST /api/auth/odoo - sign in with Odoo credentials (two-factor included).
 *
 * Odoo is the source of truth for identity; Supabase holds the session. Same
 * bridge as Image Studio:
 *
 *   1. verify login, password and (if enabled) the 2FA code against Odoo
 *   2. check the Odoo email against the member list (members.txt plus
 *      HUB_WHITELIST), and mirror both into team_whitelist, which the
 *      database uses for is_team_member() and is_team_editor()
 *   3. find or create the matching Supabase auth user
 *   4. mint a one-time token with the service role and redeem it on the
 *      cookie-bound client, which writes the session cookies
 *
 * The Odoo password never leaves step 1. No email is sent. The Supabase user
 * gets a random password nobody holds, so Odoo stays the only way in.
 */

const IP_LIMIT = 20;
const IP_WINDOW_SECONDS = 300;
const LOGIN_LIMIT = 6;
const LOGIN_WINDOW_SECONDS = 300;

type Body = {
  login?: unknown;
  password?: unknown;
  /** Present only on the second call, after a totpRequired response. */
  totpCode?: unknown;
  pendingSession?: unknown;
};

function fail(message: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

export async function POST(request: Request) {
  if (!supabaseConfigured() || !odooConfigured()) {
    console.error(
      "[auth/odoo] refused: set real values for the Supabase and Odoo variables in .env.local " +
        "(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ODOO_URL, ODOO_DB).",
    );
    return fail(
      "Sign-in is not set up yet: the Supabase or Odoo settings are still placeholders.",
      503,
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return fail("Malformed request.", 400);
  }

  const login = typeof body.login === "string" ? body.login.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const totpCode = typeof body.totpCode === "string" ? body.totpCode.trim() : "";
  const pendingSession = typeof body.pendingSession === "string" ? body.pendingSession : "";

  // Two shapes: credentials, or a code continuing a challenge from a previous
  // call. The second does not resend the password.
  const resumingChallenge = Boolean(totpCode && pendingSession);

  if (!login || (!password && !resumingChallenge)) {
    return fail("Enter both your Odoo login and password.", 400);
  }

  // A wide window per IP against spraying many accounts, and a tight one per
  // login against guessing a single account.
  const ip = clientIp(request.headers);
  const ipCheck = rateLimit(`odoo:ip:${ip}`, IP_LIMIT, IP_WINDOW_SECONDS);
  if (!ipCheck.allowed) {
    return fail("Too many sign-in attempts from this network. Try again shortly.", 429, {
      retryAfter: ipCheck.retryAfterSeconds,
    });
  }

  const loginKey = `odoo:login:${login.toLowerCase()}`;
  const loginCheck = rateLimit(loginKey, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS);
  if (!loginCheck.allowed) {
    return fail(
      "Too many failed attempts for this account. Wait a few minutes before retrying.",
      429,
      { retryAfter: loginCheck.retryAfterSeconds },
    );
  }

  // --- 1. Odoo ------------------------------------------------------------
  let odooResult;
  try {
    odooResult = await loginToOdoo({
      login,
      password: resumingChallenge ? undefined : password,
      totpCode: resumingChallenge ? totpCode : undefined,
      pendingSession: resumingChallenge ? pendingSession : undefined,
    });
  } catch (error) {
    console.error("[auth/odoo] unexpected Odoo failure", error);
    return fail("Sign-in is temporarily unavailable. Try again shortly.", 502);
  }

  if (!odooResult.ok) {
    // A 2FA challenge is a step, not a failure: hand the pending session back
    // so the client can collect a code without asking for the password again.
    if (odooResult.reason === "totp_required") {
      return NextResponse.json({
        ok: false,
        totpRequired: true,
        pendingSession: odooResult.pendingSession,
        error: "Enter the 6-digit code from your authenticator app.",
      });
    }

    if (odooResult.detail) {
      // The Odoo-side detail is for the server log, not the response.
      console.warn(`[auth/odoo] ${odooResult.reason}: ${odooResult.detail}`);
    }
    const status =
      odooResult.reason === "odoo_unreachable" || odooResult.reason === "odoo_error" ? 502 : 401;
    return fail(describeOdooLoginFailure(odooResult.reason), status);
  }

  const odooUser = odooResult.user;

  // --- 2 and 3. member list and Supabase user ------------------------------
  if (!isMember(odooUser.email)) {
    console.warn(`[auth/odoo] refused: ${odooUser.email} is not in members.txt or HUB_WHITELIST`);
    return fail(
      "Your Odoo login worked, but this account isn't on the Proposals Hub member list. " +
        "Ask the hub owner to add your email.",
      403,
    );
  }

  try {
    // The database's copy of the lists must be current before this
    // person gets a session, or its access rules would still refuse them.
    const synced = await syncTeam();
    if (!synced.ok) throw new Error(synced.error);
    await recordSignIn(odooUser);
    await ensureAuthUser(odooUser);
  } catch (error) {
    console.error("[auth/odoo] member sync or user setup failed", error);
    const detail = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
    if (/ENOTFOUND|ECONNREFUSED|fetch failed|getaddrinfo/i.test(detail)) {
      return fail(
        "Your Odoo login worked, but the hub could not reach its database. " +
          "The Supabase URL or keys in .env.local are likely wrong.",
        503,
      );
    }
    const migration = detail.match(/(000d_[a-z_]+).sql/)?.[1];
    if (migration) {
      return fail(
        "Your Odoo login worked, but the hub's database is missing its latest update. " +
          `Run supabase/migrations/${migration}.sql in the Supabase SQL Editor.`,
        503,
      );
    }
    return fail("Signed in with Odoo, but the hub account could not be prepared. Try again.", 500);
  }

  // --- 4. mint and redeem the session ------------------------------------
  try {
    const admin = createAdminClient();
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: odooUser.email,
    });
    if (linkError || !link?.properties?.hashed_token) {
      throw linkError ?? new Error("Supabase did not return a token hash.");
    }

    // Redeeming on the request-scoped client writes the auth cookies onto this
    // response. The token never leaves the server and no email is sent.
    const supabase = await createClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "magiclink",
    });
    if (verifyError) throw verifyError;
  } catch (error) {
    console.error("[auth/odoo] session mint failed", error);
    return fail("Could not start a session. Try again.", 500);
  }

  resetRateLimit(loginKey);

  return NextResponse.json({ ok: true, user: { email: odooUser.email, name: odooUser.name } });
}

/** Keeps the name shown in upload history current with Odoo. */
async function recordSignIn(user: OdooIdentity): Promise<void> {
  const { error } = await createAdminClient()
    .from("team_whitelist")
    .update({ name: user.name, last_sign_in_at: new Date().toISOString() })
    .eq("email", user.email.toLowerCase());
  if (error) throw error;
}

async function ensureAuthUser(user: OdooIdentity): Promise<void> {
  const { error } = await createAdminClient().auth.admin.createUser({
    email: user.email,
    password: randomBytes(32).toString("base64url"),
    email_confirm: true,
    user_metadata: { full_name: user.name, odoo_uid: user.uid, provider: "odoo" },
  });
  if (!error) return;
  const alreadyExists =
    error.code === "email_exists" ||
    error.code === "user_already_exists" ||
    /already (been )?registered|already exists/i.test(error.message);
  if (!alreadyExists) throw error;
}
