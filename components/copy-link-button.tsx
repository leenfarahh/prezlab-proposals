"use client";

import { useState } from "react";
import { clientPath } from "@/lib/links";

/** Copies text (or the client link for a link name) and confirms briefly. */
export function CopyButton({
  linkName,
  text,
  label = "Copy link",
  className,
}: {
  linkName?: string;
  text?: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className ?? "btn btn-sm"}
      onClick={async () => {
        const value = text ?? `${window.location.origin}${clientPath(linkName ?? "")}`;
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
