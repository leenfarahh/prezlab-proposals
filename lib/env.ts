function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: () =>
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  serviceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY),
  siteUrl: () => (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  sandboxProposals: () => process.env.PROPOSAL_SANDBOX !== "false",
  /** Shrink proposals that are wider than the screen (public/fit.js). */
  fitProposals: () => process.env.PROPOSAL_FIT !== "false",

  // Odoo sign-in (server only)
  odooUrl: () => required("ODOO_URL", process.env.ODOO_URL?.trim()).replace(/\/+$/, ""),
  odooDb: () => required("ODOO_DB", process.env.ODOO_DB?.trim()),
  /** Optional: reject Odoo accounts whose email is outside this domain. Blank allows any. */
  odooAllowedEmailDomain: () => (process.env.ODOO_ALLOWED_EMAIL_DOMAIN ?? "").trim().toLowerCase(),
};

/**
 * Values shipped in .env.example. A variable still holding one is not
 * configured, however non-empty it looks: treating it as ready sends requests
 * to a host that does not exist and surfaces as an unrelated "fetch failed".
 */
const PLACEHOLDER = /placeholder|your-|YOUR-|changeme/;

export function isConfigured(name: string): boolean {
  const value = process.env[name]?.trim();
  return Boolean(value) && !PLACEHOLDER.test(value!);
}

export function supabaseConfigured(): boolean {
  return (
    isConfigured("NEXT_PUBLIC_SUPABASE_URL") &&
    isConfigured("NEXT_PUBLIC_SUPABASE_ANON_KEY") &&
    isConfigured("SUPABASE_SERVICE_ROLE_KEY")
  );
}

export function odooConfigured(): boolean {
  return isConfigured("ODOO_URL") && isConfigured("ODOO_DB");
}

export const STORAGE_BUCKET = "proposals";
