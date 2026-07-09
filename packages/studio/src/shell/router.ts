/**
 * History-API tab routing (PRINCIPLES N4).
 *
 * Deliberately dependency-free: no react-router. The active tab lives in the
 * URL pathname under the app base (`/firestore`, `/__pyric/ui/traffic`, …) so
 * it survives reload and is shareable. Navigation writes `history.pushState`
 * and dispatches one app-local event; `popstate` keeps state in sync with
 * back/forward. This module is the ONE history facade — the shell router and
 * the data-feature nav both write through it so they never fight.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { parsePath, serializePath, type ParsedPath } from './path.js';

/** Fired after every programmatic pushState/replaceState so same-document
 *  subscribers re-read the location (popstate only covers back/forward). */
const NAV_EVENT = 'pyric:studio:navigated';

const EMPTY: ParsedPath = { tab: '', rest: [], query: {} };

/** The raw location key (`pathname + search`); the store's change signal. */
export function locationKey(): string {
  return typeof window !== 'undefined'
    ? window.location.pathname + window.location.search
    : '';
}

/** Parse the current location into the routed shape. */
export function currentPath(): ParsedPath {
  if (typeof window === 'undefined') return EMPTY;
  return parsePath(window.location.pathname, window.location.search);
}

/** The hub is the app base itself (`/`, `/__pyric/ui/` — specs/home.md URL
 *  states), so the `home` tab serializes to an empty first segment. */
function canonical<T extends { tab: string }>(input: T): T {
  return input.tab === 'home' ? { ...input, tab: '' } : input;
}

/** Serialize a routed target to an href (for `<a href>` — shareable URLs). */
export function hrefFor(input: {
  tab: string;
  rest?: readonly string[];
  query?: Record<string, string | undefined | null>;
}): string {
  return serializePath(canonical(input));
}

function notify(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NAV_EVENT));
}

/** Navigate: push a routed target onto the history stack. */
export function pushPath(input: Parameters<typeof hrefFor>[0]): void {
  if (typeof window === 'undefined') return;
  const url = hrefFor(input);
  if (locationKey() === url) return;
  window.history.pushState(null, '', url);
  notify();
}

/** Normalise: replace the current entry (no new history entry). */
export function replacePath(input: Parameters<typeof hrefFor>[0]): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState(null, '', hrefFor(input));
  notify();
}

/** Subscribe to location changes: back/forward AND programmatic navigation. */
export function subscribeToLocation(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('popstate', cb);
  window.addEventListener(NAV_EVENT, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(NAV_EVENT, cb);
  };
}

/**
 * Two-way bind a tab id to the URL pathname.
 *
 * @param valid    Known tab ids; an unknown/empty path resolves to `fallback`.
 * @param fallback The default tab when the path is missing or unrecognised.
 */
export function useRoute(
  valid: readonly string[],
  fallback: string,
): readonly [string, (id: string) => void] {
  const resolve = useCallback(
    (raw: string) => (valid.includes(raw) ? raw : fallback),
    [valid, fallback],
  );

  const active = useSyncExternalStore(
    subscribeToLocation,
    () => resolve(currentPath().tab),
    () => fallback,
  );

  // Normalise on mount:
  //  - a legacy `#<tab>/<rest>?<query>` deep link migrates to the pathname
  //    (old shared URLs keep working across the hash → History-API cutover);
  //  - an unknown/empty path rewrites to the fallback so the URL reflects
  //    what's rendered. Both use replaceState — no junk history entries.
  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    if (hash.length > 1) {
      const h = hash.slice(1);
      const qIdx = h.indexOf('?');
      const legacy = parsePath(
        `/${qIdx === -1 ? h : h.slice(0, qIdx)}`,
        qIdx === -1 ? '' : h.slice(qIdx),
        '/',
      );
      if (valid.includes(legacy.tab)) {
        replacePath(legacy);
        return;
      }
    }
    // An EMPTY tab is already canonical (the base URL IS the hub); only a
    // non-empty unknown tab rewrites to the fallback.
    const cur = currentPath();
    if (cur.tab !== '' && !valid.includes(cur.tab)) {
      replacePath({ tab: resolve(cur.tab), query: { lens: cur.query.lens } });
    }
    // Run once on mount; `resolve` is stable for a given valid/fallback pair.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolve]);

  // Navigate by pushing the path. Switching tabs clears the previous tab's
  // in-service `rest` but preserves the lens query (a console-wide parameter,
  // not per-view).
  const navigate = useCallback(
    (id: string) => {
      const next = resolve(id);
      if (next === active) return;
      pushPath({ tab: next, query: { lens: currentPath().query.lens } });
    },
    [resolve, active],
  );

  return [active, navigate] as const;
}
