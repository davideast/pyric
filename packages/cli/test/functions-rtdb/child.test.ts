import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  buildFunctionsChildEnv,
  resolveChildDatabaseHost,
  resolveChildModulePath,
  resolveChildProjectId,
} from '../../src/functions-rtdb/child.js';

describe('functions child metadata and environment resolution', () => {
  describe('resolveChildProjectId', () => {
    test('prefers explicit projectId when provided', () => {
      const resolved = resolveChildProjectId('custom-proj', 'other-default-rtdb', {
        PYRIC_PROJECT: 'env-proj',
      });
      expect(resolved).toBe('custom-proj');
    });

    test('prefers PYRIC_PROJECT from environment when explicit projectId is omitted', () => {
      const resolved = resolveChildProjectId(undefined, 'instance-default-rtdb', {
        PYRIC_PROJECT: 'env-proj',
      });
      expect(resolved).toBe('env-proj');
    });

    test('strips -default-rtdb from instance when explicit options are absent', () => {
      const resolved = resolveChildProjectId(undefined, 'my-app-default-rtdb', {});
      expect(resolved).toBe('my-app');
    });

    test('preserves instance without -default-rtdb suffix', () => {
      const resolved = resolveChildProjectId(undefined, 'my-custom-instance', {});
      expect(resolved).toBe('my-custom-instance');
    });

    test('falls back to demo-project when instance is empty', () => {
      const resolved = resolveChildProjectId(undefined, '', {});
      expect(resolved).toBe('demo-project');
    });

    test('falls back to demo-project when all arguments are undefined', () => {
      const resolved = resolveChildProjectId();
      expect(resolved).toBe('demo-project');
    });
  });

  describe('resolveChildDatabaseHost', () => {
    test('returns custom host when provided', () => {
      expect(resolveChildDatabaseHost('custom-host.local')).toBe('custom-host.local');
    });

    test('defaults to firebasedatabase.app when omitted or empty', () => {
      expect(resolveChildDatabaseHost()).toBe('firebasedatabase.app');
      expect(resolveChildDatabaseHost('')).toBe('firebasedatabase.app');
    });
  });

  describe('resolveChildModulePath', () => {
    test('defaults to child.js module path when omitted', () => {
      const path = resolveChildModulePath();
      expect(path).toMatch(/child\.js$/);
    });

    test('converts file: URL to filesystem path', () => {
      const url = new URL('file:///tmp/custom-child.js');
      expect(resolveChildModulePath(url)).toBe(fileURLToPath(url));
    });
  });

  describe('buildFunctionsChildEnv', () => {
    test('injects synthetic GCLOUD_PROJECT and FIREBASE_CONFIG matching sandbox metadata', () => {
      const childEnv = buildFunctionsChildEnv({
        baseEnv: { PATH: '/usr/bin', NODE_OPTIONS: '--inspect' },
        entry: '/app/functions/index.js',
        instance: 'my-sandbox-default-rtdb',
        location: 'us-central1',
        databaseHost: 'firebasedatabase.app',
        projectId: 'my-sandbox',
      });

      expect(childEnv.GCLOUD_PROJECT).toBe('my-sandbox');
      expect(childEnv.PYRIC_FUNCTIONS_RTDB_CHILD).toBe('1');
      expect(childEnv.PYRIC_FUNCTIONS_ENTRY).toBe('/app/functions/index.js');
      expect(childEnv.PYRIC_FUNCTIONS_INSTANCE).toBe('my-sandbox-default-rtdb');
      expect(childEnv.PYRIC_FUNCTIONS_LOCATION).toBe('us-central1');
      expect(childEnv.PYRIC_FUNCTIONS_DATABASE_HOST).toBe('firebasedatabase.app');
      expect(childEnv.PATH).toBe('/usr/bin');
      expect(childEnv.NODE_OPTIONS).toBe('--inspect');

      const config = JSON.parse(childEnv.FIREBASE_CONFIG ?? '{}');
      expect(config).toEqual({
        projectId: 'my-sandbox',
        databaseURL: 'https://my-sandbox-default-rtdb.firebasedatabase.app',
        storageBucket: 'my-sandbox.appspot.com',
      });
    });

    test('overrides host GCLOUD_PROJECT and FIREBASE_CONFIG to guarantee sandbox isolation', () => {
      const dirtyHostEnv = {
        GCLOUD_PROJECT: 'corp-production-gcp-project',
        FIREBASE_CONFIG: JSON.stringify({
          projectId: 'corp-production-gcp-project',
          databaseURL: 'https://corp-production-gcp-project.firebaseio.com',
        }),
        SOME_OTHER_VAR: 'preserved',
      };

      const childEnv = buildFunctionsChildEnv({
        baseEnv: dirtyHostEnv,
        entry: '/app/functions/index.js',
        instance: 'sandbox-app-default-rtdb',
        location: 'europe-west1',
        databaseHost: 'firebasedatabase.app',
        projectId: 'sandbox-app',
      });

      // Crucial security guarantee: host production variables must NOT bleed into sandbox child
      expect(childEnv.GCLOUD_PROJECT).toBe('sandbox-app');
      expect(childEnv.SOME_OTHER_VAR).toBe('preserved');

      const config = JSON.parse(childEnv.FIREBASE_CONFIG ?? '{}');
      expect(config.projectId).toBe('sandbox-app');
      expect(config.databaseURL).toBe('https://sandbox-app-default-rtdb.firebasedatabase.app');
      expect(config.storageBucket).toBe('sandbox-app.appspot.com');
    });
  });
});
