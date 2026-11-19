/**
 * Turns what someone picked in the upload form (one HTML file, a ZIP, or a
 * folder) into a flat list of files plus the entry page. Runs in the browser.
 */

import { unzip } from "fflate";

export type PickedFile = { path: string; blob: Blob };

export type PickedProposal = {
  files: PickedFile[];
  entryFile: string;
  totalBytes: number;
  htmlTitle: string | null;
};

export const MAX_FILE_BYTES = 50 * 1024 * 1024; // Supabase Storage's default per-file limit
export const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

// Characters Supabase Storage accepts in object keys.
const SAFE_KEY = /^[\w/!\-.*'() &$@=;:+,?]+$/;

function isJunk(path: string): boolean {
  return (
    path.split("/").some((seg) => seg.startsWith(".") || seg === "__MACOSX") ||
    /(^|\/)(Thumbs\.db|desktop\.ini)$/i.test(path)
  );
}

/** Drops a single wrapping folder ("my-proposal/index.html" -> "index.html"). */
function stripCommonRoot(paths: PickedFile[]): PickedFile[] {
  if (!paths.length || paths.some((f) => !f.path.includes("/"))) return paths;
  const first = paths[0].path.split("/")[0];
  if (!paths.every((f) => f.path.startsWith(`${first}/`))) return paths;
  return stripCommonRoot(paths.map((f) => ({ ...f, path: f.path.slice(first.length + 1) })));
}

export async function fromHtmlFile(file: File): Promise<PickedFile[]> {
  return [{ path: "index.html", blob: file }];
}

export async function fromFolder(list: FileList): Promise<PickedFile[]> {
  return Array.from(list).map((file) => ({
    // webkitRelativePath is "<picked folder>/<path inside it>".
    path: (file.webkitRelativePath || file.name).split("/").slice(1).join("/") || file.name,
    blob: file,
  }));
}

export async function fromZip(file: File): Promise<PickedFile[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(data, (err, out) => (err ? reject(new Error("That ZIP file couldn't be opened.")) : resolve(out))),
  );
  return Object.entries(entries)
    .filter(([path]) => !path.endsWith("/"))
    .map(([path, bytes]) => ({
      path,
      blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentTypeFor(path) }),
    }));
}

/** Validates the picked files and finds the page to open. Throws with a readable message. */
export async function prepare(raw: PickedFile[]): Promise<PickedProposal> {
  const files = stripCommonRoot(raw.filter((f) => f.path && !isJunk(f.path)));
  if (!files.length) throw new Error("No files found.");

  const html = files.filter((f) => /\.html?$/i.test(f.path));
  const entry =
    html.find((f) => /^index\.html?$/i.test(f.path)) ?? (html.length === 1 ? html[0] : undefined);
  if (!entry) {
    throw new Error(
      html.length
        ? "Found several HTML pages but no index.html. Rename the main page to index.html."
        : "No HTML page found. Upload an .html file, or a ZIP or folder containing index.html.",
    );
  }

  const badNames = files.filter((f) => !SAFE_KEY.test(f.path)).map((f) => f.path);
  if (badNames.length) {
    throw new Error(
      `Rename these files using English letters, numbers and dashes (storage rejects other characters), ` +
        `and update their references in the HTML: ${badNames.slice(0, 5).join(", ")}` +
        (badNames.length > 5 ? ` and ${badNames.length - 5} more` : ""),
    );
  }

  const tooBig = files.find((f) => f.blob.size > MAX_FILE_BYTES);
  if (tooBig) throw new Error(`${tooBig.path} is over 50 MB. Compress it and try again.`);

  const totalBytes = files.reduce((sum, f) => sum + f.blob.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("This proposal is over 300 MB. Compress its images or videos.");

  const head = (await entry.blob.slice(0, 200_000).text()) ?? "";
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]?.trim() ?? "";

  return { files, entryFile: entry.path, totalBytes, htmlTitle: rawTitle ? decodeEntities(rawTitle) : null };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ");
}

const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  txt: "text/plain",
};

export function contentTypeFor(path: string): string {
  return TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
