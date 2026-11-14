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

/**
 * Return an `Auth` handle for `app` (or for the default app when omitted).
 * Local sandboxes use the shared in-process store; remote sandboxes relay to
 * the worker channel.
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
  if (isRemoteSandbox(resolvedApp.sandbox)) {
    return makeRemoteAuth(resolvedApp, resolvedApp.sandbox);
  }
  return makeSandboxAuth(resolvedApp, resolvedApp.sandbox);
}
