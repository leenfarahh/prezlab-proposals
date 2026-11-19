"use client";

import { useEffect, useRef, useState } from "react";
import { DEVICES, isFitReport, shrinkPercent, type DeviceKey, type FitReport } from "@/lib/fit";

// Space around phone and tablet frames, in screen pixels.
const PAD = 16;

/**
 * The proposal as it looks on each screen size. The frame is laid out at the
 * device's real width (so the proposal's own layout rules and the hub's
 * fit-to-screen apply exactly as on that device), then scaled to fit the panel.
 * Switching size resizes the same frame; nothing reloads.
 */
export function DevicePreview({ src, title }: { src: string; title: string }) {
  const [deviceKey, setDeviceKey] = useState<DeviceKey>("desktop");
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [report, setReport] = useState<FitReport | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setBox({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source === frame.current?.contentWindow && isFitReport(e.data)) setReport(e.data);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const device = DEVICES.find((d) => d.key === deviceKey) ?? DEVICES[DEVICES.length - 1];
  const handheld = device.key === "phone" || device.key === "tablet";
  const pad = handheld ? PAD : 0;
  const scale = box.w ? Math.min(1, (box.w - pad * 2) / device.width) : 1;
  const available = box.h ? Math.max(240, (box.h - pad * 2) / scale) : device.height;
  // Phones and tablets keep their own height; laptop and desktop fill the panel.
  const frameHeight = Math.round(handheld ? Math.min(device.height, available) : available);

  // A report belongs to this size only if it was measured at this width
  // (allowing for a desktop scrollbar).
  const current = report && Math.abs(report.viewport - device.width) <= 24 ? report : null;
  const status = !current
    ? `${device.width}px`
    : current.fits
      ? `${device.width}px · fits as built`
      : current.scale < 1
        ? `${device.width}px · shrunk to ${shrinkPercent({ width: device.width, content: current.content })}% to fit`
        : `${device.width}px · wider than the screen`;

  return (
    <section className="preview-frame">
      <div className="preview-bar">
        <div className="segmented" role="group" aria-label="Preview screen size">
          {DEVICES.map((d) => (
            <button
              key={d.key}
              type="button"
              aria-pressed={d.key === deviceKey}
              onClick={() => {
                setDeviceKey(d.key);
                setReport(null);
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
        <span className={`small ${current && !current.fits ? "fit-warn" : "muted"}`}>{status}</span>
      </div>
      <div className="preview-stage" ref={stage}>
        <div
          className={`preview-device${handheld ? " is-handheld" : ""}`}
          style={{ width: device.width * scale, height: frameHeight * scale, top: pad }}
        >
          <iframe
            ref={frame}
            src={src}
            title={title}
            style={{ width: device.width, height: frameHeight, transform: `scale(${scale})` }}
          />
        </div>
      </div>
    </section>
  );
}
