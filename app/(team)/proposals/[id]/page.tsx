import Link from "next/link";
import { notFound } from "next/navigation";
import { getHubUser } from "@/lib/supabase/server";
import { VISIBILITY_LABEL, type Proposal, type ProposalActivity, type ProposalEvent, type ProposalStats } from "@/lib/types";
import { FitBadge, StatusBadge, VisibilityBadge } from "@/components/badges";
import { DevicePreview } from "@/components/device-preview";
import { currentFitCheck, fitVerdict } from "@/lib/fit";
import { env } from "@/lib/env";
import { CopyButton } from "@/components/copy-link-button";
import { UploadForm } from "@/components/upload-form";
import { formatDate, formatDateTime, formatSeconds } from "@/lib/format";
import { openPassword } from "@/lib/access";
import { clientPath, viewerPath } from "@/lib/links";
import { EditForm } from "./edit-form";
import { AccessForm } from "./access-form";
import { TakedownButton } from "./takedown-button";
import { ScreenCheck } from "./screen-check";
import { deleteProposal } from "./actions";

export const dynamic = "force-dynamic";

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, isEditor } = await getHubUser();

  const [{ data: proposal }, { data: statsRows }, { data: recentViews }, { data: clicks }, { data: activity }] =
    await Promise.all([
      supabase.from("proposals").select("*").eq("id", id).maybeSingle(),
      supabase.rpc("proposal_stats", { p_id: id }),
      supabase
        .from("proposal_events")
        .select("created_at, country, referrer, visitor_id")
        .eq("proposal_id", id)
        .eq("type", "view")
        .eq("is_internal", false)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("proposal_events")
        .select("session_id, data")
        .eq("proposal_id", id)
        .eq("type", "click")
        .eq("is_internal", false)
        .order("created_at", { ascending: false })
        .limit(5000),
      supabase
        .from("proposal_activity")
        .select("*")
        .eq("proposal_id", id)
        .order("created_at", { ascending: false })
        .limit(30),
    ]);

  if (!proposal) notFound();
  const p = proposal as Proposal;
  const stats = (statsRows as ProposalStats[] | null)?.[0];
  const ctr = clickThrough((clicks ?? []) as ClickRow[], stats?.views ?? 0);
  const openPath = viewerPath(p);
  // Hub previews and checks: same page, not counted as views.
  const previewSrc = `${openPath}?pz-preview=1`;
  const fitCheck = currentFitCheck(p);
  const uploader = p.uploaded_by_name ?? p.uploaded_by_email;

  return (
    <>
      <Link href="/" className="back">
        ← All proposals
      </Link>

      <div className="page-head">
        <div>
          <div className="card-meta">
            <StatusBadge status={p.status} />
            <VisibilityBadge visibility={p.visibility} />
            {p.taken_down_at && <span className="badge badge-down">Link retired</span>}
            <FitBadge verdict={fitVerdict(fitCheck)} />
          </div>
          <h1>{p.title}</h1>
          <p className="muted">
            {[
              p.client,
              formatDate(p.proposal_date),
              uploader ? `Uploaded by ${uploader}${p.uploaded_at ? ` on ${formatDate(p.uploaded_at)}` : ""}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="row">
          <a className="btn" href={openPath} target="_blank" rel="noreferrer">
            Open full screen
          </a>
          {p.link_name && p.visibility !== "private" && (
            <CopyButton linkName={p.link_name} label="Copy client link" className="btn btn-primary" />
          )}
          {isEditor && p.link_name && <TakedownButton id={p.id} linkName={p.link_name} />}
        </div>
      </div>

      {p.taken_down_at && (
        <div className="banner-danger" role="status">
          <strong>Link retired</strong> on {formatDateTime(p.taken_down_at)}
          {p.taken_down_by_name || p.taken_down_by_email ? ` by ${p.taken_down_by_name ?? p.taken_down_by_email}` : ""}
          {p.takedown_reason ? `: ${p.takedown_reason}` : "."}{" "}
          {p.takedown_link_name && (
            <>
              <code>{clientPath(p.takedown_link_name)}</code> no longer works.{" "}
            </>
          )}
          {isEditor && "To share again, set a new link name and password under Client access."}
        </div>
      )}

      <div className="detail">
        <DevicePreview src={previewSrc} title={p.title} />

        <aside className="stack-lg">
          <section className="panel">
            <h2>Client access</h2>
            {isEditor ? (
              <AccessForm
                id={p.id}
                visibility={p.visibility}
                linkName={p.link_name}
                client={p.taken_down_at ? null : p.client}
                password={openPassword(p.sealed_password)}
              />
            ) : (
              <>
                <ul className="list">
                  <li>
                    <span>Who can open it</span>
                    <span className="muted">{VISIBILITY_LABEL[p.visibility]}</span>
                  </li>
                  {p.link_name && p.visibility !== "private" && (
                    <li>
                      <span>Client link</span>
                      <code>{clientPath(p.link_name)}</code>
                    </li>
                  )}
                </ul>
                <p className="muted small">
                  {p.visibility === "link"
                    ? "Ask someone on the hub's whitelist for the password, or to change access."
                    : "Only people on the hub's whitelist can change access."}
                </p>
              </>
            )}
          </section>

          <section className="panel">
            <h2>Screen check</h2>
            <ScreenCheck
              id={p.id}
              prefix={p.storage_prefix}
              src={previewSrc}
              check={fitCheck}
              isEditor={isEditor}
              fitEnabled={env.fitProposals()}
            />
          </section>

          <section className="panel">
            <h2>Engagement</h2>
            <p className="muted small">External visitors only. Team views are excluded.</p>
            <div className="stats">
              <Stat label="Views" value={stats?.views ?? 0} />
              <Stat label="Visitors" value={stats?.unique_visitors ?? 0} />
              <Stat label="Avg. time" value={formatSeconds(stats?.avg_seconds)} />
              <Stat
                label="Avg. scroll"
                value={stats?.avg_scroll_depth != null ? `${stats.avg_scroll_depth}%` : "–"}
              />
              <Stat label="Click-through" value={ctr.rate != null ? `${ctr.rate}%` : "–"} />
              <Stat label="Last viewed" value={formatDate(stats?.last_viewed_at) || "–"} />
            </div>

            {ctr.items.length > 0 && (
              <>
                <h3>Click-through by link</h3>
                <p className="muted small">Share of views where the visitor clicked it. Only links and buttons count.</p>
                <ol className="list">
                  {ctr.items.map((c) => (
                    <li key={c.key}>
                      <span className="truncate" title={c.key}>
                        {c.label}
                      </span>
                      <span className="muted nowrap">
                        {c.rate != null ? `${c.rate}%` : "–"} · {c.clicks} click{c.clicks === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            )}

            {recentViews && recentViews.length > 0 && (
              <>
                <h3>Recent views</h3>
                <ol className="list">
                  {recentViews.map((v, i) => (
                    <li key={i}>
                      <span>{formatDateTime(v.created_at)}</span>
                      <span className="muted">
                        {[v.country, host(v.referrer)].filter(Boolean).join(" · ") || "Direct"}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>

          <section className="panel">
            <h2>Details</h2>
            {isEditor ? (
              <EditForm proposal={p} />
            ) : (
              <ul className="list">
                <li>
                  <span>Tags</span>
                  <span className="muted">{p.tags.length ? p.tags.join(", ") : "None"}</span>
                </li>
                {p.description && (
                  <li>
                    <span className="muted">{p.description}</span>
                  </li>
                )}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>Files</h2>
            <p className="muted small">
              {p.file_count} file{p.file_count === 1 ? "" : "s"} · opens <code>{p.entry_file}</code>
              {p.created_by_name || p.created_by_email
                ? ` · first uploaded by ${p.created_by_name ?? p.created_by_email}`
                : ""}
            </p>
            {isEditor && <UploadForm proposalId={p.id} />}
          </section>

          <section className="panel">
            <h2>History</h2>
            {activity && activity.length > 0 ? (
              <ol className="list">
                {(activity as ProposalActivity[]).map((a) => (
                  <li key={a.id}>
                    <span>
                      <strong>{a.actor_name ?? a.actor_email ?? "System"}</strong> {describe(a)}
                    </span>
                    <span className="muted nowrap">{formatDateTime(a.created_at)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted small">No changes recorded yet.</p>
            )}
          </section>

          {isEditor && (
            <section className="panel">
              <h2>Delete</h2>
              <p className="muted small">
                Removes the proposal, its files and its view statistics. If it's shared, its link stops
                working and the link name is retired. This can't be undone. For a leaked link, use Retire link
                instead: it keeps the proposal.
              </p>
              <form action={deleteProposal}>
                <input type="hidden" name="id" value={p.id} />
                <button className="btn btn-sm btn-danger">Delete proposal</button>
              </form>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

const ACCESS_WORDS: Record<string, string> = {
  private: "team only",
  link: "client link + password",
  public: "public link",
};

function describe(a: ProposalActivity): string {
  const d = a.details as Record<string, unknown>;
  switch (a.action) {
    case "uploaded":
      return `uploaded it (${d.files ?? "?"} files)`;
    case "replaced_files":
      return `uploaded a new version (${d.files ?? "?"} files)`;
    case "changed_access":
      return `changed access to ${ACCESS_WORDS[String(d.to)] ?? d.to}`;
    case "changed_link":
      return d.to ? `set the link name to ${d.to}` : "removed the link name";
    case "changed_password":
      return "changed the password";
    case "updated_details":
      return `edited ${Array.isArray(d.fields) ? d.fields.join(", ") : "details"}`;
    case "deleted":
      return "deleted it";
    case "taken_down":
      return `retired ${d.link ? clientPath(String(d.link)) : "the link"}${d.reason ? ` (${d.reason})` : ""}`;
  }
}

type ClickRow = Pick<ProposalEvent, "session_id" | "data">;

// Elements a visitor clicks on purpose. The tracker also records clicks on plain
// text and images; those count for heatmaps but not for click-through.
const INTERACTIVE = new Set(["a", "button", "input", "select", "summary"]);

/**
 * Click-through = share of views (page loads) where the visitor clicked at
 * least once: overall, and per link or button. Repeat clicks in the same view
 * count once toward the rate and in full toward the click total.
 */
function clickThrough(events: ClickRow[], views: number) {
  const percent = (sessions: number) => (views > 0 ? Math.min(100, Math.round((sessions / views) * 100)) : null);
  const clickedViews = new Set<string>();
  const map = new Map<string, { key: string; label: string; clicks: number; sessions: Set<string> }>();

  for (const e of events) {
    const d = e.data as { href?: string | null; text?: string | null; selector?: string | null; tag?: string | null };
    if (!d.href && !INTERACTIVE.has(d.tag ?? "")) continue;
    const key = d.href || d.selector || "";
    if (!key) continue;
    clickedViews.add(e.session_id);
    const label = d.text ? `${d.text}${d.href ? ` → ${host(d.href) || d.href}` : ""}` : key;
    const entry = map.get(key) ?? { key, label, clicks: 0, sessions: new Set<string>() };
    entry.clicks += 1;
    entry.sessions.add(e.session_id);
    map.set(key, entry);
  }

  const items = [...map.values()]
    .sort((a, b) => b.sessions.size - a.sessions.size || b.clicks - a.clicks)
    .slice(0, 10)
    .map((c) => ({ key: c.key, label: c.label, clicks: c.clicks, rate: percent(c.sessions.size) }));

  return { rate: percent(clickedViews.size), items };
}

function host(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
