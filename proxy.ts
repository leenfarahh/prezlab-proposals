import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isMember } from "@/lib/whitelist";

/**
 * Runs before every team page:
 *  - refreshes the Supabase session cookie when it's about to expire
 *  - sends anyone who isn't signed in, or isn't a member (members.txt or
 *    HUB_WHITELIST), to /login
 *
 * Both checks are local: getClaims() verifies the token against the project's
 * signing keys (cached), and the lists come from the server (file and
 * environment). Editor-only actions are checked again where they happen.
 *
 * Proposal viewer (/prezlab/...), tracking (/api/track), the Odoo sign-in endpoint
 * (/api/auth/...), login and auth callbacks are excluded below and enforce
 * their own rules.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const email = typeof data?.claims?.email === "string" ? data.claims.email : null;

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";

  if (!email) {
    const next = request.nextUrl.pathname + request.nextUrl.search;
    if (next !== "/") loginUrl.searchParams.set("next", next);
    return NextResponse.redirect(loginUrl);
  }

  if (!isMember(email)) {
    loginUrl.searchParams.set("error", "not_team");
    const redirect = NextResponse.redirect(loginUrl);
    // Clear the session so the user can try a different account.
    request.cookies
      .getAll()
      .filter((c) => c.name.startsWith("sb-"))
      .forEach((c) => redirect.cookies.delete(c.name));
    return redirect;
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except: static files, the proposal viewer and its scripts, tracking, Odoo sign-in, login and auth.
    "/((?!_next/static|_next/image|favicon.ico|tracker.js|fit.js|prezlab/|api/track|api/auth/|login|auth/).*)",
  ],
};
