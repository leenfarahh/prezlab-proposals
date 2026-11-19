"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireEditor } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listFiles, removeFiles } from "@/lib/storage";
import { isUuid } from "@/lib/links";

/**
 * Upload flow: the browser puts the files straight into Storage under a fresh
 * folder (a random id), then calls finishUpload to create the proposal, or to
 * point an existing one at the new folder. Switching folders makes a
 * replacement all-or-nothing: viewers see the old files until the moment the
 * new ones are complete. The database stamps who uploaded and logs it.
 */

export type FinishInput = {
  proposalId?: string;
  prefix: string;
  entryFile: string;
  title?: string;
  client?: string;
  date?: string;
  tags?: string;
  description?: string;
};

export type FinishResult = { ok: true; id: string } | { ok: false; message: string };

export async function finishUpload(input: FinishInput): Promise<FinishResult> {
  let user;
  try {
    user = await requireEditor();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  if (!isUuid(input.prefix)) return { ok: false, message: "Invalid upload." };
  const entry = String(input.entryFile ?? "");
  if (!entry || entry.split("/").some((s) => !s || s === "." || s === "..")) {
    return { ok: false, message: "Invalid entry file." };
  }

  let files: string[];
  try {
    files = await listFiles(input.prefix);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!files.includes(`${input.prefix}/${entry}`)) {
    return { ok: false, message: "The upload didn't finish: the main page is missing. Try again." };
  }

  const { supabase } = user;

  // --- replace files of an existing proposal --------------------------------
  if (input.proposalId) {
    const { data: existing, error: readError } = await supabase
      .from("proposals")
      .select("id, storage_prefix")
      .eq("id", input.proposalId)
      .maybeSingle();
    if (readError || !existing) return { ok: false, message: "Proposal not found." };

    const { error } = await supabase
      .from("proposals")
      .update({ storage_prefix: input.prefix, entry_file: entry, file_count: files.length })
      .eq("id", existing.id);
    if (error) return { ok: false, message: error.message };

    if (existing.storage_prefix && existing.storage_prefix !== input.prefix) {
      await removeFiles(existing.storage_prefix);
    }
    revalidatePath("/");
    revalidatePath(`/proposals/${existing.id}`);
    return { ok: true, id: existing.id };
  }

  // --- new proposal ----------------------------------------------------------
  const title = (input.title ?? "").trim() || "Untitled proposal";
  const tags = Array.from(
    new Set(
      (input.tags ?? "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const date = (input.date ?? "").trim();

  const { data: created, error } = await supabase
    .from("proposals")
    .insert({
      // Internal identifier only; clients see the link name set later.
      slug: `${slugify(title)}-${randomBytes(3).toString("hex")}`,
      title,
      client: (input.client ?? "").trim() || null,
      description: (input.description ?? "").trim() || null,
      tags,
      proposal_date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      status: "draft",
      visibility: "private",
      storage_prefix: input.prefix,
      entry_file: entry,
      file_count: files.length,
    })
    .select("id")
    .single();

  if (error || !created) {
    await removeFiles(input.prefix);
    return { ok: false, message: error?.message ?? "Could not save the proposal." };
  }

  revalidatePath("/");
  return { ok: true, id: created.id };
}

/** Removes the files of an upload that failed or was cancelled. */
export async function discardUpload(prefix: string): Promise<void> {
  await requireEditor();
  if (!isUuid(prefix)) return;
  // Never touch a folder a proposal is using.
  const { count } = await createAdminClient()
    .from("proposals")
    .select("id", { count: "exact", head: true })
    .eq("storage_prefix", prefix);
  if (count) return;
  await removeFiles(prefix);
}

function slugify(input: string): string {
  return (
    input
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "proposal"
  );
}
