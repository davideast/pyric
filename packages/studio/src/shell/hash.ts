/**
 * Studio URL-hash codec — the hash is the single source of truth for navigation.
 *
 *   #<tab>[/<rest>/<rest>...][?key=val&key=val]
 *
 *   tab    the shell RouteId (first path segment); `router.ts` routes on it.
 *   rest   in-service location: a Firestore doc/collection path, a Storage
 *          object path, or an Auth uid. `features/data/navigation.tsx` maps it.
 *   query  cross-cutting state preserved across navigations: `lens` (admin vs
 *          app-session) and `denial` (the Rules surface focus).
 *
 * One codec shared by the shell tab router and the data-feature nav, so they
 * agree on the format. Each path segment is URL-encoded so doc ids / object
 * paths with slashes or spaces round-trip.
 */
export interface ParsedHash {
  tab: string;
  rest: string[];
  query: Record<string, string>;
}

function currentHash(): string {
  return typeof window !== 'undefined' ? window.location.hash : '';
}

export function parseHash(raw: string = currentHash()): ParsedHash {
  const h = raw.replace(/^#/, '');
  const qIdx = h.indexOf('?');
  const pathPart = qIdx === -1 ? h : h.slice(0, qIdx);
  const queryPart = qIdx === -1 ? '' : h.slice(qIdx + 1);
  const segs = pathPart
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  const [tab = '', ...rest] = segs;
  const query: Record<string, string> = {};
  for (const pair of queryPart.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    if (k) query[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return { tab, rest, query };
}

export function serializeHash(input: {
  tab: string;
  rest?: readonly string[];
  query?: Record<string, string | undefined | null>;
}): string {
  const path = [input.tab, ...(input.rest ?? [])]
    .filter((s): s is string => s != null && s !== '')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const query = Object.entries(input.query ?? {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `#${path}${query ? `?${query}` : ''}`;
}
