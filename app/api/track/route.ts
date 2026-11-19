import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVENT_TYPES, type EventType } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_EVENTS_PER_REQUEST = 50;
const MAX_DATA_BYTES = 2048;

// Small in-memory cache: share token -> proposal id (per server instance).
const tokenCache = new Map<string, { id: string | null; expires: number }>();

interface IncomingEvent {
  type: EventType;
  data?: Record<string, unknown>;
  path?: string;
}

interface Payload {
  token: string;
  visitorId: string;
  sessionId: string;
  internal?: boolean;
  referrer?: string;
  events: IncomingEvent[];
}

/**
 * Receives batched events from /tracker.js (sent with navigator.sendBeacon).
 * Body is text/plain JSON so sandboxed pages can send it without a CORS preflight.
 */
export async function POST(request: NextRequest) {
  let payload: Payload;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  if (!isValidPayload(payload)) return new NextResponse(null, { status: 400 });

  const proposalId = await resolveProposalId(payload.token);
  if (!proposalId) return new NextResponse(null, { status: 404 });

  const country =
    request.headers.get("x-vercel-ip-country") ?? request.headers.get("cf-ipcountry") ?? null;
  const userAgent = request.headers.get("user-agent")?.slice(0, 400) ?? null;

  const rows = payload.events
    .slice(0, MAX_EVENTS_PER_REQUEST)
    .filter((e) => EVENT_TYPES.includes(e.type))
    .map((e) => ({
      proposal_id: proposalId,
      session_id: payload.sessionId.slice(0, 64),
      visitor_id: payload.visitorId.slice(0, 64),
      type: e.type,
      is_internal: Boolean(payload.internal),
      data: clampData(e.data),
      page_path: typeof e.path === "string" ? e.path.slice(0, 300) : null,
      referrer: typeof payload.referrer === "string" ? payload.referrer.slice(0, 500) : null,
      user_agent: userAgent,
      country,
    }));

  if (rows.length) {
    const { error } = await createAdminClient().from("proposal_events").insert(rows);
    if (error) {
      console.error("track insert failed", error.message);
      return new NextResponse(null, { status: 500 });
    }
  }

  return new NextResponse(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
}

function isValidPayload(p: unknown): p is Payload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.token === "string" &&
    /^[a-f0-9]{16,64}$/i.test(o.token) &&
    typeof o.visitorId === "string" &&
    typeof o.sessionId === "string" &&
    Array.isArray(o.events)
  );
}

function clampData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const json = JSON.stringify(data);
  return json.length > MAX_DATA_BYTES ? { truncated: true } : (data as Record<string, unknown>);
}

async function resolveProposalId(token: string): Promise<string | null> {
  const cached = tokenCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.id;

  const { data } = await createAdminClient()
    .from("proposals")
    .select("id, visibility")
    .eq("share_token", token)
    .maybeSingle();

  const id = data?.id ?? null;
  tokenCache.set(token, { id, expires: Date.now() + 60_000 });
  return id;
}
