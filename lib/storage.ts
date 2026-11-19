import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { STORAGE_BUCKET } from "@/lib/env";

/** Every object path under a prefix, recursively. */
export async function listFiles(prefix: string): Promise<string[]> {
  const admin = createAdminClient();
  const out: string[] = [];

  async function walk(folder: string) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin.storage.from(STORAGE_BUCKET).list(folder, { limit: 1000, offset });
      if (error) throw new Error(`Could not list files: ${error.message}`);
      if (!data?.length) return;
      for (const item of data) {
        const full = `${folder}/${item.name}`;
        // Folders come back with a null id.
        if (item.id === null) await walk(full);
        else out.push(full);
      }
      if (data.length < 1000) return;
    }
  }

  await walk(prefix);
  return out;
}

/** Deletes everything under a prefix. Best effort: logs instead of throwing. */
export async function removeFiles(prefix: string): Promise<void> {
  try {
    const files = await listFiles(prefix);
    const admin = createAdminClient();
    for (let i = 0; i < files.length; i += 100) {
      const { error } = await admin.storage.from(STORAGE_BUCKET).remove(files.slice(i, i + 100));
      if (error) console.warn(`[storage] could not remove files under ${prefix}: ${error.message}`);
    }
  } catch (error) {
    console.warn(`[storage] cleanup of ${prefix} failed`, error);
  }
}
