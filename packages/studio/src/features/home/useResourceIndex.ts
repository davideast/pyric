/**
 * The impure seam under the Home typeahead: builds the {@link ResourceEntry}
 * index LAZILY on first focus, from the existing worker/data handles in
 * `shell/studio-data.ts` — no new backend operations (the same listing calls
 * the data surfaces already make). Refreshes on demand: a re-focus after
 * `STALE_MS` rebuilds, so the suggestions track a changing sandbox without a
 * standing subscription.
 */

import { useCallback, useRef, useState } from 'react';
import {
  doc as inProcessDoc,
  collection as inProcessCollection,
  query as inProcessQuery,
  getDocs as inProcessGetDocs,
  limit as inProcessLimit,
} from 'pyric/firestore';
import { sandbox as authSandbox } from 'pyric/auth';
import { ref as inProcessRef, listAll as inProcessListAll } from 'pyric/storage';
import { useEnvironment } from '../../shell/environment.js';
import { useStudioDataSource } from '../../shell/studio-data.js';
import {
  bfsStorageObjectPaths,
  buildResourceIndex,
  INDEX_CAPS,
  type ResourceEntry,
  type ResourceIndexSources,
} from './typeahead.js';

const STALE_MS = 30_000;

export interface ResourceIndexState {
  /** Null until the first build resolves. */
  entries: ResourceEntry[] | null;
  /** Kick a (re)build: first input focus, and refresh-on-demand thereafter.
   *  Pass `{ rtdbLikely: true }` when the user's input looks RTDB-directed —
   *  that is the only signal that re-fetches the RTDB tree (see the source's
   *  tradeoff note). */
  ensure: (opts?: { rtdbLikely?: boolean }) => void;
}

export function useResourceIndex(): ResourceIndexState {
  const data = useStudioDataSource();
  const env = useEnvironment();
  const [entries, setEntries] = useState<ResourceEntry[] | null>(null);
  const building = useRef(false);
  const builtAt = useRef(0);
  // RTDB top-level keys, fetched AT MOST once per rtdbLikely signal — see the
  // tradeoff note on `listRtdbTopLevelKeys` below.
  const rtdbKeys = useRef<string[] | null>(null);

  const live = env.status === 'ready' ? env.env.live : undefined;

  const ensure = useCallback((opts?: { rtdbLikely?: boolean }) => {
    if (data.status !== 'ready') return;
    if (building.current) return;
    if (entries !== null && Date.now() - builtAt.current < STALE_MS) return;
    building.current = true;

    const handles = data.handles;
    const adminDb = handles.adminFirestore as unknown as Parameters<typeof inProcessDoc>[0];
    const collectionFn = (data.firestoreApi?.collection ??
      inProcessCollection) as typeof inProcessCollection;
    const queryFn = (data.firestoreApi?.query ?? inProcessQuery) as typeof inProcessQuery;
    const getDocsFn = (data.firestoreApi?.getDocs ?? inProcessGetDocs) as typeof inProcessGetDocs;
    const limitFn = (data.firestoreApi?.limit ?? inProcessLimit) as typeof inProcessLimit;
    const refFn = (data.storageApi?.ref ?? inProcessRef) as typeof inProcessRef;
    const listAllFn = (data.storageApi?.listAll ?? inProcessListAll) as typeof inProcessListAll;
    const listUsersFn = data.authApi?.listUsers ?? authSandbox.listUsers;

    const sources: ResourceIndexSources = {
      listRootCollections: () => handles.listRootCollections(),

      listDocumentPaths: async (collectionId, cap) => {
        // Cap IN THE FETCH: limit() rides the query so the backend (worker or
        // in-process) never materializes more than `cap` docs per collection.
        const snap = await getDocsFn(
          queryFn(collectionFn(adminDb as never, collectionId), limitFn(cap)),
        );
        return snap.docs.slice(0, cap).map((d) => `${collectionId}/${d.id}`);
      },

      listUsers: async (cap) => {
        // `auth.listUsers` has no server-side max today (checked: the worker
        // op takes no arguments), so the cap is a client-side slice.
        const users = await Promise.resolve(
          listUsersFn(handles.auth as Parameters<typeof authSandbox.listUsers>[0]),
        );
        return users
          .slice(0, cap)
          .map((u) => ({ uid: u.uid, email: (u as { email?: string | null }).email ?? null }));
      },

      listStorageObjectPaths: (cap) =>
        bfsStorageObjectPaths(refFn(handles.storage as never, ''), listAllFn as never, {
          maxObjects: cap,
          maxListCalls: INDEX_CAPS.storageListCalls,
        }),

      // RTDB keys come from the live worker plane only — the RTDB surface
      // itself is live-only, and the in-process `pyric/database` admin entry
      // would drag firebase-admin into the browser bundle.
      //
      // TRADEOFF: there is no shallow-list RTDB op (readRtdbState reads the
      // WHOLE tree), and we deliberately add no new worker ops. So the tree
      // is fetched ONCE, the top-level keys cached, and a TTL rebuild reuses
      // the cache — the keys can go stale until the user types something
      // RTDB-directed (`ensure({ rtdbLikely: true })`), which is the one
      // signal worth paying a full-tree read for.
      listRtdbTopLevelKeys: async () => {
        if (!live) return [];
        if (rtdbKeys.current !== null && !opts?.rtdbLikely) return rtdbKeys.current;
        const snapshot = await live.readRtdbState();
        const keys =
          snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)
            ? []
            : Object.keys(snapshot as Record<string, unknown>);
        rtdbKeys.current = keys;
        return keys;
      },
    };

    void buildResourceIndex(sources, INDEX_CAPS)
      .then((built) => {
        builtAt.current = Date.now();
        setEntries(built);
      })
      .catch(() => {
        // Best-effort: keep whatever we had (possibly null → no resource groups).
      })
      .finally(() => {
        building.current = false;
      });
  }, [data, live, entries]);

  return { entries, ensure };
}
