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
} from 'pyric/firestore';
import { sandbox as authSandbox } from 'pyric/auth';
import { ref as inProcessRef, listAll as inProcessListAll } from 'pyric/storage';
import { useEnvironment } from '../../shell/environment.js';
import { useStudioDataSource } from '../../shell/studio-data.js';
import { useDevSeed } from '../../dev/DevSeedProvider.js';
import {
  buildResourceIndex,
  INDEX_CAPS,
  type ResourceEntry,
  type ResourceIndexSources,
} from './typeahead.js';

const STALE_MS = 30_000;

export interface ResourceIndexState {
  /** Null until the first build resolves. */
  entries: ResourceEntry[] | null;
  /** Kick a (re)build: first input focus, and refresh-on-demand thereafter. */
  ensure: () => void;
}

export function useResourceIndex(): ResourceIndexState {
  const data = useStudioDataSource();
  const env = useEnvironment();
  const seed = useDevSeed();
  const [entries, setEntries] = useState<ResourceEntry[] | null>(null);
  const building = useRef(false);
  const builtAt = useRef(0);

  const live = env.status === 'ready' ? env.env.live : undefined;
  const seedSandbox = seed.status === 'ready' ? seed.handles.sandbox : null;

  const ensure = useCallback(() => {
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
    const refFn = (data.storageApi?.ref ?? inProcessRef) as typeof inProcessRef;
    const listAllFn = (data.storageApi?.listAll ?? inProcessListAll) as typeof inProcessListAll;
    const listUsersFn = data.authApi?.listUsers ?? authSandbox.listUsers;

    const sources: ResourceIndexSources = {
      listRootCollections: () => handles.listRootCollections(),

      listDocumentPaths: async (collectionId, cap) => {
        const snap = await getDocsFn(queryFn(collectionFn(adminDb as never, collectionId)));
        return snap.docs.slice(0, cap).map((d) => `${collectionId}/${d.id}`);
      },

      listUsers: async (cap) => {
        const users = await Promise.resolve(
          listUsersFn(handles.auth as Parameters<typeof authSandbox.listUsers>[0]),
        );
        return users
          .slice(0, cap)
          .map((u) => ({ uid: u.uid, email: (u as { email?: string | null }).email ?? null }));
      },

      listStorageObjectPaths: async (cap) => {
        // Breadth-first over listAll prefixes, capped: object stores are flat
        // key spaces surfaced as folders, so BFS finds shallow refs first.
        const paths: string[] = [];
        const queue: unknown[] = [refFn(handles.storage as never, '')];
        while (queue.length && paths.length < cap) {
          const res = await listAllFn(queue.shift() as never);
          for (const item of res.items) {
            if (paths.length >= cap) break;
            paths.push(item.fullPath);
          }
          queue.push(...res.prefixes);
        }
        return paths;
      },

      listRtdbTopLevelKeys: async () => {
        let snapshot: unknown = null;
        if (live) {
          snapshot = await live.readRtdbState();
        } else if (seedSandbox) {
          const { getAdminDatabase, sandbox: rtdbSandbox } = await import('pyric/database');
          snapshot = rtdbSandbox.snapshotState(getAdminDatabase(seedSandbox as never));
        }
        if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
          return [];
        }
        return Object.keys(snapshot as Record<string, unknown>);
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
  }, [data, live, seedSandbox, entries]);

  return { entries, ensure };
}
