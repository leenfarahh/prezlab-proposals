/** Client link names: /prezlab/<link-name>. Shared by the browser and the server. */

/** Where proposals are served. Must match the app/prezlab route folder and the proxy matcher. */
export const VIEWER_PREFIX = "/prezlab";

export const LINK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Gulf Bank (KSA)" -> "gulf-bank-ksa". Empty for names with no Latin letters or digits. */
export function toLinkName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** Null when valid, otherwise the reason. */
export function linkNameProblem(name: string): string | null {
  if (!LINK_NAME_PATTERN.test(name)) {
    return "Use 3 to 60 lowercase English letters, numbers or dashes, starting and ending with a letter or number.";
  }
  if (UUID_PATTERN.test(name)) return "That link name is reserved. Pick a readable name.";
  return null;
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Where team members open a proposal: its client link if it has one, otherwise its id. */
export function viewerPath(p: { id: string; link_name: string | null }): string {
  return `${VIEWER_PREFIX}/${p.link_name ?? p.id}/`;
}

/** The link sent to clients. No trailing slash; the viewer adds it with a redirect. */
export function clientPath(linkName: string): string {
  return `${VIEWER_PREFIX}/${linkName}`;
}
