/**
 * Studio URL codec — clean History-API pathname routing (PRINCIPLES N4).
 *
 *   <base><tab>[/<rest>/<rest>...][?key=val&key=val]
 *
 *   base   the Vite app base (`import.meta.env.BASE_URL`): `/` in dev and the
 *          review build, `/__pyric/ui/` when packaged into `pyric dev --ui`.
 *   tab    the shell RouteId (first path segment); `router.ts` routes on it.
 *   rest   in-service location: a Firestore doc/collection path, a Storage
 *          object path, or an Auth uid. `features/data/navigation.tsx` maps it.
 *   query  per-surface state: `inspect` (the Traffic rules-inspector focus). There is
 *          no lens param — data views are always admin (M2/M3).
 *
 * This ports the hash codec's shape (`#<tab>/<rest>?<query>`) verbatim; only
 * the transport changed from `location.hash` to `pathname` + `search`. One
 * codec shared by the shell tab router and the data-feature nav, so they agree
 * on the format. Each path segment is URL-encoded so doc ids / object paths
 * with slashes or spaces round-trip.
 */

export interface ParsedPath {
  tab: string;
  rest: string[];
  query: Record<string, string>;
}

/** The app base path, always with a trailing slash (`/`, `/__pyric/ui/`). */
export function appBase(): string {
  const raw =
    (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function parseQuery(queryPart: string): Record<string, string> {
  const query: Record<string, string> = {};
  for (const pair of queryPart.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    if (k) query[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return query;
}

/**
 * Parse a pathname + search into the routed shape. `pathname` outside `base`
 * parses best-effort from the root (the router then normalises to Home).
 */
export function parsePath(
  pathname: string,
  search = '',
  base: string = appBase(),
): ParsedPath {
  let inApp = pathname;
  const trimmedBase = base.replace(/\/$/, '');
  if (base !== '/' && (pathname === trimmedBase || pathname.startsWith(base))) {
    inApp = pathname.slice(trimmedBase.length);
  }
  const segs = inApp
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  const [tab = '', ...rest] = segs;
  return { tab, rest, query: parseQuery(search) };
}

/**
 * Serialize the routed shape to a `pathname + search` URL string under `base`.
 * Empty/nullish query values are dropped.
 */
export function serializePath(
  input: {
    tab: string;
    rest?: readonly string[];
    query?: Record<string, string | undefined | null>;
  },
  base: string = appBase(),
): string {
  const path = [input.tab, ...(input.rest ?? [])]
    .filter((s): s is string => s != null && s !== '')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const query = Object.entries(input.query ?? {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${base}${path}${query ? `?${query}` : ''}`;
}
