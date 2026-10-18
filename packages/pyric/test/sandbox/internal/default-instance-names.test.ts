/**
 * The names of a project's default RTDB instance (#1062).
 *
 * A project created before about 2020 has its default instance at
 * `https://<projectId>.firebaseio.com`; a newer one at
 * `https://<projectId>-default-rtdb.firebaseio.com` or a regional
 * `firebasedatabase.app` host. Pyric treats both names as the default
 * instance, and one shared check decides it for every plane.
 *
 * The check is by instance name, as every Pyric per-instance structure keys
 * instances by name: the host and the `ns=` query parameter do not change
 * which instance a name is.
 */
import { describe, expect, test } from 'bun:test';
import * as instances from '../../../src/sandbox/internal/instances.js';

type IsDefault = (name: string, projectId: string | undefined) => boolean;

/** The shared check, or a failure naming it while it does not exist. */
function isDefaultDatabaseInstance(name: string, projectId: string | undefined): boolean {
  const check = (instances as unknown as { isDefaultDatabaseInstance?: IsDefault }).isDefaultDatabaseInstance;
  if (typeof check !== 'function') throw new Error('pyric/sandbox/internal exports no isDefaultDatabaseInstance');
  return check(name, projectId);
}

describe('isDefaultDatabaseInstance', () => {
  test('the project id is the legacy name of the default instance', () => {
    expect(isDefaultDatabaseInstance('demo-app', 'demo-app')).toBe(true);
  });

  test('<projectId>-default-rtdb is the default instance', () => {
    expect(isDefaultDatabaseInstance('demo-app-default-rtdb', 'demo-app')).toBe(true);
  });

  test('any other name is not the default instance', () => {
    for (const name of ['demo-app-shard-1', 'other-app', 'other-app-default-rtdb', 'demo', 'demo-app-default']) {
      expect(isDefaultDatabaseInstance(name, 'demo-app')).toBe(false);
    }
  });

  test('without a project id no name is the default instance', () => {
    expect(isDefaultDatabaseInstance('demo-app', undefined)).toBe(false);
    expect(isDefaultDatabaseInstance('demo-app-default-rtdb', undefined)).toBe(false);
    expect(isDefaultDatabaseInstance('', '')).toBe(false);
    expect(isDefaultDatabaseInstance('-default-rtdb', '')).toBe(false);
  });

  test('the unnamed default key is left to the caller', () => {
    expect(isDefaultDatabaseInstance(instances.UNNAMED_DEFAULT_DATABASE_INSTANCE, 'demo-app')).toBe(false);
  });

  test('a name from any URL form of either name is the default instance', () => {
    const urls = [
      'https://demo-app.firebaseio.com',
      'HTTPS://DEMO-APP.FIREBASEIO.COM/',
      'https://demo-app-default-rtdb.firebaseio.com',
      'https://demo-app-default-rtdb.europe-west1.firebasedatabase.app',
      // The legacy form has no regional host in production; the name decides.
      'https://demo-app.europe-west1.firebasedatabase.app',
      'http://127.0.0.1:9000?ns=demo-app',
      'http://localhost:9000/?ns=demo-app-default-rtdb',
      'https://shared-host.firebaseio.com?ns=demo-app',
    ];
    for (const url of urls) {
      expect([url, isDefaultDatabaseInstance(instances.parseDatabaseUrl(url).name, 'demo-app')]).toEqual([url, true]);
    }
  });

  test('a namespace whose case differs from the project id is another instance, as ns= keeps case', () => {
    expect(isDefaultDatabaseInstance(instances.parseDatabaseUrl('http://127.0.0.1:9000?ns=Demo-App').name, 'demo-app')).toBe(false);
  });
});
