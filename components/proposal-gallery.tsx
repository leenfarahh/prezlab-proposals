"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  STATUSES,
  VISIBILITIES,
  VISIBILITY_LABEL,
  type Proposal,
  type Status,
  type ViewCount,
  type Visibility,
} from "@/lib/types";
import { FitBadge, StatusBadge, VisibilityBadge } from "./badges";
import { currentFitCheck, fitVerdict } from "@/lib/fit";
import { CopyButton } from "./copy-link-button";
import { formatDate } from "@/lib/format";
import { viewerPath } from "@/lib/links";

export function ProposalGallery({
  proposals,
  counts,
}: {
  proposals: Proposal[];
  counts: Record<string, ViewCount>;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status | "all">("all");
  const [visibility, setVisibility] = useState<Visibility | "all">("all");
  const [tag, setTag] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const allTags = useMemo(
    () => Array.from(new Set(proposals.flatMap((p) => p.tags))).sort(),
    [proposals],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return proposals.filter((p) => {
      if (!showArchived && status !== "archived" && p.status === "archived") return false;
      if (status !== "all" && p.status !== status) return false;
      if (visibility !== "all" && p.visibility !== visibility) return false;
      if (tag && !p.tags.includes(tag)) return false;
      if (!q) return true;
      return [p.title, p.client, p.description, p.link_name, p.uploaded_by_name, p.uploaded_by_email, ...p.tags]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [proposals, query, status, visibility, tag, showArchived]);

  return (
    <>
      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="Search title, client, tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value as Status | "all")}>
          <option value="all">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as Visibility | "all")}
        >
          <option value="all">All access levels</option>
          {VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {VISIBILITY_LABEL[v]}
            </option>
          ))}
        </select>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      {allTags.length > 0 && (
        <div className="tag-row">
          <button className={`chip ${tag === null ? "chip-active" : ""}`} onClick={() => setTag(null)}>
            All
          </button>
          {allTags.map((t) => (
            <button
              key={t}
              className={`chip ${tag === t ? "chip-active" : ""}`}
              onClick={() => setTag(tag === t ? null : t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="empty">
          {proposals.length === 0
            ? "No proposals yet. Use Upload to add the first one."
            : "No proposals match these filters."}
        </div>
      ) : (
        <div className="grid">
          {filtered.map((p) => {
            const c = counts[p.id];
            return (
              <article key={p.id} className="card">
                <Link href={`/proposals/${p.id}`} className="card-preview" aria-label={p.title}>
                  <span className="card-initials">{initials(p.client ?? p.title)}</span>
                </Link>
                <div className="card-body">
                  <div className="card-meta">
                    <StatusBadge status={p.status} />
                    <VisibilityBadge visibility={p.visibility} />
                    {p.taken_down_at && <span className="badge badge-down">Link retired</span>}
                    <FitBadge verdict={fitVerdict(currentFitCheck(p))} />
                  </div>
                  <h3>
                    <Link href={`/proposals/${p.id}`}>{p.title}</Link>
                  </h3>
                  <p className="muted small">
                    {[p.client, formatDate(p.proposal_date)].filter(Boolean).join(" · ") || p.slug}
                  </p>
                  <p className="muted small">
                    {c ? `${c.views} views · ${c.unique_visitors} visitors` : "No external views yet"}
                  </p>
                  {(p.uploaded_by_name || p.uploaded_by_email) && (
                    <p className="muted small">
                      Uploaded by {p.uploaded_by_name ?? p.uploaded_by_email}
                      {p.uploaded_at ? ` · ${formatDate(p.uploaded_at)}` : ""}
                    </p>
                  )}
                </div>
                <div className="card-actions">
                  <a className="btn btn-sm" href={viewerPath(p)} target="_blank" rel="noreferrer">
                    Open
                  </a>
                  {p.link_name && p.visibility !== "private" && <CopyButton linkName={p.link_name} />}
                  <Link className="btn btn-sm btn-ghost" href={`/proposals/${p.id}`}>
                    Details
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

function initials(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
