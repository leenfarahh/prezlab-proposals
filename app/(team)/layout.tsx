import Link from "next/link";
import { getHubUser } from "@/lib/supabase/server";
import { syncTeam } from "@/lib/whitelist-sync";

export default async function TeamLayout({ children }: { children: React.ReactNode }) {
  // Both are local in the normal case: the token is verified against cached
  // signing keys, and the sync only calls the database after members.txt or
  // HUB_WHITELIST changes.
  const [{ email, isEditor }, synced] = await Promise.all([getHubUser(), syncTeam()]);
  if (!synced.ok) console.warn(`[members] not synced to the database: ${synced.error}`);

  return (
    <>
      <header className="topbar">
        <div className="row">
          <Link href="/" className="brand">
            <span className="brand-mark">P</span>
            Proposals Hub
          </Link>
          <nav className="nav">
            <Link href="/">Proposals</Link>
            {isEditor && <Link href="/upload">Upload</Link>}
          </nav>
        </div>
        <div className="topbar-right">
          {email && (
            <span className="muted small">
              {email}
              {!isEditor && " · view only"}
            </span>
          )}
          <form action="/auth/signout" method="post">
            <button className="btn btn-ghost btn-sm">Sign out</button>
          </form>
        </div>
      </header>
      <main className="container">{children}</main>
    </>
  );
}
