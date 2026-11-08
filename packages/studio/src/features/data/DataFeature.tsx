/**
 * The Data feature root (F2): the cross-service viewer/editor.
 *
 * Mounts one of the three service sub-views (Firestore / Auth / Storage) chosen
 * by the active shell tab, all sharing:
 *   - one Studio sandbox handle (hydrated from the env's durable backend),
 *     always through the ADMIN handle (data views are admin — M2/M3),
 *   - one navigation context so clickable cross-references jump between views,
 *   - one live `useAuthUsers` so the uid set is shared (a Firestore field that
 *     IS a real uid links to its user authoritatively).
 *
 * When the env is pending/errored (T3 not landed), there's no durable backend
 * to hydrate from, so the panes fall back to the `@pyric/ui` empty states,
 * honestly labelled "local backend pending", instead of crashing.
 */

import { useMemo } from 'react';
import { useAuthUsers, AuthApiProvider } from '@pyric/ui/auth';
import { FirestoreApiProvider } from '@pyric/ui/firestore';
import { StorageApiProvider } from '@pyric/ui/storage';
import { LiveFirestorePane } from './FirestorePane.js';
import { LiveAuthPane } from './AuthPane.js';
import { LiveStoragePane } from './StoragePane.js';
import { useDataNav, type DataView } from './navigation.js';
import { useStudioDataSource } from '../../shell/studio-data.js';
import './data-feature.css';

/** Backend-aware empty state shared by all three sub-views when not live. */
function PendingState({ view }: { view: DataView }) {
  const label = view === 'firestore' ? 'Firestore' : view === 'auth' ? 'Auth' : 'Storage';
  return (
    <div
      data-pyric-ui="data-pending"
      className="flex flex-col items-center justify-center gap-2 py-16 text-center"
    >
      <span className="rounded-full border border-border px-3 py-1 text-xs uppercase tracking-wide text-slate-gray">
        Local backend pending
      </span>
      <p className="max-w-md text-sm leading-relaxed text-slate-gray">
        The {label} viewer mounts here. It goes live once the local sandbox backend is reachable
        (the served `pyric dev --ui` workspace).
      </p>
    </div>
  );
}

export function DataFeature({ view }: { view: DataView }) {
  const { target } = useDataNav();

  // Live handles, dev-seed first (review), env-hydrated otherwise (`dev --ui`).
  const data = useStudioDataSource();

  // Shared live user list (one subscription for the whole feature). The auth
  // handle only exists once the sandbox handles resolved.
  const auth = data.status === 'ready' ? data.handles.auth : null;

  return (
    <div data-pyric-ui="data-feature">
      {data.status !== 'ready' || !auth ? (
        <PendingState view={view} />
      ) : data.authApi ? (
        // Served mode: the worker auth bundle so the feature-level useAuthUsers
        // (and the Auth pane) read the live worker user DB.
        <AuthApiProvider value={data.authApi}>
          <DataViews
            view={view}
            handles={data.handles}
            auth={auth}
            target={target}
            firestoreApi={data.firestoreApi}
            storageApi={data.storageApi}
          />
        </AuthApiProvider>
      ) : (
        <DataViews
          view={view}
          handles={data.handles}
          auth={auth}
          target={target}
          firestoreApi={data.firestoreApi}
          storageApi={data.storageApi}
        />
      )}
    </div>
  );
}

function DataViews({
  view,
  handles,
  auth,
  target,
  firestoreApi,
  storageApi,
}: {
  view: DataView;
  handles: import('./sandbox.js').StudioDataHandles;
  auth: import('pyric/auth').Auth;
  target: import('./navigation.js').DataTarget | null;
  firestoreApi?: import('@pyric/ui/firestore').FirestoreApi;
  storageApi?: import('@pyric/ui/storage').StorageApi;
}) {
  // Shared user list + uid set for cross-ref resolution.
  const { users } = useAuthUsers(auth);
  const knownUids = useMemo(() => new Set(users.map((u) => u.uid)), [users]);

  switch (view) {
    case 'firestore': {
      const pane = <LiveFirestorePane handles={handles} knownUids={knownUids} />;
      // Served mode supplies the worker FirestoreApi bundle so the grid drives
      // the live worker; dev-seed leaves it undefined (in-process default).
      return firestoreApi ? (
        <FirestoreApiProvider value={firestoreApi}>{pane}</FirestoreApiProvider>
      ) : (
        pane
      );
    }
    case 'auth':
      return (
        <LiveAuthPane
          auth={auth}
          focusUid={target?.view === 'auth' ? target.uid : null}
        />
      );
    case 'storage': {
      const pane = (
        <LiveStoragePane
          storage={handles.storage}
          focusTarget={target?.view === 'storage' ? target : { kind: 'root' }}
        />
      );
      // Served mode supplies the worker StorageApi bundle so the browser drives
      // the live worker object store; dev-seed leaves it undefined (in-process).
      return storageApi ? (
        <StorageApiProvider value={storageApi}>{pane}</StorageApiProvider>
      ) : (
        pane
      );
    }
  }
}
