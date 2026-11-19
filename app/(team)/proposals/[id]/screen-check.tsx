"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEVICES,
  MAX_FIT_WIDTH,
  fitVerdict,
  isFitReport,
  shrinkPercent,
  type DeviceKey,
  type FitCheck,
  type FitDeviceResult,
  type FitReport,
} from "@/lib/fit";
import { saveFitCheck } from "./actions";

// How long a page gets to load and settle at one size before it's marked "not checked".
const TIMEOUT_MS = 30_000;
// Height of the small live screens shown while checking.
const THUMB_HEIGHT = 70;

/**
 * Checks the proposal at phone, tablet, laptop and desktop width, in this
 * browser: each size loads the proposal in a small frame of that width, and
 * public/fit.js reports whether the content fits. Runs by itself for people on
 * the whitelist when the current files haven't been checked (right after an
 * upload, for example), and saves the result on the proposal.
 */
export function ScreenCheck({
  id,
  prefix,
  src,
  check,
  isEditor,
  fitEnabled,
}: {
  id: string;
  prefix: string;
  /** The proposal's viewer URL with ?pz-preview, so checks aren't tracked as views. */
  src: string;
  /** The saved check for the current files, if any. */
  check: FitCheck | null;
  isEditor: boolean;
  /** PROPOSAL_FIT: whether the hub shrinks pages that don't fit. */
  fitEnabled: boolean;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frames = useRef<Partial<Record<DeviceKey, HTMLIFrameElement | null>>>({});
  const waiting = useRef(new Map<DeviceKey, (report: FitReport | null) => void>());
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!isFitReport(e.data) || !e.data.final) return;
      for (const d of DEVICES) {
        if (frames.current[d.key]?.contentWindow === e.source) waiting.current.get(d.key)?.(e.data);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    const devices = await Promise.all(
      DEVICES.map(
        (d) =>
          new Promise<FitDeviceResult>((resolve) => {
            const finish = (r: FitReport | null) => {
              waiting.current.delete(d.key);
              clearTimeout(timer);
              resolve(
                r
                  ? { device: d.key, width: d.width, content: r.content, fits: r.fits, culprit: r.culprit }
                  : { device: d.key, width: d.width, content: 0, fits: false, culprit: null, failed: true },
              );
            };
            const timer = setTimeout(() => finish(null), TIMEOUT_MS);
            waiting.current.set(d.key, finish);
          }),
      ),
    );
    const saved = await saveFitCheck({ id, prefix, devices }).catch((e: Error) => ({ ok: false, message: e.message }));
    setRunning(false);
    if (!saved?.ok) setError(saved?.message ?? "Couldn't save the check.");
    else router.refresh();
  }, [id, prefix, router]);

  // New files with no check yet: check them now, once per upload.
  useEffect(() => {
    if (isEditor && !check && startedFor.current !== prefix) {
      startedFor.current = prefix;
      void run();
    }
  }, [isEditor, check, prefix, run]);

  const verdict = fitVerdict(check);
  const widest = check?.devices.find((d) => !d.fits && !d.failed && d.culprit);

  return (
    <div className="stack">
      {running ? (
        <>
          <p className="muted small">Checking on four screen sizes…</p>
          <div className="fit-thumbs" aria-hidden="true">
            {DEVICES.map((d) => {
              const s = THUMB_HEIGHT / d.height;
              return (
                <div key={d.key} className="fit-thumb">
                  <div className="fit-thumb-screen" style={{ width: Math.round(d.width * s), height: THUMB_HEIGHT }}>
                    <iframe
                      ref={(el) => {
                        frames.current[d.key] = el;
                      }}
                      src={src}
                      title={`${d.label} check`}
                      tabIndex={-1}
                      style={{ width: d.width, height: d.height, transform: `scale(${s})` }}
                    />
                  </div>
                  <span>{d.label}</span>
                </div>
              );
            })}
          </div>
        </>
      ) : check ? (
        <>
          <ul className="list">
            {check.devices.map((r) => {
              const d = DEVICES.find((x) => x.key === r.device);
              return (
                <li key={r.device}>
                  <span>
                    {d?.label ?? r.device} <span className="muted">{r.width}px</span>
                  </span>
                  <span className={r.failed ? "muted" : r.fits ? "fit-ok" : "fit-warn"}>{describe(r, fitEnabled)}</span>
                </li>
              );
            })}
          </ul>
          {verdict === "ready" && (
            <p className="muted small">Adapts to every size as built. Visitors see it exactly as designed.</p>
          )}
          {verdict === "needs_fitting" && (
            <p className="muted small">
              Built wider than {check.devices.filter((r) => !r.fits && !r.failed).length === 1 ? "this screen" : "these screens"}
              {widest ? (
                <>
                  {" "}
                  (widest part: <code>{widest.culprit}</code>, {widest.content}px)
                </>
              ) : null}
              .{" "}
              {fitEnabled
                ? "The hub shrinks it to fit, so nothing is cut off and readers can pinch to zoom. For a real phone layout, the designer needs to build one."
                : "Shrink to fit is off (PROPOSAL_FIT=false), so visitors on these screens scroll sideways."}
            </p>
          )}
        </>
      ) : (
        <p className="muted small">
          {isEditor
            ? "Not checked yet."
            : "Not checked yet. It runs when someone on the hub's whitelist opens this page."}
        </p>
      )}

      {error && <p className="alert">{error}</p>}

      {isEditor && !running && (
        <div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void run()}>
            {check ? "Check again" : "Run check"}
          </button>
        </div>
      )}
    </div>
  );
}

function describe(r: FitDeviceResult, fitEnabled: boolean): string {
  if (r.failed) return "Didn't load in time";
  if (r.fits) return "Fits";
  if (r.content > MAX_FIT_WIDTH) return `Too wide to fit (${r.content}px)`;
  return fitEnabled ? `Shrunk to ${shrinkPercent(r)}%` : "Wider than the screen";
}
