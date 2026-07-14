/**
 * Cross-service navigation state for the Data feature (F2).
 *
 * The three Data sub-views (Firestore / Auth / Storage) each live behind their
 * own shell tab, and a clickable cross-reference jumps *between* them (a uid →
 * the Auth user, a `gs://` path → the Storage object, a doc path → the Firestore
 * document). Navigation state is encoded in the URL pathname under the app base
 * (see `shell/path.ts`), so the active view and the in-service location are
 * deep-linkable, survive reload and per-tab remounts, and follow browser
 * back/forward:
 *
 *   /firestore/<collection>/<doc>/...   the drill path
 *   /auth/<uid>                         the focused user
 *   /storage/<object/path>              the focused object
 *   /traffic?inspect=<id>               traffic drill-in to the rules inspector
 *
 * Data views are ALWAYS admin (PRINCIPLES M2/M3) — there is no lens param.
 * `useDataNav()` reads the location via `useSyncExternalStore`; `navigate(...)`
 * / `navigateInspect(...)` push through the shell's one history facade
 * (`shell/router.ts`).
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  locationKey,
  pushPath,
  subscribeToLocation,
} from '../../shell/router.js';
import { parsePath } from '../../shell/path.js';
import type { CommandTarget } from '../home/command.js';
import type { CrossRef } from './refs.js';

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
  | { view: 'storage'; kind: 'root' }
  | { view: 'storage'; kind: 'prefix' | 'object'; path: string };

interface NavState {
  target: DataTarget | null;
  /** The op to focus in the Traffic rules inspector. */
  selectedInspectId: string | null;
}

// ─── URL-derived store ──────────────────────────────────────────────────────
//
// The URL IS the store. `getSnapshot` must return a STABLE reference while the
// location is unchanged (else `useSyncExternalStore` re-renders forever), so we
// memoize the derived state on the raw `pathname + search` key.

function parsedLocation(raw: string) {
  const qIdx = raw.indexOf('?');
  return parsePath(
    qIdx === -1 ? raw : raw.slice(0, qIdx),
    qIdx === -1 ? '' : raw.slice(qIdx),
  );
}

/** Decode the data target carried by a pathname + query location key. */
export function targetForLocation(raw: string): DataTarget | null {
  const { tab, rest, query } = parsedLocation(raw);
  const path = rest.join('/');
  if (tab === 'firestore') return { view: 'firestore', path: parseDocPath(path) };
  if (tab === 'auth') return { view: 'auth', uid: rest[0] ?? null };
  if (tab === 'storage') {
    if (!path) return { view: 'storage', kind: 'root' };
    return {
      view: 'storage',
      kind: query.kind === 'prefix' ? 'prefix' : 'object',
      path,
    };
  }
  return null;
}

/** Encode a data target for the shell's single History-API router. */
export function routeForTarget(target: DataTarget): CommandTarget {
  switch (target.view) {
    case 'firestore': {
      const last = target.path[target.path.length - 1];
      return {
        tab: 'firestore',
        rest: last ? last.path.split('/').filter(Boolean) : [],
      };
    }
    case 'auth':
      return { tab: 'auth', rest: target.uid ? [target.uid] : [] };
    case 'storage':
      if (target.kind === 'root') return { tab: 'storage' };
      return {
        tab: 'storage',
        rest: target.path.split('/').filter(Boolean),
        ...(target.kind === 'prefix' ? { query: { kind: 'prefix' } } : {}),
      };
  }
}

function deriveNav(raw: string): NavState {
  const { tab, query } = parsedLocation(raw);
  const target = targetForLocation(raw);
  const selectedInspectId = tab === 'traffic' ? query.inspect ?? null : null;
  return { target, selectedInspectId };
}

let cachedRaw: string | null = null;
let cachedSnap: NavState = deriveNav('');

function getSnapshot(): NavState {
  const raw = locationKey();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSnap = deriveNav(raw);
  }
  return cachedSnap;
}

function getServerSnapshot(): NavState {
  return cachedSnap;
}

/** Switch sub-view (shell tab) + focus a target. */
function navigateTo(target: DataTarget): void {
  pushPath(routeForTarget(target));
}

function navigateInspectUrl(id: string): void {
  pushPath({ tab: 'traffic', query: { inspect: id } });
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export interface DataNavValue {
  /** The focused target within the active view, if any. */
  target: DataTarget | null;
  /** Switch sub-view (shell tab) + focus a target. */
  navigate: (target: DataTarget) => void;
  /** Route a detected cross-ref to the right sub-view + target. */
  navigateRef: (ref: CrossRef) => void;
  /** The op the Traffic rules inspector should focus. */
  selectedInspectId: string | null;
  /** Jump to Traffic and open the rules inspector on an event id. */
  navigateInspect: (id: string) => void;
}

export function useDataNav(): DataNavValue {
  const snap = useSyncExternalStore(subscribeToLocation, getSnapshot, getServerSnapshot);

  const navigate = useCallback((next: DataTarget) => navigateTo(next), []);

  const navigateRef = useCallback((ref: CrossRef) => {
    switch (ref.kind) {
      case 'user':
        navigateTo({ view: 'auth', uid: ref.uid });
        break;
      case 'storage':
        navigateTo({ view: 'storage', kind: 'object', path: ref.objectPath });
        break;
      case 'document':
        navigateTo({ view: 'firestore', path: parseDocPath(ref.path) });
        break;
      case 'plain':
        break;
    }
  }, []);

  const navigateInspect = useCallback((id: string) => navigateInspectUrl(id), []);

  return useMemo<DataNavValue>(
    () => ({
      target: snap.target,
      navigate,
      navigateRef,
      selectedInspectId: snap.selectedInspectId,
      navigateInspect,
    }),
    [snap, navigate, navigateRef, navigateInspect],
  );
}
