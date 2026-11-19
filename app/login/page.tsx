import { LoginForm } from "./login-form";

const ERRORS: Record<string, string> = {
  not_team: "That account isn't on the Prezlab team. Sign in with your Prezlab Odoo account.",
  link_expired: "That sign-in link has expired or was already used. Sign in again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <main className="login">
      <div className="login-card">
        <p className="eyebrow">Prezlab</p>
        <h1>Proposals Hub</h1>
        <p className="muted">Use the same login and password you use for Odoo.</p>
        {error && ERRORS[error] && <p className="alert">{ERRORS[error]}</p>}
        <LoginForm next={next} />
      </div>
    </main>
  );
}
