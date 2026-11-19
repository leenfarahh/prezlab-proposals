import "server-only";

/**
 * Short-lived cache of proposal lookups for the viewer, so a page with 30
 * images doesn't query the database 30 times.
 *
 * Kept on globalThis so the takedown action (bundled separately from the
 * viewer route) can clear it: a taken-down link must stop working at once,
 * not when the cache expires.
 */

const KEY = "__prezlabViewerCache" as const;
type CacheGlobal = typeof globalThis & { [KEY]?: Map<string, { value: unknown; expires: number }> };

function store() {
  const g = globalThis as CacheGlobal;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY];
}

export function cacheGet<T>(key: string): T | undefined {
  const hit = store().get(key);
  return hit && hit.expires > Date.now() ? (hit.value as T) : undefined;
}

export function cacheSet(key: string, value: unknown, ttlMs: number) {
  const s = store();
  if (s.size > 500) s.clear();
  s.set(key, { value, expires: Date.now() + ttlMs });
}

export function clearViewerCache() {
  store().clear();
}
