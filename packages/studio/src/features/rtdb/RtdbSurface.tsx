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
 * The backend is the live SharedWorker plane's admin RTDB ops (data views are
 * always admin — PRINCIPLES M3). All styling lives in the token-only
 * `rtdb.css`, targeting the `data-rtdb-*` contract the library emits.
 */

import { useMemo, useState } from 'react';
import { RtdbPathBar, RtdbTree, useRtdbTree, type RtdbApi } from '@pyric/ui/rtdb';
import { useEnvironment } from '../../shell/environment.js';
import { useSandboxInstanceId } from '../../shell/studio-data.js';
import { instanceSlug } from '../../shell/instance-slug.js';
import type { WorkerLivePlane } from '../../clients/worker-live.js';
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
  const [path, setPath] = useState('/');

  // The sandbox instance identity for the root crumb — the SAME slug the
  // session surface shows, so "which database is this" matches everywhere.
  const slug = instanceSlug(useSandboxInstanceId());
  const instanceLabel = slug ? `${slug}-sandbox` : 'sandbox';

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

  const tree = useRtdbTree(api, path);

  return (
    <div className="rtdb">
      <RtdbPathBar
        className="rtdb__pathbar"
        path={path}
        onNavigate={setPath}
        rootLabel={instanceLabel}
        inputPrefix={instanceLabel}
      />
      <RtdbTree
        className="rtdb__tree"
        tree={tree}
        api={api}
        onNavigate={setPath}
        rootLabel={instanceLabel}
        emptyState={
          <p className="rtdb__empty-copy">
            No data at this location. Use <strong>+</strong> to add a child, or seed RTDB
            data from your app — writes appear here live.
          </p>
        }
      />
    </div>
  );
}
