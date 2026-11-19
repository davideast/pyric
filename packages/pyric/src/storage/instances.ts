import type { FirebaseApp } from '../app/types.js';
import { bindOperationContext } from 'pyric/sandbox/internal';
import {
  defaultClientApp,
  resolveClientApp,
} from '../sandbox/internal/client-app.js';
import { createStorageRetryHandle } from './handle-retry-times.js';
import { parseBucketSpec } from './sandbox/bucket-spec.js';
import {
  getStorageSandbox,
  TARGET_SYMBOL,
  type AppFirebaseStorage,
  type FirebaseStorage,
  type SandboxTarget,
  type StorageOptions,
} from './service.js';

/** Resolve the Firebase-shaped Storage service associated with an app. */
export function getStorage(app?: FirebaseApp, bucketUrl?: string): AppFirebaseStorage {
  const resolvedApp = app ?? (defaultClientApp() as FirebaseApp);
  const runtime = resolveClientApp(resolvedApp);
  if (!runtime) throw new TypeError('pyric/storage: unrecognized FirebaseApp handle');

  let parsedBucketUrl: string | undefined;
  let cacheKey = 'storage/[DEFAULT]';
  if (bucketUrl !== undefined) {
    parsedBucketUrl = parseBucketSpec(bucketUrl);
    cacheKey = `storage/url:${bucketUrl}`;
  }

  return runtime.service(cacheKey, () => {
    const { sandbox, session } = runtime;
    let rawAppBucket = runtime.options?.storageBucket;
    let projectId = runtime.options?.projectId;
    try {
      rawAppBucket = resolvedApp.options?.storageBucket;
      projectId = resolvedApp.options?.projectId;
    } catch {
      // Deleted app: use options captured at attach time.
    }

    let parsedAppBucket: string | undefined;
    if (typeof rawAppBucket === 'string' && rawAppBucket !== '') {
      parsedAppBucket = parseBucketSpec(rawAppBucket);
    }

    const sandboxOptions: StorageOptions = {};
    if (projectId) {
      sandboxOptions.projectId = projectId;
    }
    if (
      parsedBucketUrl !== undefined &&
      parsedBucketUrl !== '' &&
      parsedBucketUrl !== parsedAppBucket
    ) {
      sandboxOptions.bucket = parsedBucketUrl;
    }

    const handle = getStorageSandbox(
      bindOperationContext(sandbox.withAuth(session.currentUser), {
        source: { kind: 'app' },
        authLens: { mode: 'app-session' },
      }),
      sandboxOptions,
    );

    let callerBucketName = parsedAppBucket;
    if (parsedBucketUrl !== undefined) {
      callerBucketName = parsedBucketUrl;
    }

    const baseTarget = handle[TARGET_SYMBOL];
    let target: SandboxTarget = {
      ...baseTarget,
      currentAuth: () => session.currentUser,
    };
    if (callerBucketName !== undefined) {
      target = { ...target, bucketName: callerBucketName };
    }
    return createStorageRetryHandle<AppFirebaseStorage>({
      [TARGET_SYMBOL]: target,
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
