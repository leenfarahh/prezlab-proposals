/**
 * Screen fit: the sizes every proposal is checked and previewed at, and how a
 * check result reads. Shared by the server (saving, badges) and the browser
 * (running the check, the preview). public/fit.js does the measuring.
 */

export const DEVICES = [
  { key: "phone", label: "Phone", width: 390, height: 844 },
  { key: "tablet", label: "Tablet", width: 768, height: 1024 },
  { key: "laptop", label: "Laptop", width: 1280, height: 800 },
  { key: "desktop", label: "Desktop", width: 1440, height: 900 },
] as const;

export type Device = (typeof DEVICES)[number];
export type DeviceKey = Device["key"];

/** Wider than this is a stray element, not a layout; fit.js leaves it alone. Keep in sync with fit.js. */
export const MAX_FIT_WIDTH = 2560;

/** What public/fit.js posts to the hub page from inside a preview or check frame. */
export type FitReport = {
  source: "pz-fit";
  final: boolean;
  /** Screen width the page was measured at. */
  viewport: number;
  /** Width of the widest real content, as built. */
  content: number;
  /** True when the content fits the screen without any help. */
  fits: boolean;
  /** 1 when untouched; below 1 when the hub shrank the page to fit. */
  scale: number;
  /** The widest element, e.g. "div.wrapper", when it doesn't fit. */
  culprit: string | null;
};

export function isFitReport(data: unknown): data is FitReport {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.source === "pz-fit" &&
    typeof d.viewport === "number" &&
    typeof d.content === "number" &&
    typeof d.fits === "boolean" &&
    typeof d.scale === "number"
  );
}

export type FitDeviceResult = {
  device: DeviceKey;
  width: number;
  content: number;
  fits: boolean;
  culprit: string | null;
  /** The page didn't report back in time; the size wasn't checked. */
  failed?: boolean;
};

/** Saved on the proposal. `prefix` ties the result to the files it checked. */
export type FitCheck = {
  prefix: string;
  devices: FitDeviceResult[];
};

/** The check for the proposal's current files, or null if there is none yet. */
export function currentFitCheck(p: { fit_check: FitCheck | null; storage_prefix: string }): FitCheck | null {
  return p.fit_check && p.fit_check.prefix === p.storage_prefix ? p.fit_check : null;
}

/** "ready": fits every size as built. "needs_fitting": the hub shrinks it somewhere. */
export function fitVerdict(check: FitCheck | null): "ready" | "needs_fitting" | null {
  if (!check || !check.devices.length) return null;
  const checked = check.devices.filter((d) => !d.failed);
  if (!checked.length) return null;
  return checked.every((d) => d.fits) ? "ready" : "needs_fitting";
}

/** How small the page is shown on that screen, as a whole percentage. */
export function shrinkPercent(r: { width: number; content: number }): number {
  return Math.max(1, Math.min(100, Math.round((r.width / Math.max(r.content, 1)) * 100)));
}
