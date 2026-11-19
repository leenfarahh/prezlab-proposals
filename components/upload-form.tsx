"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  contentTypeFor,
  formatBytes,
  fromFolder,
  fromHtmlFile,
  fromZip,
  prepare,
  type PickedProposal,
} from "@/lib/proposal-files";
import { discardUpload, finishUpload } from "@/app/(team)/upload/actions";

const BUCKET = "proposals";
const PARALLEL = 4;

/**
 * Upload a new proposal, or replace the files of an existing one
 * (pass proposalId). Files go straight from the browser to Supabase Storage,
 * so large proposals don't pass through the web server.
 */
export function UploadForm({ proposalId }: { proposalId?: string }) {
  const router = useRouter();
  const replacing = Boolean(proposalId);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const [picked, setPicked] = useState<PickedProposal | null>(null);
  const [source, setSource] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(kind: "file" | "folder", list: FileList | null) {
    setError(null);
    setPicked(null);
    if (!list?.length) return;
    try {
      const first = list[0];
      const raw =
        kind === "folder"
          ? await fromFolder(list)
          : /\.zip$/i.test(first.name)
            ? await fromZip(first)
            : /\.html?$/i.test(first.name)
              ? await fromHtmlFile(first)
              : null;
      if (!raw) throw new Error("Pick an .html file, a .zip, or a folder.");
      const result = await prepare(raw);
      setPicked(result);
      setSource(kind === "folder" ? (first.webkitRelativePath.split("/")[0] ?? "folder") : first.name);
      if (!title && result.htmlTitle) setTitle(result.htmlTitle);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!picked || busy) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);

    const prefix = crypto.randomUUID();
    const supabase = createClient();
    const queue = [...picked.files];
    let done = 0;
    setProgress({ done, total: picked.files.length });

    try {
      const worker = async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          const { error: uploadError } = await supabase.storage
            .from(BUCKET)
            .upload(`${prefix}/${f.path}`, f.blob, {
              contentType: contentTypeFor(f.path),
              cacheControl: "300",
              upsert: false,
            });
          if (uploadError) throw new Error(`${f.path}: ${uploadError.message}`);
          done += 1;
          setProgress({ done, total: picked.files.length });
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));

      const result = await finishUpload({
        proposalId,
        prefix,
        entryFile: picked.entryFile,
        title: String(form.get("title") ?? ""),
        client: String(form.get("client") ?? ""),
        date: String(form.get("date") ?? ""),
        tags: String(form.get("tags") ?? ""),
        description: String(form.get("description") ?? ""),
      });
      if (!result.ok) throw new Error(result.message);

      if (replacing) {
        setPicked(null);
        setProgress(null);
        router.refresh();
      } else {
        router.push(`/proposals/${result.id}`);
      }
    } catch (e) {
      const message = (e as Error).message;
      setError(
        /row-level security|violates/i.test(message)
          ? "Storage refused the upload. Your account may not be on the hub's whitelist, or the database update 0005 hasn't been run."
          : `Upload failed: ${message}`,
      );
      setProgress(null);
      discardUpload(prefix).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <div className="dropzone">
        <p className="small">
          {replacing
            ? "Upload the new version. The current files stay live until it's complete."
            : "An .html file, a .zip of the proposal folder, or the folder itself."}
        </p>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={busy}>
            Choose HTML or ZIP
          </button>
          <button type="button" className="btn btn-sm" onClick={() => folderInput.current?.click()} disabled={busy}>
            Choose folder
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".html,.htm,.zip,text/html,application/zip"
          hidden
          onChange={(e) => load("file", e.target.files)}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          // Non-standard attributes for folder picking (Chrome, Edge, Safari, Firefox).
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => load("folder", e.target.files)}
        />
        {picked && (
          <p className="small">
            <strong>{source}</strong> · {picked.files.length} file{picked.files.length === 1 ? "" : "s"} ·{" "}
            {formatBytes(picked.totalBytes)} · opens <code>{picked.entryFile}</code>
          </p>
        )}
      </div>

      {!replacing && (
        <>
          <label className="field">
            <span>Title</span>
            <input name="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label className="field">
            <span>Client</span>
            <input name="client" placeholder="Used to suggest the client link name" />
          </label>
          <div className="row two">
            <label className="field">
              <span>Date</span>
              <input type="date" name="date" />
            </label>
            <label className="field">
              <span>Tags (comma separated)</span>
              <input name="tags" />
            </label>
          </div>
          <label className="field">
            <span>Description</span>
            <textarea name="description" rows={2} />
          </label>
        </>
      )}

      {error && <p className="alert">{error}</p>}

      {progress && (
        <div className="progress" aria-live="polite">
          <div className="progress-bar" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          <span className="small muted">
            Uploading {progress.done} of {progress.total} files
          </span>
        </div>
      )}

      <div className="row">
        <button className="btn btn-primary" disabled={!picked || busy}>
          {busy ? "Uploading…" : replacing ? "Replace files" : "Upload proposal"}
        </button>
      </div>
    </form>
  );
}
