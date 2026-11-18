/**
 * `getAuth` entry routing for `pyric-admin/auth`.
 */
import { isRemoteSandbox } from 'pyric/sandbox';
import {
  ADMIN_APP_TARGET,
  type PyricAdminApp,
} from '../app/index.js';
import { getDefaultServiceApp } from '../app/default-service-app.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import { makeSandboxAuth } from './local-auth.js';
import { makeRemoteAuth } from './remote-auth.js';
import type { Auth } from './types.js';

const authHandles = new WeakMap<PyricAdminApp, Auth>();

/**
 * Return an `Auth` handle for `app` (or for the default app when omitted),
 * caching one handle per active `PyricAdminApp`. Local sandboxes use the shared
 * in-process store; remote sandboxes relay to the worker channel.
 */
export function getAuth(app?: PyricAdminApp): Auth {
  let resolvedApp = app;
  if (resolvedApp === undefined) {
    resolvedApp = getDefaultServiceApp();
  }
  if (resolvedApp === null || typeof resolvedApp !== 'object' || !(ADMIN_APP_TARGET in resolvedApp)) {
    throw new TypeError(
      'pyric-admin/auth: getAuth expected a PyricAdminApp (from pyric-admin/app#initializeApp). ' +
        'Received a value with no ADMIN_APP_TARGET brand. Pass the handle returned by ' +
        '`initializeApp({ sandbox })`.',
    );
  }
  assertAdminAppActive(resolvedApp);
  if (resolvedApp[ADMIN_APP_TARGET] !== 'sandbox') {
    throw new TypeError('pyric-admin/auth: getAuth expected a sandbox admin app.');
  }
  const cached = authHandles.get(resolvedApp);
  if (cached !== undefined) {
    return cached;
  }
  let created: Auth;
  if (isRemoteSandbox(resolvedApp.sandbox)) {
    created = makeRemoteAuth(resolvedApp, resolvedApp.sandbox);
  } else {
    created = makeSandboxAuth(resolvedApp, resolvedApp.sandbox);
  }
  authHandles.set(resolvedApp, created);
  return created;
}
