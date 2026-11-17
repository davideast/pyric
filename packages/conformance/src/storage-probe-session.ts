/**
 * Live-project session helper for modular `firebase/storage` client probes (`rig: 'sdk-probes'`).
 *
 * Loads `firebase/*` lazily so `loadModularProbes` and inert previews stay fast,
 * deploys and restores the `@pyric/oracle/storage` rule block with `SIGINT`/`SIGTERM`
 * protection, scopes all object writes under `pyric_oracle/<runId>/`, and deletes
 * tracked objects and the temporary anonymous user on exit.
 */
import type { FirebaseOptions } from 'firebase/app';
import type { FirebaseStorage, StorageReference } from 'firebase/storage';
import { loadOracleServiceAccount, oracleAccessToken } from './oracle-credential.ts';
import {
  OracleRulesSession,
  runWithOracleRulesRestored,
  storageOracleTarget,
} from './oracle-rules-session.ts';
import type { OracleWebConfig } from './oracle-run-setup.ts';
import { installOracleSignalRestoreGuard } from './oracle-signal-restore.ts';
import { resolveProbeWebConfig } from './sdk-probe-runtime.ts';

const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';

function stripBucketUriFormatting(raw: string): string {
  return raw.trim().replace(/^gs:\/\//, '').replace(/\/+$/, '');
}

export function resolveProbeStorageBucket(
  webConfig: OracleWebConfig,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = stripBucketUriFormatting(env.PYRIC_ORACLE_STORAGE_BUCKET ?? '');
  if (fromEnv !== '') {
    return fromEnv;
  }
  const fromConfig = stripBucketUriFormatting(webConfig.storageBucket ?? '');
  if (fromConfig !== '') {
    return fromConfig;
  }
  throw new Error(
    `Firebase Web SDK config for project '${webConfig.projectId}' has no storageBucket; enable Firebase Storage on the project or set PYRIC_ORACLE_STORAGE_BUCKET.`,
  );
}

export function normalizeStorageProbeSubpath(subpath: string): string {
  const cleaned = subpath.trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  if (cleaned === '') {
    throw new Error('Storage probe objectRef requires a non-empty relative subpath');
  }
  const segments = cleaned.split('/');
  if (segments.some((seg) => seg === '.' || seg === '..')) {
    throw new Error(`Unsafe Storage probe relative subpath rejected: '${subpath}'`);
  }
  return cleaned;
}

export function scrubStorageOracleRunPath(text: string, runId: string): string {
  if (!runId) return text;
  return text.split(`pyric_oracle/${runId}`).join('pyric_oracle/<runId>');
}

function nextStorageProbeRunId(): string {
  const stamp = Date.now().toString(36);
  const nonce = Math.random().toString(36).slice(2, 8);
  return `st_${stamp}_${nonce}`;
}

export interface StorageProbeContext {
  runId: string;
  basePath: string;
  storageBucket: string;
  storage: FirebaseStorage;
  storageSdk: typeof import('firebase/storage');
  objectPath(subpath: string): string;
  objectRef(subpath: string): StorageReference;
  scrubRunPath(text: string): string;
}

export async function withStorageProbeSession(
  runProbe: (ctx: StorageProbeContext) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const [
    { deleteApp, initializeApp },
    { deleteUser, getAuth, signInAnonymously },
    storageSdk,
  ] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase/storage'),
  ]);

  const sa = await loadOracleServiceAccount();
  const webConfig = await resolveProbeWebConfig(sa);
  const storageBucket = resolveProbeStorageBucket(webConfig);

  const runId = nextStorageProbeRunId();
  const basePath = `pyric_oracle/${runId}`;
  const session = new OracleRulesSession({
    projectId: sa.project_id,
    accessToken: () => oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE),
  });
  const detachSignals = installOracleSignalRestoreGuard('[sdk-probes]', () =>
    session.restoreAll(),
  );

  const appOptions: FirebaseOptions = {
    ...(webConfig as FirebaseOptions),
    storageBucket,
  };
  const clientApp = initializeApp(appOptions, `sdk-probe-storage-${runId}`);
  const clientAuth = getAuth(clientApp);
  const storage = storageSdk.getStorage(clientApp);
  const trackedRefs: StorageReference[] = [];

  const objectPath = (subpath: string): string => {
    return `${basePath}/${normalizeStorageProbeSubpath(subpath)}`;
  };

  const objectRef = (subpath: string): StorageReference => {
    const fullPath = objectPath(subpath);
    const created = storageSdk.ref(storage, fullPath);
    trackedRefs.push(created);
    return created;
  };

  try {
    return await runWithOracleRulesRestored(session, async () => {
      const outcome = await session.deploy(storageOracleTarget(storageBucket));
      if (outcome !== 'already-configured') {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
      await signInAnonymously(clientAuth);
      try {
        return await runProbe({
          runId,
          basePath,
          storageBucket,
          storage,
          storageSdk,
          objectPath,
          objectRef,
          scrubRunPath: (text: string) => scrubStorageOracleRunPath(text, runId),
        });
      } finally {
        for (const tracked of trackedRefs) {
          await storageSdk.deleteObject(tracked).catch(() => undefined);
        }
        if (clientAuth.currentUser) {
          await deleteUser(clientAuth.currentUser).catch(() => undefined);
        }
        await deleteApp(clientApp).catch(() => undefined);
      }
    });
  } finally {
    detachSignals();
    if (session.restoredFirestoreOrStorage) {
      console.log('[sdk-probes] Storage rules restored and verified');
    }
  }
}
