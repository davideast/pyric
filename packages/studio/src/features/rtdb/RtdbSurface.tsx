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
import { LiveObservedDataBanner } from '../../components/LiveObservedDataBanner.js';
import { useHostAnswered, useLiveHost } from '../../shell/live-status.js';
import {
  useObservedSessionData,
  type ObservedRtdbInstanceSummary,
  type ObservedSessionViewState,
} from '../../shell/use-observed-session-data.js';
import { useSandboxInstanceId } from '../../shell/studio-saved-states.js';
import { instanceSlug } from '../../shell/instance-slug.js';
import type { WorkerLivePlane } from '../../clients/worker-live.js';
import { useRoutedRtdbPath } from './routed-path.js';
import './rtdb.css';

const LIVE_RTDB_COPY =
  'Inspect Realtime Database paths observed during this live session (partial, read-only).';
const SANDBOX_RTDB_COPY = 'Browse and edit RTDB data in the shared sandbox.';

export function RtdbSurface() {
  const env = useEnvironment();
  const liveHost = useLiveHost();
  const observed = useObservedSessionData(liveHost !== null, liveHost?.projectId);
  // The sandbox viewer subscribes to the sandbox's data, so it waits until the
  // host has said whether it is live: on a live host it never mounts.
  const hostAnswered = useHostAnswered();
  const live = env.status === 'ready' && hostAnswered ? env.env.live : undefined;
  const isLiveMode = liveHost !== null;

  return (
    <section className="studio-surface grid gap-4" aria-labelledby="rtdb-title">
      <div className="studio-surface__intro">
        <p className="studio-surface__eyebrow">RTDB</p>
        <h1 id="rtdb-title" className="studio-surface__title">
          RTDB
        </h1>
        <p className="studio-surface__copy">{isLiveMode ? LIVE_RTDB_COPY : SANDBOX_RTDB_COPY}</p>
      </div>

      <RtdbSurfaceBody isLiveMode={isLiveMode} observed={observed} live={live} />
    </section>
  );
}

/** Live mode shows observed data; otherwise the sandbox viewer once the worker plane is up. */
function RtdbSurfaceBody({
  isLiveMode,
  observed,
  live,
}: {
  isLiveMode: boolean;
  observed: ObservedSessionViewState;
  live: WorkerLivePlane | undefined;
}) {
  if (isLiveMode) return <ObservedLiveRtdbSection observed={observed} />;
  if (live) return <LiveRtdbViewer live={live} />;
  return <RtdbPending />;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function pluralKeys(count: number): string {
  if (count === 1) return '1 key';
  return `${count} keys`;
}

/** The pill's trailing meta: key count and size for an observed instance, `no traffic` otherwise. */
function instancePillMeta(item: ObservedRtdbInstanceSummary): string {
  if (!item.observed) return 'no traffic';
  return `${pluralKeys(item.topLevelKeys)} · ${formatByteSize(item.byteEstimate)}`;
}

function instancePillClassName(item: ObservedRtdbInstanceSummary, active: boolean): string {
  const classes = ['rtdb__instance-pill'];
  if (active) classes.push('rtdb__instance-pill--active');
  if (!item.observed) classes.push('rtdb__instance-pill--idle');
  return classes.join(' ');
}

function ObservedLiveRtdbSection({ observed }: { observed: ObservedSessionViewState }) {
  const anyOtherInstanceObserved = observed.rtdbInstanceSummaries.some(
    (item) => item.observed && item.instance !== observed.activeRtdbInstance,
  );
  return (
    <div className="grid gap-3" data-pyric-ui="rtdb-live-observed">
      <LiveObservedDataBanner observed={observed} />

      {observed.rtdbInstanceSummaries.length > 0 ? (
        <div
          className="rtdb__instances"
          data-rtdb-instance-bar=""
          role="tablist"
          aria-label="Observed RTDB instances"
        >
          {observed.rtdbInstanceSummaries.map((item) => {
            const active = item.instance === observed.activeRtdbInstance;
            return (
              <button
                key={item.instance}
                type="button"
                role="tab"
                aria-selected={active}
                data-rtdb-instance={item.instance}
                data-rtdb-instance-observed={item.observed ? 'true' : 'false'}
                className={instancePillClassName(item, active)}
                onClick={() => observed.setActiveRtdbInstance(item.instance)}
              >
                <span className="rtdb__instance-name">{item.instance}</span>
                {item.isDefault ? <span className="rtdb__instance-badge">default</span> : null}
                <span className="rtdb__instance-meta">{instancePillMeta(item)}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {!observed.hasObservedRtdb ? (
        <div
          data-rtdb-live-empty=""
          className="rounded-md border border-dashed border-line bg-panel p-8 text-center"
        >
          <span className="rounded-full border border-line px-3 py-1 text-xs uppercase tracking-wide text-muted">
            Observed this session · Empty
          </span>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
            {anyOtherInstanceObserved ? (
              <>
                No Realtime Database reads or writes observed on{' '}
                <code>{observed.activeRtdbInstance}</code> in this live session yet. Select an
                instance with traffic above or trigger a request on this shard.
              </>
            ) : (
              <>
                No Realtime Database reads or writes observed in this live session yet. Trigger a{' '}
                <code>get</code>, <code>onValue</code>, child listener, <code>set</code>,{' '}
                <code>update</code>, or <code>push</code> in your app to inspect observed paths
                here.
              </>
            )}
          </p>
        </div>
      ) : (
        <RoutedRtdbViewer
          api={observed.rtdbApi}
          instanceLabel={`${observed.activeRtdbInstance} (observed)`}
          readOnly
        />
      )}
    </div>
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
  /** Render the tree as read-only (Live mode observed session data). */
  readOnly?: boolean;
}

/**
 * The path bar and tree, focused on whatever path the URL names. Split from
 * {@link LiveRtdbViewer} so the route binding is exercised over any
 * {@link RtdbApi}, not only the shared worker's.
 */
export function RoutedRtdbViewer({
  api,
  instanceLabel,
  readOnly = false,
}: RoutedRtdbViewerProps) {
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
        readOnly={readOnly}
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
