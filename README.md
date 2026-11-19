# Prezlab Proposals Hub

One website for every HTML proposal. Everyone at Prezlab signs in with their Odoo account (two-factor included) and can browse every proposal. People on the whitelist also upload proposals and share each one with the client through a named link and a password. Every client view is tracked (opens, clicks, scroll depth, reading time) as the foundation for click-through reports and heatmaps.

**Stack:** Next.js 16 (App Router) + Supabase (Postgres, Auth, Storage), with Odoo as the sign-in. Deploys to Vercel.

```
supabase/migrations/          ← database schema, access rules, storage bucket
app/                          ← the website (upload, manage, share, view)
lib/                          ← sign-in, access, storage and whitelist helpers
public/tracker.js             ← analytics script injected into every proposal
```

---

## 1. Set up Supabase (10 min)

1. Create a project at [supabase.com](https://supabase.com). Pick the region closest to the team and clients (Frankfurt, `eu-central-1`, for the Gulf and Levant). Every page makes Supabase calls, so a distant region makes the whole hub slow.
2. **SQL Editor** → run each file in `supabase/migrations/` once, in order:
   - `0001_init.sql`: tables, access rules and a private `proposals` storage bucket
   - `0002_odoo_trusted_devices.sql`: lets people with Odoo 2FA skip the code for 30 days per device
   - `0003_hub_uploads_access.sql`: whitelist, uploads from the hub, upload history, client links with passwords
   - `0004_takedown.sql`: **Retire link**, the kill switch for leaked links
   - `0005_members_and_editors.sql`: everyone at Prezlab can view, only the whitelist can change things
   - `0006_screen_check.sql`: saves each proposal's phone, tablet, laptop and desktop check

   Each file is safe to re-run on its own, but re-running an older file after a newer one can undo the newer changes. If in doubt, re-run them all in order.
3. **Authentication → URL Configuration**: set Site URL to your production URL (e.g. `https://proposals.prezlab.com`). No email or SMTP setup is needed: sign-in goes through Odoo and Supabase never sends mail.
4. **Project Settings → API**: copy the Project URL, the anon (publishable) key and the service_role (secret) key.

## 2. Run it locally

```bash
cp .env.example .env.local      # fill in the Supabase, Odoo and hub values
cp members.example.txt members.txt   # paste the staff email list
npm install
npm run dev                     # http://localhost:3000
```

Sign in with your Odoo login and password. If your Odoo account has two-factor authentication, you'll be asked for the 6-digit code once, then the device is remembered for 30 days.

Keep all values in `.env.local`. Next.js gives it priority over `.env`, so a leftover `.env.local` with placeholder values overrides real ones (the symptom is "Failed to fetch" or "settings are still placeholders" on the login page).

Keep the project outside OneDrive or other synced folders: syncing `node_modules` and `.next` makes installs and the dev server much slower.

## 3. Who can sign in, and who can change things

| | Where it's set | Can do |
|---|---|---|
| **Members** | `members.txt` | Sign in, browse, open any proposal, see stats and history, copy client links |
| **Whitelist** | `HUB_WHITELIST` in `.env.local` (and on the host) | Everything members can, plus upload, edit, set links and passwords, retire links, delete |

**members.txt** holds everyone at Prezlab, one person per line. Paste the list straight from an Odoo export (Employees, Work Email column): anything on a line that isn't an email is ignored, and lines starting with `#` are comments. See `members.example.txt`. Edits apply within a few seconds, no restart needed. The file is kept out of git; on Render, upload it as a **Secret File** named `members.txt`.

**HUB_WHITELIST** is a short, comma-separated list. People on it are always members, even if they're missing from `members.txt`. After editing it, restart the dev server (locally) or redeploy.

```
HUB_WHITELIST=first.person@prezlab.com, second.person@prezlab.com
```

Use the email on each person's Odoo account. Removing someone from `members.txt` locks them out on their next click. Without a `members.txt`, only the whitelist can sign in. The server mirrors both lists into the `team_whitelist` table so the database enforces the same rules; don't edit that table by hand.

Members who aren't on the whitelist see the hub as view only: no Upload button, no edit or delete controls, and client passwords stay hidden from them.

## 4. Upload and share a proposal

1. **Upload** (top bar): pick a single `.html` file, a `.zip` of the proposal folder, or the folder itself. The main page must be `index.html` (or the only HTML file). File names must use English letters, numbers and dashes. Files go straight from the browser to Supabase Storage, up to 50 MB per file and 300 MB per proposal.
2. On the proposal's page, under **Client access**:
   - **Link name**: usually the client's name, e.g. `gulf-bank` → `/prezlab/gulf-bank`. Each name belongs to one proposal at a time.
   - **Who can open it**: *Client link + password*, *Public link* (no password), or *Team only*.
   - **Password**: type one or click **Generate**. The team can see it again on this page at any time.
   - **Copy link + password** copies both, ready to paste into an email.
3. To update a proposal, use **Files → Replace files**. The old version stays live until the new upload is complete.

Every upload, new version, access change, link change, password change, retired link, edit and deletion is recorded with who did it and when (**History** on each proposal). The uploader is also shown on every card.

### Phones and screen sizes

Proposal files are never edited. Three things happen around them:

- **Shrink to fit.** As the hub serves a page, it adds a small script (`public/fit.js`). If the page's real content is wider than the screen, the whole page is scaled down to fit, so nothing is cut off and nobody scrolls sideways. On phones and tablets this uses the browser's own zoom-out, like a desktop website on a phone, so readers can still pinch to zoom in. On computers it uses CSS zoom. Pages that already fit are left exactly as built. Decorative shapes that bleed off the edge, sliders and scrolling tables don't count as "too wide". Pages missing the standard mobile viewport tag get it added. Set `PROPOSAL_FIT=false` to turn shrinking off.
- **Screen check.** Right after an upload, the hub loads the proposal at phone (390px), tablet (768px), laptop (1280px) and desktop (1440px) width in the uploader's browser and saves the result. Proposals get a **Phone ready** badge when they fit every size as built, or **Needs fitting** when the hub has to shrink them somewhere, with the widest element named for the designer. **Check again** re-runs it.
- **Preview.** The preview on each proposal's page switches between Phone, Tablet, Laptop and Desktop, laid out at each device's real width, and says whether it fits or how much it's shrunk.

Shrinking keeps the design but makes text smaller on phones. For a proper phone layout, the proposal itself needs one: the standard viewport tag plus layout rules for narrow screens. Hub previews and checks aren't counted as client views.

### If a link leaks

Anyone on the whitelist opens the proposal and clicks **Retire link** (top right, red). Nothing is deleted: the proposal, its files, stats and history stay in the hub. In one step:

- the link stops working for everyone it was sent or forwarded to, and shows "This link has been disabled"
- the password is cleared, signing out anyone who already opened it
- the link name is retired for good, so the leaked address can never point at anything again
- the proposal shows as team only, marked **Link retired** with who did it, when and the reason

To share it again, set a new link name and password under **Client access**. Deleting a proposal while it's shared also retires its link name. Copies someone already downloaded or screenshotted can't be recalled.

A retired link name can be freed in the Supabase SQL Editor (rarely wise after a leak):

```sql
delete from public.retired_link_names where link_name = 'the-name';
```

## 5. Deploy to Vercel

1. Import the GitHub repo in Vercel.
2. Add the environment variables from `.env.example`: `NEXT_PUBLIC_SITE_URL` (your production URL), the four `ODOO_*` values, `HUB_WHITELIST` and `HUB_SECRET`. Point `HUB_MEMBERS_FILE` at the member list if the host doesn't put it at `./members.txt`.
3. Deploy, then set the Supabase Site URL to the production URL (step 1.3).

The sign-in and password rate limits are kept in memory per server instance. That is fine at team scale; if traffic grows, move them to Postgres or Redis.

---

## How access works

| Level | Who can open it |
|---|---|
| **Team only** (default for new uploads) | Signed-in members only |
| **Client link + password** | Anyone with `/prezlab/<link-name>` who enters the password. Stays unlocked in that browser for 30 days, or until the password changes |
| **Public link** | Anyone with `/prezlab/<link-name>`. Ready for a future public showcase page |

Members can open any proposal, including ones without a link name (at `/prezlab/<proposal-id>`).

Passwords are stored encrypted with `HUB_SECRET`, so people on the whitelist can read them back but a copy of the database can't. Wrong-password attempts are rate limited. Changing a password signs out everyone who used the old one.

The database enforces the same rules through Row Level Security (members read, the whitelist writes), so they hold even if someone calls Supabase directly.

**Isolation:** when a signed-in team member opens a proposal, it's served in a sandbox so scripts inside it can't read team login cookies. Clients have no team cookies, so their view isn't sandboxed, which keeps images and styles loading in every browser. If a proposal relies on `localStorage` or cookies and breaks for the team, set `PROPOSAL_SANDBOX=false` (less isolated) or remove that dependency from the proposal.

## Analytics

The server injects `public/tracker.js` into every proposal it serves (your HTML files are never modified). It records into `proposal_events`:

| Event | Data |
|---|---|
| `view` | viewport and page size, referrer, country (on Vercel), visitor ID (1-year cookie) |
| `click` | page coordinates (absolute and relative), CSS selector, element text, link URL |
| `scroll` | each new 10% depth milestone |
| `heartbeat` | every 15s while the tab is visible (active reading time) |
| `leave` | final reading time and max scroll depth |

Views by signed-in team members are flagged `is_internal` and excluded from all stats. The detail page shows views, unique visitors, average time, average scroll depth, most-clicked elements and recent views.

**Heatmaps next step:** click events already store `xr`/`yr` (position relative to page size) and `selector`, which is what a heatmap overlay needs. The overlay is a team-only page that loads the proposal in an iframe and paints the click points on top.

**Privacy:** because this tracks client behavior, add a line to your proposal footer or engagement terms noting that views are measured, and check it against the data protection rules for each market (UAE PDPL, KSA PDPL, Qatar PDPPL). Confirm the wording with counsel.
