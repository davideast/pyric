/**
 * Cross-service navigation state for the Data feature (F2).
 *
 * The three Data sub-views (Firestore / Auth / Storage) each live behind their
 * own shell tab, and a clickable cross-reference jumps *between* them (a uid →
 * the Auth user, a `gs://` path → the Storage object, a doc path → the Firestore
 * document). Navigation state is encoded in the URL hash (see `shell/hash.ts`),
 * so the active view, the in-service location, and the lens are deep-linkable,
 * survive reload and per-tab remounts, and follow browser back/forward:
 *
 *   #firestore/<collection>/<doc>/...   the drill path
 *   #auth/<uid>                         the focused user
 *   #storage/<object/path>              the focused object
 *   ?lens=app                           app-session lens (admin is the default, omitted)
 *   #rules?denial=<id>                  the Rules surface focus
 *
 * `useDataNav()` reads the hash via `useSyncExternalStore`; `navigate(...)` /
 * `setLens(...)` / `navigateDenial(...)` write it.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { parseHash, serializeHash } from '../../shell/hash.js';
import type { CrossRef } from './refs.js';
import type { DataLens } from './sandbox.js';

/** The three service sub-views the Data feature spans. */
export type DataView = 'firestore' | 'auth' | 'storage';

/** One level in the Firestore drill path: a collection or a document. `path` is
 *  cumulative (e.g. "richtypes", "richtypes/full", "richtypes/full/comments"). */
export type NavigationPathSegment =
  | { kind: 'collection'; id: string; path: string }
  | { kind: 'document'; id: string; path: string };

/** Split a doc/collection path into alternating collection/document segments. */
export function parseDocPath(docPath: string): NavigationPathSegment[] {
  const segs = docPath.split('/').filter(Boolean);
  const out: NavigationPathSegment[] = [];
  let acc = '';
  segs.forEach((s, i) => {
    acc = acc ? `${acc}/${s}` : s;
    out.push({ kind: i % 2 === 0 ? 'collection' : 'document', id: s, path: acc });
  });
  return out;
}

/** What to focus within the active sub-view. */
export type DataTarget =
  | { view: 'firestore'; path: NavigationPathSegment[] }
  | { view: 'auth'; uid: string | null }
  | { view: 'storage'; objectPath: string | null };

interface NavState {
  target: DataTarget | null;
  lens: DataLens;
  /** The denial to focus in the Rules surface (a Session "Debug" jump). */
  selectedDenialId: string | null;
}

// ─── Hash-derived store ─────────────────────────────────────────────────────
//
// The URL hash IS the store. `getSnapshot` must return a STABLE reference while
// the hash is unchanged (else `useSyncExternalStore` re-renders forever), so we
// memoize the derived state on the raw hash string.

function deriveNav(raw: string): NavState {
  const { tab, rest, query } = parseHash(raw);
  // Admin lens by default (rules bypassed); `?lens=app` selects app-session.
  const lens: DataLens = query.lens === 'app' ? 'app-session' : 'admin';
  let target: DataTarget | null = null;
  if (tab === 'firestore') {
    target = { view: 'firestore', path: parseDocPath(rest.join('/')) };
  } else if (tab === 'auth') {
    target = { view: 'auth', uid: rest[0] ?? null };
  } else if (tab === 'storage') {
    target = { view: 'storage', objectPath: rest.length ? rest.join('/') : null };
  }
  const selectedDenialId = tab === 'rules' ? query.denial ?? null : null;
  return { target, lens, selectedDenialId };
}

let cachedRaw: string | null = null;
let cachedSnap: NavState = deriveNav('');

function getSnapshot(): NavState {
  const raw = typeof window !== 'undefined' ? window.location.hash : '';
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSnap = deriveNav(raw);
  }
  return cachedSnap;
}

function getServerSnapshot(): NavState {
  return cachedSnap;
}

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

function writeHash(next: string): void {
  if (typeof window !== 'undefined') window.location.hash = next;
}

/** The in-service `rest` segments for a target. */
function restForTarget(target: DataTarget): string[] {
  switch (target.view) {
    case 'firestore': {
      const last = target.path[target.path.length - 1];
      return last ? last.path.split('/').filter(Boolean) : [];
    }
    case 'auth':
      return target.uid ? [target.uid] : [];
    case 'storage':
      return target.objectPath ? target.objectPath.split('/').filter(Boolean) : [];
  }
}

/** Switch sub-view (shell tab) + focus a target, preserving the lens. */
function navigateTo(target: DataTarget): void {
  const cur = parseHash();
  writeHash(
    serializeHash({ tab: target.view, rest: restForTarget(target), query: { lens: cur.query.lens } }),
  );
}

function setLensHash(lens: DataLens): void {
  const cur = parseHash();
  writeHash(
    serializeHash({
      tab: cur.tab,
      rest: cur.rest,
      query: { ...cur.query, lens: lens === 'app-session' ? 'app' : undefined },
    }),
  );
}

function navigateDenialHash(id: string): void {
  const cur = parseHash();
  writeHash(serializeHash({ tab: 'rules', query: { denial: id, lens: cur.query.lens } }));
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export interface DataNavValue {
  /** The focused target within the active view, if any. */
  target: DataTarget | null;
  /** The active auth lens for the data grids. */
  lens: DataLens;
  setLens: (lens: DataLens) => void;
  /** Switch sub-view (shell tab) + focus a target. */
  navigate: (target: DataTarget) => void;
  /** Route a detected cross-ref to the right sub-view + target. */
  navigateRef: (ref: CrossRef) => void;
  /** The denial the Rules surface should focus (a Session "Debug" jump). */
  selectedDenialId: string | null;
  /** Jump to the Rules surface and focus a specific denial by event id. */
  navigateDenial: (id: string) => void;
}

export function useDataNav(): DataNavValue {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const navigate = useCallback((next: DataTarget) => navigateTo(next), []);

  const navigateRef = useCallback((ref: CrossRef) => {
    switch (ref.kind) {
      case 'user':
        navigateTo({ view: 'auth', uid: ref.uid });
        break;
      case 'storage':
        navigateTo({ view: 'storage', objectPath: ref.objectPath });
        break;
      case 'document':
        navigateTo({ view: 'firestore', path: parseDocPath(ref.path) });
        break;
      case 'plain':
        break;
    }
  }, []);

  const setLens = useCallback((lens: DataLens) => setLensHash(lens), []);
  const navigateDenial = useCallback((id: string) => navigateDenialHash(id), []);

  return useMemo<DataNavValue>(
    () => ({
      target: snap.target,
      lens: snap.lens,
      setLens,
      navigate,
      navigateRef,
      selectedDenialId: snap.selectedDenialId,
      navigateDenial,
    }),
    [snap, setLens, navigate, navigateRef, navigateDenial],
  );
}
