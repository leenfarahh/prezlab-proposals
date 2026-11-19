/**
 * What the hub adds to a proposal's HTML as it serves it. The stored files are
 * never changed, and nothing else in the document is touched.
 */

/** Tracking config + script, just before </body>. */
export function injectTracker(
  html: string,
  config: { token: string; visitorId: string; internal: boolean; endpoint: string },
): string {
  const snippet =
    `<script>window.__PZ_TRACK=${JSON.stringify(config).replace(/</g, "\\u003c")};</script>` +
    `<script src="/tracker.js" defer></script>`;

  const bodyClose = html.search(/<\/body\s*>/i);
  if (bodyClose !== -1) return html.slice(0, bodyClose) + snippet + html.slice(bodyClose);
  return html + snippet;
}

const VIEWPORT_META = /<meta\b[^>]*\bname\s*=\s*["']?viewport\b/i;

/**
 * Fit-to-screen script (public/fit.js), at the top of <head> so it downloads
 * early; it runs once the page is parsed. Pages without a viewport tag also get
 * the standard one, so phones lay them out at the phone's width instead of a
 * 980px desktop width; fit.js then shrinks them only if they don't fit.
 */
export function injectFit(html: string, options: { apply: boolean }): string {
  const snippet =
    (VIEWPORT_META.test(html) ? "" : `<meta name="viewport" content="width=device-width, initial-scale=1">`) +
    `<script>window.__PZ_FIT=${JSON.stringify({ apply: options.apply })};</script>` +
    `<script src="/fit.js" defer></script>`;

  const head = html.match(/<head\b[^>]*>/i);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + snippet + html.slice(at);
  }
  const htmlTag = html.match(/<html\b[^>]*>/i);
  if (htmlTag?.index !== undefined) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + `<head>${snippet}</head>` + html.slice(at);
  }
  // A bare fragment: after the doctype, if any, so the page stays in standards mode.
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + snippet + html.slice(at);
}

export function isHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}
