/**
 * Shared `Database`-level shell used by both the local and remote sandbox arms.
 */

import {
  isCustomDatabaseHost,
  parseDatabaseLocationUrl,
} from 'pyric/sandbox/internal';
import type { PyricAdminApp } from '../app/index.js';
import type { Database, Reference } from './types.js';

export interface DatabaseUrlMetadata {
  expectedHost: string | undefined;
  originUrl: string;
}

export interface DatabaseConnectionControls {
  readonly goOffline?: () => void;
  readonly goOnline?: () => void;
}

export function originOfDatabaseUrl(rootUrl: string): string {
  const withoutQuery = rootUrl.split('?')[0]!;
  return withoutQuery.endsWith('/') ? withoutQuery.slice(0, -1) : withoutQuery;
}

export function formatReferenceUrl(originUrl: string, segs: readonly string[]): string {
  if (segs.length === 0) return `${originUrl}/`;
  return `${originUrl}/${segs.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

export function buildDatabaseShell(
  app: PyricAdminApp,
  urlMeta: DatabaseUrlMetadata,
  refFactory: (db: Database, path: string, urlMeta: DatabaseUrlMetadata) => Reference,
  connection?: DatabaseConnectionControls,
): Database {
  const db = {
    ref(path?: string): Reference {
      return refFactory(db as unknown as Database, path ?? '/', urlMeta);
    },
    /** As the SDK parses it: the URL names a location, and for a
     *  `firebaseio.com` database its host must be this database's host. */
    refFromURL(url: string): Reference {
      const location = parseDatabaseLocationUrl(url);
      const expectedHost = urlMeta.expectedHost;
      if (expectedHost !== undefined) {
        if (!isCustomDatabaseHost(expectedHost) && location.host !== expectedHost) {
          throw new Error(
            `FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found ${location.host} but expected ${expectedHost}) `,
          );
        }
      }
      return refFactory(db as unknown as Database, location.path, urlMeta);
    },
    getRules(): Promise<string> {
      throw new Error('pyric-admin/database sandbox: getRules not implemented');
    },
    getRulesJSON(): Promise<object> {
      throw new Error('pyric-admin/database sandbox: getRulesJSON not implemented');
    },
    setRules(_source: string | object | Buffer): Promise<void> {
      throw new Error('pyric-admin/database sandbox: setRules not implemented');
    },
    useEmulator(_host: string, _port: number): void {
      // No-op: the sandbox IS a local emulator.
    },
    goOffline(): void {
      connection?.goOffline?.();
    },
    goOnline(): void {
      connection?.goOnline?.();
    },
    app,
  };
  return db as unknown as Database;
}
