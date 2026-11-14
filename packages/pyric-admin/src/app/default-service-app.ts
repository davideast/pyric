/**
 * Default-app resolution for no-argument `pyric-admin` service factories.
 *
 * `getApp()` in `pyric-admin/app` always throws `app/no-app` when `[DEFAULT]`
 * has not been registered so `try { getApp() } catch { initializeApp(options) }`
 * and `firebase-functions`'s internal `"__FIREBASE_FUNCTIONS_SDK__"` fallback
 * work identically to upstream `firebase-admin`. Only no-argument service
 * factories (`getFirestore()`, `getDatabase()`, `getStorage()`, `getAuth()`,
 * `getMessaging()`, `getAppCheck()`, and deferred service accessors) call
 * {@link getDefaultServiceApp}, which lazily creates `[DEFAULT]` when isolated
 * Functions child runtimes enable {@link LAZY_DEFAULT_AMBIENT_APP} and marks it
 * upgradable by a subsequent explicit `initializeApp(options)` call.
 */
import { LAZY_DEFAULT_AMBIENT_APP } from 'pyric/sandbox/internal';
import {
  DEFAULT_APP_NAME,
  getApp,
  getApps,
  initializeApp,
  type PyricAdminApp,
} from './index.js';
import { IMPLICIT_DEFAULT_APPS } from './lifecycle.js';

interface ImplicitDefaultGlobal {
  [LAZY_DEFAULT_AMBIENT_APP]?: boolean;
  [IMPLICIT_DEFAULT_APPS]?: WeakSet<PyricAdminApp>;
}

function implicitDefaultApps(): WeakSet<PyricAdminApp> {
  const globalState = globalThis as ImplicitDefaultGlobal;
  globalState[IMPLICIT_DEFAULT_APPS] ??= new WeakSet<PyricAdminApp>();
  return globalState[IMPLICIT_DEFAULT_APPS];
}

export function getDefaultServiceApp(): PyricAdminApp {
  const hasDefault = getApps().some((app) => app.name === DEFAULT_APP_NAME);
  if (hasDefault) {
    return getApp(DEFAULT_APP_NAME);
  }
  const globalState = globalThis as ImplicitDefaultGlobal;
  if (globalState[LAZY_DEFAULT_AMBIENT_APP] === true) {
    const created = initializeApp();
    implicitDefaultApps().add(created);
    return created;
  }
  return getApp(DEFAULT_APP_NAME);
}
