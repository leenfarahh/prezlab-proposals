import { VISIBILITY_LABEL, type Status, type Visibility } from "@/lib/types";

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge badge-status-${status}`}>{status}</span>;
}

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  return <span className={`badge badge-vis-${visibility}`}>{VISIBILITY_LABEL[visibility]}</span>;
}

/** Screen check result for the current files. Nothing until a check has run. */
export function FitBadge({ verdict }: { verdict: "ready" | "needs_fitting" | null }) {
  if (verdict === "ready") {
    return (
      <span className="badge badge-fit-ok" title="Fits phones, tablets, laptops and desktops as built.">
        Phone ready
      </span>
    );
  }
  if (verdict === "needs_fitting") {
    return (
      <span
        className="badge badge-fit-warn"
        title="Built wider than some screens. The hub shrinks it to fit them automatically."
      >
        Needs fitting
      </span>
    );
  }
  return null;
}
