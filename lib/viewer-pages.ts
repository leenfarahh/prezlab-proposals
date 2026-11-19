import "server-only";

/**
 * The small pages clients can see instead of a proposal: the password gate,
 * "not available", and "not found". Self-contained HTML (no app CSS, no
 * external requests), noindex, never cached.
 */

const STYLE = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#16161a;--muted:#6f6f78;--line:#e4e2dc;--accent:#3a35d6;--danger:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#121216;--card:#1b1b21;--ink:#f2f2f4;--muted:#9a9aa5;--line:#2c2c34;--accent:#8b87ff;--danger:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--ink);
font:15px/1.5 "Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px}
.eyebrow{margin:0 0 6px;text-transform:uppercase;letter-spacing:.14em;font-size:12px;color:var(--muted)}
h1{margin:0 0 8px;font-size:22px;letter-spacing:-.01em;line-height:1.25}
p{margin:0 0 20px;color:var(--muted)}
label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
input{width:100%;font:inherit;color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:8px;padding:10px 12px;outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
button{margin-top:14px;width:100%;height:42px;border:0;border-radius:8px;background:var(--ink);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
.error{margin:12px 0 0;color:var(--danger);font-size:14px}
a{color:var(--accent)}
.foot{margin:20px 0 0;font-size:13px}
`;

function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex,nofollow"><title>${title}</title><style>${STYLE}</style></head>` +
      `<body><main>${body}</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

export function passwordPage(error?: string, status = 200): Response {
  return page(
    "Protected proposal",
    `<p class="eyebrow">Prezlab</p>
<h1>This proposal is password protected</h1>
<p>Enter the password shared with you to view it.</p>
<form method="post">
<label for="pw">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<button type="submit">View proposal</button>
</form>`,
    status,
  );
}

export function unavailablePage(signInPath: string): Response {
  return page(
    "Proposal unavailable",
    `<p class="eyebrow">Prezlab</p>
<h1>This proposal isn't available</h1>
<p>The link may have been turned off. Contact the person who sent it to you.</p>
<p class="foot">Prezlab team? <a href="/login?next=${encodeURIComponent(signInPath)}">Sign in</a></p>`,
    403,
  );
}

/** A link that was taken down (leaked, revoked). 410: gone for good. */
export function takenDownPage(): Response {
  return page(
    "Link disabled",
    `<p class="eyebrow">Prezlab</p>
<h1>This link has been disabled</h1>
<p>It no longer gives access to the proposal. If you should have access, contact your Prezlab contact for a new link.</p>`,
    410,
  );
}

export function notFoundPage(): Response {
  return page(
    "Not found",
    `<p class="eyebrow">Prezlab</p>
<h1>Proposal not found</h1>
<p>Check the link, or contact the person who sent it to you.</p>`,
    404,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
