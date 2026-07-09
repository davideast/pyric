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
  | { view: 'storage'; objectPath: string | null };

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

function deriveNav(raw: string): NavState {
  const qIdx = raw.indexOf('?');
  const { tab, rest, query } = parsePath(
    qIdx === -1 ? raw : raw.slice(0, qIdx),
    qIdx === -1 ? '' : raw.slice(qIdx),
  );
  let target: DataTarget | null = null;
  if (tab === 'firestore') {
    target = { view: 'firestore', path: parseDocPath(rest.join('/')) };
  } else if (tab === 'auth') {
    target = { view: 'auth', uid: rest[0] ?? null };
  } else if (tab === 'storage') {
    target = { view: 'storage', objectPath: rest.length ? rest.join('/') : null };
  }
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

/** Switch sub-view (shell tab) + focus a target. */
function navigateTo(target: DataTarget): void {
  pushPath({
    tab: target.view,
    rest: restForTarget(target),
  });
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
        navigateTo({ view: 'storage', objectPath: ref.objectPath });
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
