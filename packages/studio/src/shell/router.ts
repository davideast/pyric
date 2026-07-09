/**
 * Hash-based tab routing (T4).
 *
 * Deliberately dependency-free: no react-router. The active tab lives in the
 * URL hash (`#data`, `#traffic`, …) so it survives reload and is shareable.
 * `useHashRoute(fallback)` returns the current tab id + a setter that updates
 * the hash; the `hashchange` listener keeps state in sync with back/forward.
 */

import { useCallback, useEffect, useState } from 'react';
import { parseHash, serializeHash } from './hash.js';

/** The active tab is the FIRST hash segment (`#firestore/users/abc` → tab
 *  `firestore`); the remaining path + query are in-service state owned by the
 *  feature (see `shell/hash.ts` / `features/data/navigation.tsx`). */
function readHash(): string {
  return parseHash().tab;
}

/**
 * Two-way bind a tab id to `location.hash`.
 *
 * @param valid    Known tab ids; an unknown/empty hash resolves to `fallback`.
 * @param fallback The default tab when the hash is missing or unrecognised.
 */
export function useHashRoute(
  valid: readonly string[],
  fallback: string,
): readonly [string, (id: string) => void] {
  const resolve = useCallback(
    (raw: string) => (valid.includes(raw) ? raw : fallback),
    [valid, fallback],
  );

  const [active, setActive] = useState<string>(() => resolve(readHash()));

  // Keep state in sync with the hash (back/forward, manual edits, deep links).
  useEffect(() => {
    const onHashChange = () => setActive(resolve(readHash()));
    window.addEventListener('hashchange', onHashChange);
    // Normalise on mount: if the hash was empty/invalid, write the fallback so
    // the URL reflects what's rendered.
    if (readHash() !== active) {
      window.location.hash = serializeHash({ tab: active, query: { lens: parseHash().query.lens } });
    }
    return () => window.removeEventListener('hashchange', onHashChange);
    // Run once on mount; `resolve` is stable for a given valid/fallback pair.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolve]);

  // Navigate by writing the hash; the listener flips `active`. Switching tabs
  // clears the previous tab's in-service `rest` but preserves the lens query
  // (a console-wide toggle, not per-view).
  const navigate = useCallback(
    (id: string) => {
      const next = resolve(id);
      if (next === active) return;
      window.location.hash = serializeHash({ tab: next, query: { lens: parseHash().query.lens } });
    },
    [resolve, active],
  );

  return [active, navigate] as const;
}
