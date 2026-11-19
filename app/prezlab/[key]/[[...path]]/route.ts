import { NextResponse, type NextRequest } from "next/server";
import mime from "mime-types";
import { createAdminClient } from "@/lib/supabase/admin";
import { getHubUser } from "@/lib/supabase/server";
import { env, STORAGE_BUCKET } from "@/lib/env";
import { injectFit, injectTracker, isHtml } from "@/lib/inject";
import { isUuid, VIEWER_PREFIX } from "@/lib/links";
import {
  ACCESS_COOKIE,
  cookieSecurity,
  issueAccess,
  openPassword,
  passwordMatches,
  readAccess,
} from "@/lib/access";
import { clientIp, rateLimit, resetRateLimit } from "@/lib/ratelimit";
import { cacheGet, cacheSet } from "@/lib/viewer-cache";
import { notFoundPage, passwordPage, takenDownPage, unavailablePage } from "@/lib/viewer-pages";

/**
 * Proposal viewer.
 *
 *   /prezlab/<link-name>/   what clients get. "Client link + password" shows
 *                           a password page first; "Public" opens directly.
 *   /prezlab/<proposal-id>/ team only, for proposals that have no link name yet.
 *
 * Team members (signed in and on the member list) can open any proposal either way.
 *
 * Every page gets the fit-to-screen script (public/fit.js). The hub's own
 * preview and screen check add ?pz-preview, which skips tracking so team
 * previews don't fill the analytics with internal events.
 */

export const dynamic = "force-dynamic";

const VISITOR_COOKIE = "pz_vid";
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$/;

// Applied only when the viewer has a team session. Sandboxed pages get an
// opaque origin, so proposal scripts can't read the team's login cookies.
// Clients have no such cookies, and their pages stay unsandboxed so images and
// styles load in every browser (a sandboxed page drops most cookies on them).
const SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox " +
  "allow-modals allow-downloads allow-presentation allow-top-navigation-by-user-activation";

type Params = { key: string; path?: string[] };

type Row = {
  id: string;
  visibility: "private" | "link" | "public";
  storage_prefix: string;
  entry_file: string;
  link_name: string | null;
  sealed_password: string | null;
  password_version: number;
  share_token: string;
};

const COLUMNS =
  "id, visibility, storage_prefix, entry_file, link_name, sealed_password, password_version, share_token";

// Short, so access changes apply within seconds. A takedown clears it at once.
const CACHE_MS = 5000;

type Lookup = { row: Row | null; byId: boolean; retired: boolean };

async function findProposal(key: string, fresh = false): Promise<Lookup> {
  const cacheKey = `viewer:${key}`;
  if (!fresh) {
    const hit = cacheGet<Lookup>(cacheKey);
    if (hit) return hit;
  }

  const byId = isUuid(key);
  const admin = createAdminClient();
  const { data } = await admin
    .from("proposals")
    .select(COLUMNS)
    .eq(byId ? "id" : "link_name", key)
    .maybeSingle();

  // A link that was taken down gets its own page, so whoever holds the
  // leaked address learns it's dead rather than mistyped.
  let retired = false;
  if (!data && !byId) {
    const { data: r } = await admin
      .from("retired_link_names")
      .select("link_name")
      .eq("link_name", key)
      .maybeSingle();
    retired = Boolean(r);
  }

  const result: Lookup = { row: (data as Row | null) ?? null, byId, retired };
  cacheSet(cacheKey, result, CACHE_MS);
  return result;
}

export async function GET(request: NextRequest, ctx: { params: Promise<Params> }) {
  const { key, path } = await ctx.params;
  if (!KEY_PATTERN.test(key)) return notFoundPage();

  // Canonical form first: the access cookie is scoped to /prezlab/<key>/ exactly.
  const canonical = key.toLowerCase();
  const base = `${VIEWER_PREFIX}/${canonical}/`;
  if (!path?.length && request.nextUrl.pathname !== base) {
    // Set Location manually: NextResponse.redirect() normalizes the trailing slash away.
    return new NextResponse(null, { status: 308, headers: { Location: base + request.nextUrl.search } });
  }

  const found = await findProposal(canonical);
  if (!found.row) return found.retired && !path?.length ? takenDownPage() : notFoundPage();
  const { row, byId } = found;

  const relPath = path?.length ? path.map(safeDecode).join("/") : row.entry_file;
  if (relPath.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return notFoundPage();
  const isPage = !path?.length || isHtml(relPath);

  // --- who's asking --------------------------------------------------------
  const grant = readAccess(request.cookies.get(ACCESS_COOKIE)?.value, row.id, row.password_version);
  const clientAllowed =
    !byId && (row.visibility === "public" || (row.visibility === "link" && grant === "client"));

  // Login cookies only arrive with page loads (see SANDBOX_CSP), so only check
  // the session there. Images and styles rely on the team grant set below.
  const hasSession = request.cookies.getAll().some((c) => c.name.startsWith("sb-"));
  let sessionIsTeam = false;
  if (isPage && hasSession) sessionIsTeam = (await getHubUser()).isTeam;
  const teamAllowed = sessionIsTeam || grant === "team";

  if (!clientAllowed && !teamAllowed) {
    if (!isPage) return notFoundPage();
    if (!byId && row.visibility === "link") return passwordPage();
    return unavailablePage(base);
  }

  // --- serve -----------------------------------------------------------------
  const { data: file, error } = await createAdminClient()
    .storage.from(STORAGE_BUCKET)
    .download(`${row.storage_prefix}/${relPath}`);
  if (error || !file) return notFoundPage();

  if (!isHtml(relPath)) {
    return new NextResponse(file.stream(), {
      headers: {
        "Content-Type": mime.contentType(relPath.split("/").pop() ?? "") || "application/octet-stream",
        "Cache-Control": "private, max-age=300",
        // Sandboxed pages have an opaque origin, so fonts and fetch() need CORS.
        "Access-Control-Allow-Origin": "*",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  let visitorId = request.cookies.get(VISITOR_COOKIE)?.value;
  const isNewVisitor = !visitorId;
  if (!visitorId) visitorId = crypto.randomUUID();

  const preview = teamAllowed && request.nextUrl.searchParams.has("pz-preview");
  let html = injectFit(await file.text(), { apply: env.fitProposals() });
  if (!preview) {
    html = injectTracker(html, {
      token: row.share_token,
      visitorId,
      internal: teamAllowed,
      endpoint: "/api/track",
    });
  }

  const sandbox = hasSession && env.sandboxProposals();
  const res = new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": row.visibility === "public" && !byId ? "all" : "noindex, nofollow",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      ...(sandbox ? { "Content-Security-Policy": SANDBOX_CSP } : {}),
    },
  });

  const security = cookieSecurity(request.nextUrl);
  if (sessionIsTeam) {
    const { value, maxAge } = issueAccess(row.id, row.password_version, "team");
    res.cookies.set(ACCESS_COOKIE, value, { httpOnly: true, path: base, maxAge, ...security });
  }
  if (isNewVisitor) {
    res.cookies.set(VISITOR_COOKIE, visitorId, {
      httpOnly: true,
      path: `${VIEWER_PREFIX}/`,
      maxAge: 60 * 60 * 24 * 365,
      ...security,
    });
  }
  return res;
}

/** The password form posts here. */
export async function POST(request: NextRequest, ctx: { params: Promise<Params> }) {
  const { key, path } = await ctx.params;
  const canonical = key.toLowerCase();
  if (path?.length || !KEY_PATTERN.test(key) || isUuid(canonical)) return notFoundPage();

  const found = await findProposal(canonical, true);
  if (!found.row) return found.retired ? takenDownPage() : notFoundPage();
  if (found.row.visibility !== "link") return notFoundPage();
  const row = found.row;

  const limitKey = `gate:${clientIp(request.headers)}:${row.id}`;
  if (!rateLimit(limitKey, 8, 600).allowed) {
    return passwordPage("Too many attempts. Wait a few minutes and try again.", 429);
  }

  const form = await request.formData().catch(() => null);
  const attempt = String(form?.get("password") ?? "");
  const actual = openPassword(row.sealed_password);
  if (!attempt || !actual || !passwordMatches(attempt, actual)) {
    return passwordPage("That password isn't right. Check it and try again.", 401);
  }

  resetRateLimit(limitKey);
  const base = `${VIEWER_PREFIX}/${canonical}/`;
  const { value, maxAge } = issueAccess(row.id, row.password_version, "client");
  const res = new NextResponse(null, { status: 303, headers: { Location: base } });
  res.cookies.set(ACCESS_COOKIE, value, {
    httpOnly: true,
    path: base,
    maxAge,
    ...cookieSecurity(request.nextUrl),
  });
  return res;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
