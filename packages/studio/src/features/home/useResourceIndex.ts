/**
 * The impure seam under the Home typeahead: builds the {@link ResourceEntry}
 * index from the existing worker/data handles in `shell/studio-data.ts` — no
 * new backend operations (the same listing calls the data surfaces already
 * make).
 *
 * FRESHNESS: `ensure()` is called on every palette OPEN (focus), not per
 * keystroke, and — as of this file — it rebuilds EVERY time it's called
 * (modulo the in-flight dedup below), not just once per `STALE_MS` window.
 * The old TTL gate meant a collection created after the last build stayed
 * invisible until a refocus AFTER the TTL expired — "sometimes does,
 * sometimes doesn't" from the user's seat. The caps (`INDEX_CAPS`) already
 * bound a build to a handful of RPCs, and `buildResourceIndex` now runs its
 * independent sources concurrently and reports partial results as they land
 * (see its doc comment), so a rebuild-per-open is cheap enough not to need a
 * TTL at all. `STALE_MS` still gates the RTDB-full-tree-read tradeoff below,
 * which is a genuinely expensive read worth caching independently.
 *
 * IN-FLIGHT DEDUP, WITH A FOLLOW-UP: a build already in flight is not
 * restarted (no overlapping RPC storms from rapid focus/blur/focus), but a
 * `ensure()` call that arrives mid-build is NOT silently dropped either — it
 * marks `pendingRebuild`, and a fresh build starts the moment the in-flight
 * one finishes. Without this, a focus that lands mid-build would never
 * schedule a re-check, and the index could go stale until some LATER
 * unrelated focus happened to land between builds.
 *
 * STALE BUILDS ARE DISCARDED: each build gets a token; if a newer build
 * started (because of the dedup follow-up, or because the caller opened the
 * palette again while a build was still running), an older build's results
 * are dropped when it resolves — the index always reflects the most
 * recently REQUESTED build, not the first one to finish.
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
  /** Null until the first build's first batch resolves. */
  entries: ResourceEntry[] | null;
  /** True while a build is in flight — lets the palette show a lightweight
   *  "still indexing" signal instead of dead air on a fresh, unbuilt index. */
  building: boolean;
  /** Kick a (re)build: every palette open (focus). Cheap — see the file
   *  doc comment on why this is no longer TTL-gated. Pass
   *  `{ rtdbLikely: true }` when the user's input looks RTDB-directed — that
   *  is the only signal that re-fetches the RTDB tree (see the source's
   *  tradeoff note). */
  ensure: (opts?: { rtdbLikely?: boolean }) => void;
}

export function useResourceIndex(): ResourceIndexState {
  const data = useStudioDataSource();
  const env = useEnvironment();
  const [entries, setEntries] = useState<ResourceEntry[] | null>(null);
  const [building, setBuilding] = useState(false);
  const inFlight = useRef(false);
  const pendingRebuild = useRef<{ rtdbLikely?: boolean } | null>(null);
  // Bumped per build; a build's batches are applied only while its token is
  // still current — an older, slower build can't clobber a newer one's
  // results after the newer one already started replacing them.
  const buildToken = useRef(0);
  // RTDB top-level keys, fetched AT MOST once per rtdbLikely signal — see the
  // tradeoff note on `listRtdbTopLevelKeys` below.
  const rtdbKeys = useRef<string[] | null>(null);
  const rtdbKeysBuiltAt = useRef(0);

  const live = env.status === 'ready' ? env.env.live : undefined;

  const runBuild = useCallback(
    (opts?: { rtdbLikely?: boolean }) => {
      if (data.status !== 'ready') return;
      const token = ++buildToken.current;
      inFlight.current = true;
      setBuilding(true);

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

        listDocumentPaths: async (collectionPath, cap) => {
          // Cap IN THE FETCH: limit() rides the query so the backend (worker
          // or in-process) never materializes more than `cap` docs per
          // collection. `collectionPath` may be a root collection id OR a
          // longer subcollection path (`customers/acme/users`) — `collection()`
          // accepts either, so this one seam serves both call sites in
          // `buildResourceIndex`.
          const snap = await getDocsFn(
            queryFn(collectionFn(adminDb as never, collectionPath), limitFn(cap)),
          );
          return snap.docs.slice(0, cap).map((d) => `${collectionPath}/${d.id}`);
        },

        // Drives the collection-group walk (see `bfsFirestoreSubcollections`)
        // so subcollections anywhere in the tree — and their documents —
        // join the index, not just root collections' direct children.
        listSubcollections: (docPath) => Promise.resolve(handles.listSubcollections(docPath)),

        listUsers: async (cap) => {
          // `auth.listUsers` has no server-side max today (checked: the
          // worker op takes no arguments), so the cap is a client-side slice.
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
        // itself is live-only, and the in-process `pyric/database` admin
        // entry would drag firebase-admin into the browser bundle.
        //
        // TRADEOFF: there is no shallow-list RTDB op (readRtdbState reads
        // the WHOLE tree), and we deliberately add no new worker ops. So the
        // tree is fetched ONCE per `STALE_MS` window (this is the one piece
        // that keeps a TTL — a full-tree read is genuinely expensive, unlike
        // the rest of the build), and a rebuild reuses the cache unless the
        // user's input looks RTDB-directed (`ensure({ rtdbLikely: true })`),
        // which is the one signal worth paying a full-tree read for anyway.
        listRtdbTopLevelKeys: async () => {
          if (!live) return [];
          const fresh = Date.now() - rtdbKeysBuiltAt.current < STALE_MS;
          if (rtdbKeys.current !== null && fresh && !opts?.rtdbLikely) return rtdbKeys.current;
          const snapshot = await live.readRtdbState();
          const keys =
            snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)
              ? []
              : Object.keys(snapshot as Record<string, unknown>);
          rtdbKeys.current = keys;
          rtdbKeysBuiltAt.current = Date.now();
          return keys;
        },
      };

      // Progressive: apply each source's batch as it lands (Firestore first
      // in practice — see `buildResourceIndex`'s doc comment) rather than
      // waiting for the slowest source (the storage BFS) before the palette
      // shows anything at all.
      void buildResourceIndex(sources, INDEX_CAPS, (batch) => {
        if (token !== buildToken.current) return; // superseded by a newer build
        setEntries((cur) => [...(cur ?? []), ...batch]);
      })
        .catch(() => {
          // Best-effort: keep whatever landed via onBatch (possibly nothing).
        })
        .finally(() => {
          if (token !== buildToken.current) return; // a newer build already took over `building`
          inFlight.current = false;
          setBuilding(false);
          if (pendingRebuild.current) {
            const next = pendingRebuild.current;
            pendingRebuild.current = null;
            runBuild(next);
          }
        });
    },
    [data, live],
  );

  const ensure = useCallback(
    (opts?: { rtdbLikely?: boolean }) => {
      if (data.status !== 'ready') return;
      if (inFlight.current) {
        // Don't drop this request on the floor: a build already running
        // means the CALLER's freshness need is still unmet, so queue one
        // more build for the moment this one finishes (merging opts — an
        // rtdbLikely ask should survive even if a plain ensure() follows).
        pendingRebuild.current = { ...pendingRebuild.current, ...opts };
        return;
      }
      // Fresh build starts from a clean slate — stale entries from a build
      // several opens ago (a deleted collection, say) shouldn't linger.
      setEntries(null);
      runBuild(opts);
    },
    [data, runBuild],
  );

  return { entries, building, ensure };
}
