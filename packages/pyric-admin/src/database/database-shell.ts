/**
 * Shared `Database`-level shell used by both the local and remote sandbox arms.
 */

import {
  isCustomDatabaseHost,
  parseDatabaseLocationUrl,
  type DatabaseInstance,
} from 'pyric/sandbox/internal';
import type { Database, Reference } from './types.js';

export function buildDatabaseShell(
  instance: DatabaseInstance | undefined,
  refFactory: (db: Database, path: string) => Reference,
): Database {
  const db = {
    ref(path?: string): Reference {
      return refFactory(db as unknown as Database, path ?? '/');
    },
    /** As the SDK parses it: the URL names a location, and for a
     *  `firebaseio.com` database its host must be this database's host. */
    refFromURL(url: string): Reference {
      const location = parseDatabaseLocationUrl(url);
      if (instance !== undefined) {
        const expectedHost = parseDatabaseLocationUrl(instance.url).host;
        if (!isCustomDatabaseHost(expectedHost) && location.host !== expectedHost) {
          throw new Error(
            `FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found ${location.host} but expected ${expectedHost}) `,
          );
        }
      }
      return refFactory(db as unknown as Database, location.path);
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
      // No-op: sandbox has no network connection to drop.
    },
    goOnline(): void {
      // No-op: sandbox has no network connection to reopen.
    },
    app: undefined,
  };
  return db as unknown as Database;
}
