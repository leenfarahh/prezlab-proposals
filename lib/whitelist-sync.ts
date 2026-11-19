import "server-only";

import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { members, whitelist } from "@/lib/whitelist";

// Kept on globalThis: Next bundles routes separately, and a module-level
// variable would sync once per bundle instead of once per process.
const KEY = "__prezlabHubTeamSynced" as const;
type SyncGlobal = typeof globalThis & { [KEY]?: string };

/**
 * Makes team_whitelist match members.txt and HUB_WHITELIST: one row per
 * member, with is_editor set for the whitelist. Free when nothing changed: the
 * last synced lists' hash is remembered per server process, so this costs one
 * database call only after a deploy or an edit to either list.
 *
 * An empty whitelist is never synced, so a missing variable can't wipe the table.
 */
export async function syncTeam(): Promise<{ ok: boolean; error?: string }> {
  const editors = whitelist();
  if (!editors.length) return { ok: false, error: "HUB_WHITELIST is empty" };
  const everyone = members();

  // Includes the project URL, so pointing .env.local at a different Supabase
  // project re-syncs even if the server process was never restarted.
  const hash = createHash("sha256")
    .update(`${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}|${editors.join(",")}|${everyone.join(",")}`)
    .digest("hex");
  const g = globalThis as SyncGlobal;
  if (g[KEY] === hash) return { ok: true };

  // One transaction in the database: upsert everyone, flag editors, remove
  // anyone no longer listed. Names and last sign-in times are kept.
  const { error } = await createAdminClient().rpc("sync_team_members", {
    p_members: everyone,
    p_editors: editors,
  });
  if (error) return { ok: false, error: describe(error.message) };

  g[KEY] = hash;
  return { ok: true };
}

function describe(message: string): string {
  return /sync_team_members|team_whitelist|is_editor/.test(message)
    ? `${message} (run supabase/migrations/0005_members_and_editors.sql in the Supabase SQL Editor)`
    : message;
}
