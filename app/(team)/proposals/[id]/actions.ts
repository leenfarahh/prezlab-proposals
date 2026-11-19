"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireEditor } from "@/lib/supabase/server";
import { removeFiles } from "@/lib/storage";
import { clearViewerCache } from "@/lib/viewer-cache";
import { hubSecretConfigured, sealPassword } from "@/lib/access";
import { isUuid, linkNameProblem } from "@/lib/links";
import { DEVICES, type FitCheck, type FitDeviceResult } from "@/lib/fit";
import { STATUSES, VISIBILITIES, type Status, type Visibility } from "@/lib/types";

export type ActionState = { ok: boolean; message: string } | null;

function refresh(id: string) {
  revalidatePath("/");
  revalidatePath(`/proposals/${id}`);
}

export async function updateProposal(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get("id") ?? "");
  const status = String(form.get("status")) as Status;
  if (!STATUSES.includes(status)) return { ok: false, message: "Invalid status." };

  const tags = String(form.get("tags") ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const proposalDate = String(form.get("proposal_date") ?? "").trim();

  try {
    const { supabase } = await requireEditor();
    const { error } = await supabase
      .from("proposals")
      .update({
        title: String(form.get("title") ?? "").trim() || "Untitled proposal",
        client: String(form.get("client") ?? "").trim() || null,
        description: String(form.get("description") ?? "").trim() || null,
        tags: Array.from(new Set(tags)),
        status,
        proposal_date: proposalDate || null,
      })
      .eq("id", id);
    if (error) return { ok: false, message: error.message };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  refresh(id);
  return { ok: true, message: "Saved." };
}

/**
 * Client access: link name, password and who can open it.
 * A blank password field keeps the current password.
 */
export async function saveAccess(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get("id") ?? "");
  const visibility = String(form.get("visibility")) as Visibility;
  const linkName = String(form.get("link_name") ?? "").trim().toLowerCase();
  const newPassword = String(form.get("password") ?? "");
  const hadPassword = form.get("has_password") === "1";

  if (!VISIBILITIES.includes(visibility)) return { ok: false, message: "Invalid access level." };

  if (linkName) {
    const problem = linkNameProblem(linkName);
    if (problem) return { ok: false, message: problem };
  }
  if (visibility !== "private" && !linkName) {
    return { ok: false, message: "Give it a link name before sharing it with a client." };
  }
  if (newPassword && newPassword.trim().length < 6) {
    return { ok: false, message: "Use a password of at least 6 characters." };
  }
  if (visibility === "link" && !newPassword && !hadPassword) {
    return { ok: false, message: "Set a password for the client link." };
  }
  if (newPassword && !hubSecretConfigured()) {
    return { ok: false, message: "HUB_SECRET isn't set on the server, so passwords can't be stored." };
  }

  try {
    const { supabase } = await requireEditor();
    const { error } = await supabase
      .from("proposals")
      .update({
        visibility,
        link_name: linkName || null,
        ...(newPassword ? { sealed_password: sealPassword(newPassword.trim()) } : {}),
      })
      .eq("id", id);

    if (error) {
      if (error.code === "23505") return { ok: false, message: "Another proposal already uses that link name." };
      return { ok: false, message: error.message };
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  clearViewerCache();
  refresh(id);
  return {
    ok: true,
    message: newPassword && hadPassword ? "Saved. Anyone using the old password has to enter the new one." : "Saved.",
  };
}

export async function deleteProposal(form: FormData) {
  const id = String(form.get("id") ?? "");
  const { supabase } = await requireEditor();

  const { data: proposal } = await supabase
    .from("proposals")
    .select("id, storage_prefix")
    .eq("id", id)
    .maybeSingle();
  if (!proposal) redirect("/");

  const { error } = await supabase.from("proposals").delete().eq("id", id);
  if (error) throw new Error(error.message);
  clearViewerCache();
  await removeFiles(proposal.storage_prefix);

  revalidatePath("/");
  redirect("/");
}

/**
 * Kill switch for a leaked link: team only at once, password wiped (everyone
 * who opened it is signed out), link name retired for good. One database call,
 * done in a single transaction by take_down_proposal().
 */
export async function takeDownLink(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get("id") ?? "");
  const reason = String(form.get("reason") ?? "").trim().slice(0, 300);

  try {
    const { supabase } = await requireEditor();
    const { error } = await supabase.rpc("take_down_proposal", { p_id: id, p_reason: reason || null });
    if (error) {
      return {
        ok: false,
        message: /take_down_proposal/.test(error.message)
          ? "The database is missing the takedown update. Run supabase/migrations/0004_takedown.sql and 0005_members_and_editors.sql in the Supabase SQL Editor."
          : error.message,
      };
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  clearViewerCache();
  refresh(id);
  return { ok: true, message: "Link retired. The proposal is still in the hub." };
}

/**
 * Saves a screen check run in the uploader's browser. Only kept if the
 * proposal still has the files that were checked.
 */
export async function saveFitCheck(input: { id: string; prefix: string; devices: FitDeviceResult[] }): Promise<ActionState> {
  if (!isUuid(input.id) || !isUuid(input.prefix) || !Array.isArray(input.devices)) {
    return { ok: false, message: "Invalid check." };
  }
  const devices: FitDeviceResult[] = [];
  for (const d of DEVICES) {
    const r = input.devices.find((x) => x?.device === d.key);
    if (!r) continue;
    const content = Number(r.content);
    if (!Number.isFinite(content) || content < 0 || content > 100_000) return { ok: false, message: "Invalid check." };
    devices.push({
      device: d.key,
      width: d.width,
      content: Math.round(content),
      fits: Boolean(r.fits),
      culprit: typeof r.culprit === "string" ? r.culprit.slice(0, 80) : null,
      ...(r.failed ? { failed: true } : {}),
    });
  }
  if (!devices.length) return { ok: false, message: "Invalid check." };

  try {
    const { supabase } = await requireEditor();
    const check: FitCheck = { prefix: input.prefix, devices };
    const { error } = await supabase
      .from("proposals")
      .update({ fit_check: check, fit_checked_at: new Date().toISOString() })
      .eq("id", input.id)
      .eq("storage_prefix", input.prefix);
    if (error) {
      return {
        ok: false,
        message: /fit_check/.test(error.message)
          ? "The database is missing the screen check update. Run supabase/migrations/0006_screen_check.sql in the Supabase SQL Editor."
          : error.message,
      };
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  refresh(input.id);
  return { ok: true, message: "Checked." };
}
