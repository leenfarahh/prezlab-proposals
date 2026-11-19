"use client";

import { useEffect, useRef, useState } from "react";

const DOMAIN = process.env.NEXT_PUBLIC_TEAM_EMAIL_DOMAIN ?? "prezlab.com";

type Reply = {
  ok?: boolean;
  error?: string;
  totpRequired?: boolean;
  pendingSession?: string;
};

/**
 * Odoo sign-in with a two-factor step, ported from Image Studio's OdooSignIn.
 *
 * The password goes to the server once and is cleared the moment a code is
 * needed. The code step carries Odoo's pending session instead, so the
 * password is never held while someone opens their authenticator, and never
 * sent twice. Nothing is written to storage or the URL.
 */
export function LoginForm({ next }: { next?: string }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pendingSession, setPendingSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pendingSession) codeRef.current?.focus();
  }, [pendingSession]);

  // Same-origin paths only, so ?next= can't bounce someone to another site.
  const destination = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  async function post(body: Record<string, string>) {
    const response = await fetch("/api/auth/odoo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as Reply;
    return { response, payload };
  }

  function finish() {
    // A full navigation, so the proxy sees the new session cookies.
    window.location.assign(destination);
  }

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { response, payload } = await post({ login, password });
      if (payload.totpRequired && payload.pendingSession) {
        setPendingSession(payload.pendingSession);
        setPassword("");
        setNotice("This account has two-factor authentication enabled.");
        return;
      }
      if (!response.ok || !payload.ok) {
        setError(payload.error ?? "Sign-in failed. Try again.");
        setPassword("");
        return;
      }
      finish();
    } catch {
      setError("Could not reach the server. Check your connection and retry.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !pendingSession) return;
    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await post({ login, totpCode: code, pendingSession });
      if (!response.ok || !payload.ok) {
        setError(payload.error ?? "That code was not accepted.");
        setCode("");
        // A broken pending session can't be retried; send them back to the start.
        if (response.status >= 500) setPendingSession(null);
        return;
      }
      finish();
    } catch {
      setError("Could not reach the server. Check your connection and retry.");
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    setPendingSession(null);
    setCode("");
    setPassword("");
    setError(null);
    setNotice(null);
  }

  if (pendingSession) {
    return (
      <form onSubmit={submitCode} className="stack" noValidate>
        {notice && <p className="success">{notice}</p>}
        <label className="field">
          <span>Authenticator code</span>
          <input
            ref={codeRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={8}
            required
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
            disabled={busy}
            style={{ textAlign: "center", letterSpacing: "0.3em", fontSize: 18 }}
          />
        </label>
        <p className="muted small">
          The 6-digit code from the authenticator app you use for Odoo. This device will be
          remembered for 30 days.
        </p>
        {error && <p className="alert">{error}</p>}
        <button className="btn btn-primary" disabled={busy || code.length < 6}>
          {busy ? "Verifying…" : "Sign in"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={startOver} disabled={busy}>
          Start again with a different account
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={submitCredentials} className="stack" noValidate>
      <label className="field">
        <span>Odoo login</span>
        <input
          type="text"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          placeholder={`name@${DOMAIN}`}
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          disabled={busy}
        />
      </label>
      <label className="field">
        <span>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
      </label>
      {error && <p className="alert">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? "Checking with Odoo…" : "Sign in"}
      </button>
    </form>
  );
}
