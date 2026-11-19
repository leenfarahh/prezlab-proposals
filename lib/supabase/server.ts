import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { isEditor, isMember } from "@/lib/whitelist";

/** Supabase client bound to the current user's session (respects RLS). */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component: cookies are read-only there.
          // The proxy refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * The signed-in user and what they may do:
 *   isTeam    on the member list: can sign in and view everything
 *   isEditor  on HUB_WHITELIST: can also upload, edit, share, retire and delete
 *
 * getClaims() verifies the session token locally against the project's
 * signing keys (cached per process), so this normally costs no network call.
 * Cached per request, so the layout and page share one check.
 */
export const getHubUser = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : null;
  const meta = (claims?.user_metadata ?? {}) as { full_name?: unknown };
  const name = typeof meta.full_name === "string" ? meta.full_name : null;
  const editor = isEditor(email);
  return { supabase, email, name, isTeam: editor || isMember(email), isEditor: editor };
});

/** For server actions that change anything: the caller must be on HUB_WHITELIST. */
export async function requireEditor() {
  const user = await getHubUser();
  if (!user.email || !user.isTeam) throw new Error("You're not signed in.");
  if (!user.isEditor) {
    throw new Error("Only people on the hub's whitelist can upload, edit, share, retire or delete proposals.");
  }
  return user as typeof user & { email: string };
}
