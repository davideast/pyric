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
import { LiveObservedDataBanner } from '../../components/LiveObservedDataBanner.js';
import { useHostAnswered, useLiveHost } from '../../shell/live-status.js';
import { useObservedSessionData } from '../../shell/use-observed-session-data.js';
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

const LIVE_SERVICE_UNAVAILABLE_COPY: Record<'auth' | 'storage', { title: string; copy: string }> = {
  auth: {
    title: 'Auth user listing is unavailable in Live mode',
    copy: 'Live mode observes your app’s client SDK traffic without Admin credentials, so it cannot enumerate production Auth users and never mutates local sandbox users implicitly. Inspect observed Auth operations in Traffic.',
  },
  storage: {
    title: 'Storage object browser is unavailable in Live mode',
    copy: 'Live mode does not retain or persist production Storage object bytes in host memory or .pyric/. Inspect observed Storage metadata, upload, and download calls in Traffic.',
  },
};

function LiveServiceUnavailable({ view }: { view: 'auth' | 'storage' }) {
  const { title, copy } = LIVE_SERVICE_UNAVAILABLE_COPY[view];
  return (
    <div
      data-pyric-ui="live-service-unavailable"
      className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line bg-panel py-16 px-6 text-center"
    >
      <span className="rounded-full border border-line px-3 py-1 text-xs uppercase tracking-wide text-muted">
        Live mode · Read-only
      </span>
      <p className="font-medium text-sm text-ink">{title}</p>
      <p className="max-w-md text-sm leading-relaxed text-muted">{copy}</p>
    </div>
  );
}

export function DataFeature({ view }: { view: DataView }) {
  const { target } = useDataNav();
  const liveHost = useLiveHost();
  const hostAnswered = useHostAnswered();
  const observed = useObservedSessionData(liveHost !== null, liveHost?.projectId);

  // Live handles, dev-seed first (review), env-hydrated otherwise (`dev --ui`).
  const data = useStudioDataSource();

  // Shared live user list (one subscription for the whole feature). The auth
  // handle only exists once the sandbox handles resolved.
  const auth = data.status === 'ready' ? data.handles.auth : null;

  if (liveHost !== null) {
    return (
      <div data-pyric-ui="data-feature" data-live-mode="">
        <LiveObservedDataBanner observed={observed} />
        {view === 'firestore' ? (
          <FirestoreApiProvider value={observed.firestoreApi}>
            <LiveFirestorePane
              handles={observed.handles}
              readOnly
              emptyCollectionsMessage="No Firestore reads or writes observed in this live session yet. Interact with your app to inspect observed documents here."
            />
          </FirestoreApiProvider>
        ) : (
          <LiveServiceUnavailable view={view} />
        )}
      </div>
    );
  }

  return (
    <div data-pyric-ui="data-feature">
      {data.status !== 'ready' || !auth || !hostAnswered ? (
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
