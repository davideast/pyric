/**
 * `pyric-admin/database` — sandbox mirror for the admin-shape RTDB surface.
 *
 * Routes `getDatabase` / `getDatabaseWithUrl` to either the in-process tree
 * (`local-database.ts`) or the SharedWorker remote relay (`remote-database.ts`)
 * based on the sandbox brand carried by `PyricAdminApp`.
 */

import { isRemoteSandbox, type Sandbox } from 'pyric/sandbox';
import {
  createDatabaseInstanceRegistry,
  defaultDatabaseInstance,
  isDefaultDatabaseInstance,
  parseDatabaseLocationUrl,
  parseDatabaseUrl,
  SANDBOX_PROJECT_ID,
  type DatabaseInstance,
  type DatabaseInstanceRegistry,
} from 'pyric/sandbox/internal';
import { increment, serverTimestamp } from 'pyric/database';
import { deferredExport } from 'pyric/app/internal';
import {
  ADMIN_APP_TARGET,
  getApp,
  type PyricAdminApp,
} from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import { explicitProjectId } from '../app/project-id.js';
import {
  originOfDatabaseUrl,
  type DatabaseUrlMetadata,
} from './database-shell.js';
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

interface CachedAppDatabase {
  db?: Database;
  urlMeta?: DatabaseUrlMetadata;
}

const databasesByApp = new WeakMap<PyricAdminApp, DatabaseInstanceRegistry<CachedAppDatabase>>();

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
    const resolved = resolveAdminDatabaseTarget(resolvedApp, url);
    let registry = databasesByApp.get(resolvedApp);
    if (registry === undefined) {
      registry = createDatabaseInstanceRegistry({ create: () => ({}) });
      databasesByApp.set(resolvedApp, registry);
    }
    const entry = registry.getOrCreate(registry.keyOf(resolved.routingInstance));
    if (entry.urlMeta === undefined) {
      entry.urlMeta = {
        expectedHost: resolved.expectedHost,
        originUrl: resolved.originUrl,
      };
    } else if (resolved.expectedHost !== undefined && entry.urlMeta.expectedHost === undefined) {
      entry.urlMeta.expectedHost = resolved.expectedHost;
      entry.urlMeta.originUrl = resolved.originUrl;
    }
    entry.db ??= buildSandboxDatabase(
      resolvedApp,
      resolvedApp.sandbox,
      resolved.routingInstance,
      entry.urlMeta,
    );
    return entry.db;
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

function resolveAdminDatabaseTarget(
  app: PyricAdminApp,
  url: string | undefined,
): {
  routingInstance: DatabaseInstance | undefined;
  expectedHost: string | undefined;
  originUrl: string;
} {
  if (url === '') throw invalidDatabaseUrl();
  const source = url ?? app.options.databaseURL;
  const projectId = explicitProjectId(app);
  if (source === undefined) {
    const fallback = defaultDatabaseInstance(projectId ?? SANDBOX_PROJECT_ID);
    return {
      routingInstance: undefined,
      expectedHost: undefined,
      originUrl: originOfDatabaseUrl(fallback.url),
    };
  }
  const instance = parseDatabaseUrl(source);
  const expectedHost = parseDatabaseLocationUrl(source).host;
  const isProjectDefault = isDefaultDatabaseInstance(instance.name, projectId);
  return {
    routingInstance: isProjectDefault ? undefined : instance,
    expectedHost,
    originUrl: originOfDatabaseUrl(instance.url),
  };
}

function buildSandboxDatabase(
  app: PyricAdminApp,
  sandbox: Sandbox,
  instance: DatabaseInstance | undefined,
  urlMeta: DatabaseUrlMetadata,
): Database {
  if (isRemoteSandbox(sandbox)) {
    return getRemoteDatabase(app, sandbox, instance, urlMeta);
  }
  return getLocalDatabase(app, sandbox, instance, urlMeta);
}
