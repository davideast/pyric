/**
 * Shared `Database`-level shell used by both the local and remote sandbox arms.
 */

import {
  isCustomDatabaseHost,
  parseDatabaseLocationUrl,
} from 'pyric/sandbox/internal';
import type { PyricAdminApp } from '../app/index.js';
import type { AdminServiceLifecycle } from '../app/lifecycle.js';
import type { DatabaseRulesControls } from './admin-rules.js';
import {
  isAdminReference,
  type Database,
  type Reference,
} from './types.js';

export interface DatabaseUrlMetadata {
  readonly expectedHost: string;
  readonly originUrl: string;
}

export interface DatabaseConnectionControls {
  readonly goOffline?: () => void;
  readonly goOnline?: () => void;
}

const POST_START_EMULATOR_ERROR =
  'FIREBASE FATAL ERROR: connectDatabaseEmulator() cannot initialize or alter the emulator configuration after the database instance has started. ';
const ADMIN_MOCK_USER_TOKEN_ERROR =
  'FIREBASE FATAL ERROR: mockUserToken is not supported by the Admin SDK. For client access with mock users, please use the "firebase" package instead of "firebase-admin". ';

export function originOfDatabaseUrl(rootUrl: string): string {
  const qIndex = rootUrl.indexOf('?');
  let withoutQuery = rootUrl;
  if (qIndex >= 0) {
    withoutQuery = rootUrl.slice(0, qIndex);
  }
  if (withoutQuery.endsWith('/')) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery;
}

export function formatReferenceUrl(originUrl: string, segs: readonly string[]): string {
  if (segs.length === 0) return `${originUrl}/`;
  return `${originUrl}/${segs.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function serializeEmulatorOptions(options: unknown): string {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return JSON.stringify(options ?? {});
  }
  const record = options as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return JSON.stringify(sorted);
}

export function buildDatabaseShell(
  app: PyricAdminApp,
  urlMeta: DatabaseUrlMetadata,
  refFactory: (db: Database, path: string, urlMeta: DatabaseUrlMetadata) => Reference,
  connection?: DatabaseConnectionControls,
  lifecycle?: AdminServiceLifecycle,
  rulesControls?: DatabaseRulesControls,
): Database {
  let activeUrlMeta: DatabaseUrlMetadata = {
    expectedHost: urlMeta.expectedHost,
    originUrl: urlMeta.originUrl,
  };
  let instanceStarted = false;
  let configuredEmulatorOptionsJson: string | null = null;

  const assertDatabaseActive = (method: string): void => {
    if (lifecycle?.isDeleted === true) {
      throw new Error(`FIREBASE FATAL ERROR: Cannot call ${method} on a deleted database. `);
    }
  };

  const db = {
    ref(path?: string | Reference): Reference {
      assertDatabaseActive('ref');
      instanceStarted = true;
      if (isAdminReference(path)) {
        return db.refFromURL(path.toString());
      }
      if (path !== undefined && (typeof path !== 'string' || path.length === 0)) {
        throw new Error(
          `child failed: path argument was an invalid path = "${String(path)}". Paths must be non-empty strings and can't contain ".", "#", "$", "[", or "]"`,
        );
      }
      return refFactory(db as unknown as Database, path ?? '/', activeUrlMeta);
    },
    /** As the SDK parses it: the URL names a location, and for a
     *  `firebaseio.com` database its host must be this database's host. */
    refFromURL(url: string): Reference {
      assertDatabaseActive('refFromURL');
      instanceStarted = true;
      const location = parseDatabaseLocationUrl(url);
      const expectedHost = activeUrlMeta.expectedHost;
      if (!isCustomDatabaseHost(expectedHost) && location.host !== expectedHost) {
        throw new Error(
          `FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found ${location.host} but expected ${expectedHost}) `,
        );
      }
      return refFactory(db as unknown as Database, location.path, activeUrlMeta);
    },
    getRules(): Promise<string> {
      assertDatabaseActive('getRules');
      instanceStarted = true;
      if (rulesControls === undefined) {
        return Promise.reject(new Error('pyric-admin/database sandbox: getRules not configured'));
      }
      return rulesControls.getRules();
    },
    getRulesJSON(): Promise<object> {
      assertDatabaseActive('getRulesJSON');
      instanceStarted = true;
      if (rulesControls === undefined) {
        return Promise.reject(new Error('pyric-admin/database sandbox: getRulesJSON not configured'));
      }
      return rulesControls.getRulesJSON();
    },
    setRules(source: string | object | Buffer): Promise<void> {
      assertDatabaseActive('setRules');
      instanceStarted = true;
      if (rulesControls === undefined) {
        return Promise.reject(new Error('pyric-admin/database sandbox: setRules not configured'));
      }
      return rulesControls.setRules(source);
    },
    useEmulator(host: string, port: number, options: { mockUserToken?: unknown } = {}): void {
      assertDatabaseActive('useEmulator');
      const hostAndPort = `${host}:${port}`;
      const optionsJson = serializeEmulatorOptions(options);
      if (instanceStarted) {
        if (
          configuredEmulatorOptionsJson !== null &&
          hostAndPort === activeUrlMeta.expectedHost &&
          optionsJson === configuredEmulatorOptionsJson
        ) {
          return;
        }
        throw new Error(POST_START_EMULATOR_ERROR);
      }
      if (Boolean(options && options.mockUserToken)) {
        throw new Error(ADMIN_MOCK_USER_TOKEN_ERROR);
      }
      const normalizedHost = hostAndPort.toLowerCase();
      activeUrlMeta = {
        expectedHost: normalizedHost,
        originUrl: `http://${normalizedHost}`,
      };
      configuredEmulatorOptionsJson = optionsJson;
    },
    goOffline(): void {
      assertDatabaseActive('goOffline');
      instanceStarted = true;
      connection?.goOffline?.();
    },
    goOnline(): void {
      assertDatabaseActive('goOnline');
      instanceStarted = true;
      connection?.goOnline?.();
    },
    app,
  };
  return db as unknown as Database;
}
