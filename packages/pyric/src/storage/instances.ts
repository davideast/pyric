import type { FirebaseApp } from '../app/types.js';
import { bindOperationContext } from 'pyric/sandbox/internal';
import {
  defaultClientApp,
  resolveClientApp,
} from '../sandbox/internal/client-app.js';
import {
  getStorageSandbox,
  TARGET_SYMBOL,
  type AppFirebaseStorage,
  type FirebaseStorage,
} from './service.js';
import { rulesBucketName } from './sandbox/rules-bucket-name.js';

/** Whether `getStorage`'s bucket URL names a bucket other than the app's `storageBucket`. */
function namesOtherBucket(bucketUrl: string | undefined, appBucket: string | undefined): boolean {
  if (bucketUrl === undefined || bucketUrl === '') return false;
  return rulesBucketName('', bucketUrl) !== rulesBucketName('', appBucket);
}

/** Resolve the Firebase-shaped Storage service associated with an app. */
export function getStorage(app?: FirebaseApp, bucketUrl?: string): AppFirebaseStorage {
  const resolvedApp = app ?? defaultClientApp() as FirebaseApp;
  const runtime = resolveClientApp(resolvedApp);
  if (!runtime) throw new TypeError('pyric/storage: unrecognized FirebaseApp handle');
  return runtime.service(`storage/${bucketUrl ?? 'default'}`, () => {
    const { sandbox, session } = runtime;
    // Project-scope the storage database by the app's projectId (issue #359)
    // — first-call-per-Sandbox semantics apply, so a host that already opened
    // the service (e.g. `pyric dev` with the served project's key) wins.
    const projectId = resolvedApp.options?.projectId;
    const appBucket = resolvedApp.options?.storageBucket;
    // A bucket URL naming another bucket opens that bucket, with its own
    // objects and its own rules, as production keeps them apart (#1313). The
    // app's default bucket keeps the store key `pyric-default`.
    const otherBucket = namesOtherBucket(bucketUrl, appBucket) ? rulesBucketName('', bucketUrl) : undefined;
    const handle = getStorageSandbox(bindOperationContext(sandbox.withAuth(session.currentUser), {
      source: { kind: 'app' },
      authLens: { mode: 'app-session' },
    }), {
      ...(projectId ? { projectId } : {}),
      ...(otherBucket !== undefined ? { bucket: otherBucket } : {}),
    });
    // The store keeps its own bucket key; rules see the bucket under the name
    // the app knows it by (ST-H2-4).
    const bucketName = bucketUrl ?? appBucket;
    return Object.freeze({
      [TARGET_SYMBOL]: {
        ...handle[TARGET_SYMBOL],
        currentAuth: () => session.currentUser,
        ...(bucketName ? { bucketName } : {}),
      },
      app: resolvedApp,
    });
  });
}

/** Accepted no-op because the selected Storage backend already is local. */
export function connectStorageEmulator(
  _storage: FirebaseStorage,
  _host: string,
  _port: number,
  _options?: { mockUserToken?: string | Record<string, unknown> },
): void {}
