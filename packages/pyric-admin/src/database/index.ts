/**
 * `pyric-admin/database` — sandbox mirror for the admin-shape RTDB surface.
 *
 * Routes `getDatabase` / `getDatabaseWithUrl` to either the in-process tree
 * (`local-database.ts`) or the SharedWorker remote relay (`remote-database.ts`)
 * based on the sandbox brand carried by `PyricAdminApp`.
 */

import { isRemoteSandbox, type Sandbox } from 'pyric/sandbox';
import {
  isDefaultDatabaseInstance,
  parseDatabaseUrl,
  type DatabaseInstance,
} from 'pyric/sandbox/internal';
import { increment, serverTimestamp } from 'pyric/database';
import { deferredExport } from 'pyric/app/internal';
import {
  ADMIN_APP_TARGET,
  getApp,
  type PyricAdminApp,
} from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import { getLocalDatabase } from './local-database.js';
import { getRemoteDatabase } from './remote-database.js';
import type { Database } from './types.js';

export type {
  Database,
  DataSnapshot,
  EventType,
  OnDisconnect,
  Query,
  Reference,
  ThenableReference,
} from './types.js';

/** `firebase-admin/database`'s `enableLogging` (deferred in the sandbox). */
export const enableLogging = deferredExport('pyric-admin/database', 'enableLogging');

/** Mirror of `firebase-admin/database`'s `ServerValue` constant and sentinel constructors. */
export const ServerValue: {
  readonly TIMESTAMP: object;
  readonly increment: (delta: number) => object;
} = {
  TIMESTAMP: serverTimestamp(),
  increment: (delta: number) => increment(delta),
};

/**
 * Returns the {@link Database} service for the supplied app (or the default
 * app when omitted), optionally scoped to the RTDB instance `url` names.
 */
export function getDatabase(
  app?: PyricAdminApp,
  url?: string,
): Database {
  const resolvedApp = app ?? getApp();
  assertAdminAppActive(resolvedApp);
  if (resolvedApp[ADMIN_APP_TARGET] === 'sandbox') {
    return getSandboxDatabase(resolvedApp.sandbox, adminDatabaseInstance(resolvedApp, url));
  }
  throw new TypeError(
    'pyric-admin/database: getDatabase expected a PyricAdminApp ' +
      '(initialize via `initializeApp` from pyric-admin/app).',
  );
}

/**
 * Returns the {@link Database} service for the RTDB instance `url` names,
 * matching `firebase-admin/database`'s `getDatabaseWithUrl(url, app?)`.
 */
export function getDatabaseWithUrl(
  url: string,
  app?: PyricAdminApp,
): Database {
  if (typeof url !== 'string' || url === '') {
    throw invalidDatabaseUrl();
  }
  return getDatabase(app, url);
}

function invalidDatabaseUrl(): Error {
  return Object.assign(
    new Error('Database URL must be a valid, non-empty URL string.'),
    { code: 'database/invalid-argument' },
  );
}

function adminDatabaseInstance(
  app: PyricAdminApp,
  url: string | undefined,
): DatabaseInstance | undefined {
  if (url === '') throw invalidDatabaseUrl();
  const source = url ?? app.options.databaseURL;
  if (source === undefined) return undefined;
  const instance = parseDatabaseUrl(source);
  const projectId = app.options.projectId;
  const isProjectDefault = isDefaultDatabaseInstance(instance.name, projectId);
  return isProjectDefault ? undefined : instance;
}

function getSandboxDatabase(sandbox: Sandbox, instance: DatabaseInstance | undefined): Database {
  if (isRemoteSandbox(sandbox)) {
    return getRemoteDatabase(sandbox, instance);
  }
  return getLocalDatabase(sandbox, instance);
}
