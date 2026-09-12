/**
 * RTDB surface (Pyric Studio) — the Firebase console / firebase-tools-ui
 * data-viewer form, composed over `@pyric/ui/rtdb` (NOT reimplemented):
 *
 *   - PATH BAR → {@link RtdbPathBar}: the instance label + current path as
 *     clickable crumbs; the pencil (or Enter/Escape in the input) edits the
 *     path directly. The root crumb carries the sandbox INSTANCE identity
 *     (the same `instanceSlug` the session surface renders), not a fake
 *     `firebaseio.com` URL.
 *   - TREE → {@link RtdbTree} over {@link useRtdbTree}: expandable nodes,
 *     `key: value` leaves with click-to-edit, hover-revealed `+`/`×` per node
 *     with an inline delete confirm (no modals), and console-style paging at
 *     50 children per level ("Show more"). Realtime: one admin-lens value
 *     subscription at the view root (see `@pyric/ui/rtdb`'s `reducers/tree.ts`
 *     for the loading-strategy decision — the worker has no shallow reads, so
 *     rendering is lazy instead of fetching).
 *
 * The focused path lives in the URL, not in component state: `/rtdb/a/b/c`
 * focuses `/a/b/c` and `/rtdb` alone focuses the root, so a listener link, a
 * command-palette result, a pasted URL, and browser back/forward all land the
 * viewer on the same node. See {@link useRoutedRtdbPath} in `routed-path.ts`,
 * the RTDB counterpart of the Data feature's `navigation.tsx`.
 *
 * The backend is the live SharedWorker plane's admin RTDB ops (data views are
 * always admin — PRINCIPLES M3). All styling lives in the token-only
 * `rtdb.css`, targeting the `data-rtdb-*` contract the library emits.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  parentRtdbPath,
  relativeRtdbPath,
  RtdbPathBar,
  rtdbPathSegments,
  RtdbTree,
  useRtdbTree,
  type RtdbApi,
} from '@pyric/ui/rtdb';
import { useEnvironment } from '../../shell/environment.js';
import { useSandboxInstanceId } from '../../shell/studio-saved-states.js';
import { instanceSlug } from '../../shell/instance-slug.js';
import type { WorkerLivePlane } from '../../clients/worker-live.js';
import { useRoutedRtdbPath } from './routed-path.js';
import './rtdb.css';

export function RtdbSurface() {
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;

  return (
    <section className="studio-surface grid gap-4" aria-labelledby="rtdb-title">
      <div className="studio-surface__intro">
        <p className="studio-surface__eyebrow">RTDB</p>
        <h1 id="rtdb-title" className="studio-surface__title">
          RTDB
        </h1>
        <p className="studio-surface__copy">Browse and edit RTDB data in the shared sandbox.</p>
      </div>

      {live ? <LiveRtdbViewer live={live} /> : <RtdbPending />}
    </section>
  );
}

function RtdbPending() {
  return (
    <div className="rounded-md border border-dashed border-line bg-panel p-8 text-center">
      <span className="rounded-full border border-line px-3 py-1 text-xs uppercase tracking-wide text-muted">
        Shared worker pending
      </span>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
        The RTDB viewer goes live once Studio connects to the shared sandbox worker.
      </p>
    </div>
  );
}

function LiveRtdbViewer({ live }: { live: WorkerLivePlane }) {
  // The sandbox instance identity for the root crumb — the SAME slug the
  // session surface renders, so "which database is this" matches everywhere.
  const slug = instanceSlug(useSandboxInstanceId());

  // The viewer's backend: the live plane's admin RTDB ops (M3), memoized so
  // the tree's subscription effect keys on the plane, not on each render.
  const api = useMemo<RtdbApi>(
    () => ({
      set: (p, value) => live.setRtdbValue(p, value),
      remove: (p) => live.deleteRtdbValue(p),
      subscribeValue: (p, next, error) => live.subscribeRtdbValue(p, next, error),
    }),
    [live],
  );

  return (
    <RoutedRtdbViewer api={api} instanceLabel={slug ? `${slug}-sandbox` : 'sandbox'} />
  );
}

export interface RoutedRtdbViewerProps {
  /** Read/write backend for the tree (the admin lens in Studio). */
  api: RtdbApi;
  /** The database identity shown on the root crumb and the root row. */
  instanceLabel: string;
}

/**
 * The path bar and tree, focused on whatever path the URL names. Split from
 * {@link LiveRtdbViewer} so the route binding is exercised over any
 * {@link RtdbApi}, not only the shared worker's.
 */
export function RoutedRtdbViewer({ api, instanceLabel }: RoutedRtdbViewerProps) {
  // The focused path comes from the URL, not from component state: a listener
  // link or a pasted URL lands on the node it names, and clicking a node in
  // the tree writes the path back so the address bar keeps up. Back/forward
  // move the viewer because the route is the only source of truth.
  const [routedPath, navigate] = useRoutedRtdbPath();
  const { viewRoot, missingTail, tree } = useNearestExistingRoot(api, routedPath);

  // Arriving from a link outside the viewer: bring the focused node on screen.
  const viewerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (viewRoot === '/') return;
    const node = viewerRef.current;
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' });
    }
  }, [viewRoot]);

  return (
    <div className="rtdb" ref={viewerRef}>
      <RtdbPathBar
        className="rtdb__pathbar"
        path={routedPath}
        onNavigate={navigate}
        rootLabel={instanceLabel}
        inputPrefix={instanceLabel}
      />
      {missingTail ? (
        <p className="rtdb__missing" data-rtdb-missing="">
          This path does not exist. Showing <code>{viewRoot}</code>, the nearest
          path that does; <code>{missingTail}</code> is not in the database.
        </p>
      ) : null}
      <RtdbTree
        className="rtdb__tree"
        tree={tree}
        api={api}
        onNavigate={navigate}
        rootLabel={instanceLabel}
      />
    </div>
  );
}

/**
 * Resolve a routed path that is not in the data to its nearest existing
 * ancestor, the way the Firestore pane falls back for a document that does not
 * exist. In RTDB an absent path and a null path are the same thing, so a
 * `null` value at a live view root means the path is not there: walk one
 * segment up and subscribe again, until a subtree turns up or the root is
 * reached. The route itself is left alone — the URL still names what was
 * asked for, and the note above the tree says which tail is missing.
 */
function useNearestExistingRoot(api: RtdbApi, requested: string) {
  const [fallback, setFallback] = useState({ requested, root: requested });
  // Re-resolve from the requested path whenever the route names another one.
  const resolving =
    fallback.requested === requested ? fallback : { requested, root: requested };
  if (resolving !== fallback) setFallback(resolving);

  const viewRoot = resolving.root;
  const tree = useRtdbTree(api, viewRoot);
  const { path: loadedPath, status, value } = tree.state;

  useEffect(() => {
    if (loadedPath !== viewRoot) return;
    if (status !== 'live') return;
    if (value != null) return;
    if (viewRoot === '/') return;
    setFallback({ requested, root: parentRtdbPath(viewRoot) });
  }, [loadedPath, status, value, viewRoot, requested]);

  const tail = viewRoot === requested ? null : relativeRtdbPath(viewRoot, requested);
  return {
    viewRoot,
    missingTail: tail && rtdbPathSegments(tail).length > 0 ? tail : null,
    tree,
  };
}
