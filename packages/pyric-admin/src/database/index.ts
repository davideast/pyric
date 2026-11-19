/**
 * `pyric-admin/database` — sandbox mirror for the admin-shape RTDB surface.
 *
 * Routes `getDatabase` / `getDatabaseWithUrl` to either the in-process tree
 * (`local-database.ts`) or the SharedWorker remote relay (`remote-database.ts`)
 * based on the sandbox brand carried by `PyricAdminApp`.
 */

import { isRemoteSandbox, type Sandbox } from 'pyric/sandbox';
import {
  defaultDatabaseInstance,
  isDefaultDatabaseInstance,
  parseDatabaseLocationUrl,
  parseDatabaseUrl,
  SANDBOX_PROJECT_ID,
  type DatabaseInstance,
} from 'pyric/sandbox/internal';
import { increment, serverTimestamp } from 'pyric/database';
import {
  ADMIN_APP_TARGET,
  type PyricAdminApp,
} from '../app/index.js';
import { getDefaultServiceApp } from '../app/default-service-app.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import { explicitProjectId } from '../app/project-id.js';
import {
  originOfDatabaseUrl,
  type DatabaseUrlMetadata,
} from './database-shell.js';
import { FirebaseDatabaseError } from './error.js';
import { getLocalDatabase } from './local-database.js';
import { getRemoteDatabase } from './remote-database.js';
import type { Database } from './types.js';

export { FirebaseDatabaseError } from './error.js';
export { enableLogging } from './logging.js';
export type {
  Database,
  DataSnapshot,
  EventType,
  OnDisconnect,
  Query,
  Reference,
  ThenableReference,
} from './types.js';

/** Mirror of `firebase-admin/database`'s `ServerValue` constant and sentinel constructors. */
export const ServerValue: {
  readonly TIMESTAMP: object;
  readonly increment: (delta: number) => object;
} = {
  TIMESTAMP: serverTimestamp(),
  increment: (delta: number) => increment(delta),
};

const databasesByApp = new WeakMap<PyricAdminApp, Map<string, Database>>();
const rawDatabaseUrlsByApp = new WeakMap<PyricAdminApp, Map<string, string>>();

/**
 * Returns the {@link Database} service for the supplied app (or the default
 * app when omitted), optionally scoped to the RTDB instance `url` names.
 */
export function getDatabase(
  app?: PyricAdminApp,
  url?: string,
): Database {
  const resolvedApp = app ?? getDefaultServiceApp();
  assertAdminAppActive(resolvedApp);
  if (resolvedApp[ADMIN_APP_TARGET] === 'sandbox') {
    const resolved = resolveAdminDatabaseTarget(resolvedApp, url);
    let handles = databasesByApp.get(resolvedApp);
    if (handles === undefined) {
      handles = new Map();
      databasesByApp.set(resolvedApp, handles);
    }
    let rawUrls = rawDatabaseUrlsByApp.get(resolvedApp);
    if (rawUrls === undefined) {
      rawUrls = new Map();
      rawDatabaseUrlsByApp.set(resolvedApp, rawUrls);
    }
    if (resolved.rawUrl !== undefined) {
      const existingRaw = rawUrls.get(resolved.cacheKey);
      if (existingRaw !== undefined && existingRaw !== resolved.rawUrl) {
        throw new Error(
          'FIREBASE FATAL ERROR: Database initialized multiple times. Please make sure the format of the database URL matches with each database() call. ',
        );
      }
      rawUrls.set(resolved.cacheKey, resolved.rawUrl);
    }
    let db = handles.get(resolved.cacheKey);
    if (db === undefined) {
      db = buildSandboxDatabase(
        resolvedApp,
        resolvedApp.sandbox,
        resolved.cacheKey,
        resolved.routingInstance,
        resolved.urlMeta,
      );
      handles.set(resolved.cacheKey, db);
    }
    return db;
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

function invalidDatabaseUrl(): FirebaseDatabaseError {
  return new FirebaseDatabaseError({
    code: 'invalid-argument',
    message: 'Database URL must be a valid, non-empty URL string.',
  });
}

function resolveAdminDatabaseTarget(
  app: PyricAdminApp,
  url: string | undefined,
): {
  cacheKey: string;
  rawUrl: string | undefined;
  routingInstance: DatabaseInstance | undefined;
  urlMeta: DatabaseUrlMetadata;
} {
  if (url === '') throw invalidDatabaseUrl();
  const source = url ?? app.options.databaseURL;
  const projectId = explicitProjectId(app);
  if (source === undefined) {
    const fallback = defaultDatabaseInstance(projectId ?? SANDBOX_PROJECT_ID);
    const fallbackHost = parseDatabaseLocationUrl(fallback.url).host;
    return {
      cacheKey: fallback.url,
      rawUrl: undefined,
      routingInstance: undefined,
      urlMeta: {
        expectedHost: fallbackHost,
        originUrl: originOfDatabaseUrl(fallback.url),
      },
    };
  }
  const instance = parseDatabaseUrl(source);
  const expectedHost = parseDatabaseLocationUrl(source).host;
  const isProjectDefault = isDefaultDatabaseInstance(instance.name, projectId);
  let routingInstance: DatabaseInstance | undefined;
  if (isProjectDefault === false) {
    routingInstance = instance;
  }
  return {
    cacheKey: instance.url,
    rawUrl: source,
    routingInstance,
    urlMeta: {
      expectedHost,
      originUrl: originOfDatabaseUrl(instance.url),
    },
  };
}

function buildSandboxDatabase(
  app: PyricAdminApp,
  sandbox: Sandbox,
  cacheKey: string,
  instance: DatabaseInstance | undefined,
  urlMeta: DatabaseUrlMetadata,
): Database {
  if (isRemoteSandbox(sandbox)) {
    return getRemoteDatabase(app, sandbox, cacheKey, instance, urlMeta);
  }
  return getLocalDatabase(app, sandbox, cacheKey, instance, urlMeta);
}
