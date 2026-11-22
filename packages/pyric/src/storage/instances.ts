import type { Sandbox } from 'pyric/sandbox';
import type { FirebaseApp } from '../app/types.js';
import { bindOperationContext } from 'pyric/sandbox/internal';
import {
  defaultClientApp,
  resolveClientApp,
} from '../sandbox/internal/client-app.js';
import { createStorageRetryHandle } from './handle-retry-times.js';
import { claimDefaultStorageBucket } from './sandbox/bucket-rules.js';
import { parseBucketSpec } from './sandbox/bucket-spec.js';
import {
  getStorageSandbox,
  TARGET_SYMBOL,
  type AppFirebaseStorage,
  type FirebaseStorage,
  type SandboxTarget,
  type StorageOptions,
} from './service.js';
import type { EmulatorMockTokenOptions } from './types.js';

function appBucketSpec(
  app: FirebaseApp,
  fallbackOptions: { readonly storageBucket?: string } | undefined,
): string | undefined {
  let rawBucket = fallbackOptions?.storageBucket;
  try {
    rawBucket = app.options?.storageBucket;
  } catch {
    // Deleted app: use options captured at attach time.
  }
  if (typeof rawBucket === 'string' && rawBucket !== '') {
    return parseBucketSpec(rawBucket);
  }
  return undefined;
}

function claimDefaultAppBucket(sandbox: Sandbox): void {
  let defaultApp: FirebaseApp;
  try {
    defaultApp = defaultClientApp() as FirebaseApp;
  } catch {
    // No [DEFAULT] app initialized yet; only the resolved app claims.
    return;
  }
  const defaultRuntime = resolveClientApp(defaultApp);
  if (defaultRuntime?.sandbox !== sandbox) return;
  claimDefaultStorageBucket(sandbox, appBucketSpec(defaultApp, defaultRuntime.options));
}

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
    let projectId = runtime.options?.projectId;
    try {
      projectId = resolvedApp.options?.projectId;
    } catch {
      // Deleted app: use options captured at attach time.
    }

    const parsedAppBucket = appBucketSpec(resolvedApp, runtime.options);
    claimDefaultAppBucket(sandbox);
    claimDefaultStorageBucket(sandbox, parsedAppBucket);

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
  _options?: { mockUserToken?: EmulatorMockTokenOptions | string },
): void {}
