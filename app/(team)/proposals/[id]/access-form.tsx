"use client";

import { useActionState, useEffect, useState } from "react";
import { VISIBILITIES, VISIBILITY_LABEL, type Visibility } from "@/lib/types";
import { clientPath, toLinkName, VIEWER_PREFIX } from "@/lib/links";
import { CopyButton } from "@/components/copy-link-button";
import { saveAccess, type ActionState } from "./actions";

const HELP: Record<Visibility, string> = {
  private: "Only the team can open it.",
  link: "The client opens the link and enters the password.",
  public: "Anyone with the link can open it. No password.",
};

// No look-alike characters (0/O, 1/l/I), so it survives being read aloud or retyped.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function AccessForm({
  id,
  visibility,
  linkName,
  client,
  password,
}: {
  id: string;
  visibility: Visibility;
  linkName: string | null;
  client: string | null;
  /** Current password, decrypted on the server. Null when none is set. */
  password: string | null;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveAccess, null);
  const [access, setAccess] = useState<Visibility>(visibility);
  const [name, setName] = useState(linkName ?? toLinkName(client ?? ""));
  const [newPassword, setNewPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (state?.ok) setNewPassword("");
  }, [state]);

  const savedLink = linkName && visibility !== "private" ? `${origin}${clientPath(linkName)}` : null;

  return (
    <form action={action} className="stack">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="has_password" value={password ? "1" : "0"} />

      <label className="field">
        <span>Who can open it</span>
        <select name="visibility" value={access} onChange={(e) => setAccess(e.target.value as Visibility)}>
          {VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {VISIBILITY_LABEL[v]}
            </option>
          ))}
        </select>
        <small className="muted help-line">{HELP[access]}</small>
      </label>

      <label className="field">
        <span>Link name</span>
        <div className="prefixed">
          <span className="muted">{VIEWER_PREFIX}/</span>
          <input
            name="link_name"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            placeholder="client-name"
            spellCheck={false}
            autoCapitalize="none"
          />
        </div>
        <small className="muted help-line">Usually the client's name. Lowercase letters, numbers and dashes.</small>
      </label>

      {access === "link" && (
        <div className="field">
          <span>Password</span>
          {password && (
            <div className="row">
              <code className="secret">{reveal ? password : "•".repeat(Math.min(password.length, 12))}</code>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setReveal(!reveal)}>
                {reveal ? "Hide" : "Show"}
              </button>
              <CopyButton text={password} label="Copy" />
            </div>
          )}
          <div className="row">
            <input
              name="password"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={password ? "New password (leave blank to keep)" : "Set a password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="grow"
            />
            <button type="button" className="btn btn-sm" onClick={() => setNewPassword(generatePassword())}>
              Generate
            </button>
          </div>
          {password && (
            <small className="muted help-line">Changing it signs out anyone using the old one.</small>
          )}
        </div>
      )}

      <div className="row">
        <button className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save access"}
        </button>
        {state && <span className={state.ok ? "success-inline" : "alert-inline"}>{state.message}</span>}
      </div>

      {savedLink && (
        <div className="share-box">
          <p className="small mono break">{savedLink}</p>
          <div className="row">
            <CopyButton text={savedLink} label="Copy link" />
            {visibility === "link" && password && (
              <CopyButton
                text={`Link: ${savedLink}\nPassword: ${password}`}
                label="Copy link + password"
                className="btn btn-sm btn-primary"
              />
            )}
          </div>
        </div>
      )}
    </form>
  );
}
