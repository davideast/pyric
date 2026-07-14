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

/** Resolve the Firebase-shaped Storage service associated with an app. */
export function getStorage(app?: FirebaseApp, bucketUrl?: string): AppFirebaseStorage {
  const resolvedApp = app ?? defaultClientApp() as FirebaseApp;
  const runtime = resolveClientApp(resolvedApp);
  if (!runtime) throw new TypeError('pyric/storage: unrecognized FirebaseApp handle');
  return runtime.service(`storage/${bucketUrl ?? 'default'}`, () => {
    const { sandbox, session } = runtime;
    const handle = getStorageSandbox(bindOperationContext(sandbox.withAuth(session.currentUser), {
      source: { kind: 'app' },
      authLens: { mode: 'app-session' },
    }));
    return Object.freeze({
      [TARGET_SYMBOL]: { ...handle[TARGET_SYMBOL], currentAuth: () => session.currentUser },
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
