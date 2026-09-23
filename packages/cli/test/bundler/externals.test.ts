import { describe, expect, test } from 'bun:test';
import {
  PYRIC_EXTERNAL_PACKAGES,
  createPyricBundlerPlugin,
  isPyricExternal,
  pyricEsbuildExternals,
  pyricExternals,
  pyricRollupExternals,
  pyricWebpackExternals,
} from '../../src/bundler/externals.js';

describe('bundler externalization presets and predicate', () => {
  describe('isPyricExternal', () => {
    test('returns true for firebase-admin root and subpaths', () => {
      expect(isPyricExternal('firebase-admin')).toBe(true);
      expect(isPyricExternal('firebase-admin/app')).toBe(true);
      expect(isPyricExternal('firebase-admin/firestore')).toBe(true);
      expect(isPyricExternal('firebase-admin/auth')).toBe(true);
      expect(isPyricExternal('firebase-admin/database')).toBe(true);
      expect(isPyricExternal('firebase-admin/messaging')).toBe(true);
    });

    test('returns true for firebase client root and subpaths', () => {
      expect(isPyricExternal('firebase')).toBe(true);
      expect(isPyricExternal('firebase/app')).toBe(true);
      expect(isPyricExternal('firebase/firestore')).toBe(true);
      expect(isPyricExternal('firebase/auth')).toBe(true);
      expect(isPyricExternal('firebase/database')).toBe(true);
      expect(isPyricExternal('firebase/storage')).toBe(true);
    });

    test('returns true for @firebase scoped packages', () => {
      expect(isPyricExternal('@firebase/app')).toBe(true);
      expect(isPyricExternal('@firebase/firestore')).toBe(true);
      expect(isPyricExternal('@firebase/util')).toBe(true);
    });

    test('returns false for third-party libraries', () => {
      expect(isPyricExternal('express')).toBe(false);
      expect(isPyricExternal('hono')).toBe(false);
      expect(isPyricExternal('pg')).toBe(false);
      expect(isPyricExternal('dotenv')).toBe(false);
      expect(isPyricExternal('lodash')).toBe(false);
    });

    test('returns true for transitive google cloud backend-SDK dependencies and subpaths', () => {
      expect(isPyricExternal('@google-cloud/storage')).toBe(true);
      expect(isPyricExternal('@google-cloud/storage/build/cjs/src/bucket')).toBe(true);
      expect(isPyricExternal('@google-cloud/firestore')).toBe(true);
      expect(isPyricExternal('@google-cloud/firestore/build/src/index')).toBe(true);
      expect(isPyricExternal('google-auth-library')).toBe(true);
      expect(isPyricExternal('google-auth-library/build/src/auth/googleauth')).toBe(true);
    });

    test('returns false for unrelated google libraries', () => {
      expect(isPyricExternal('@google/genai')).toBe(false);
    });

    test('returns false for partial name overlaps', () => {
      expect(isPyricExternal('firebase-tools')).toBe(false);
      expect(isPyricExternal('firebase-mock')).toBe(false);
      expect(isPyricExternal('my-firebase-app')).toBe(false);
    });

    test('returns false for empty or non-string inputs', () => {
      expect(isPyricExternal('')).toBe(false);
      expect(isPyricExternal(null as unknown as string)).toBe(false);
      expect(isPyricExternal(undefined as unknown as string)).toBe(false);
    });
  });

  describe('pyricRollupExternals', () => {
    test('matches firebase-admin, firebase, @firebase, and transitive Google Cloud packages', () => {
      const matchesAny = (id: string): boolean =>
        pyricRollupExternals.some((regex) => regex.test(id));

      expect(matchesAny('firebase-admin')).toBe(true);
      expect(matchesAny('firebase-admin/firestore')).toBe(true);
      expect(matchesAny('firebase')).toBe(true);
      expect(matchesAny('firebase/app')).toBe(true);
      expect(matchesAny('@firebase/app')).toBe(true);
      expect(matchesAny('@google-cloud/firestore')).toBe(true);
      expect(matchesAny('@google-cloud/storage')).toBe(true);
      expect(matchesAny('google-auth-library')).toBe(true);
    });

    test('rejects unrelated packages and partial overlaps', () => {
      const matchesAny = (id: string): boolean =>
        pyricRollupExternals.some((regex) => regex.test(id));

      expect(matchesAny('express')).toBe(false);
      expect(matchesAny('firebase-tools')).toBe(false);
      expect(matchesAny('@google/genai')).toBe(false);
    });
  });

  describe('pyricEsbuildExternals', () => {
    test('contains expected root and wildcard patterns for esbuild/tsup', () => {
      expect(pyricEsbuildExternals).toContain('firebase-admin');
      expect(pyricEsbuildExternals).toContain('firebase-admin/*');
      expect(pyricEsbuildExternals).toContain('firebase');
      expect(pyricEsbuildExternals).toContain('firebase/*');
      expect(pyricEsbuildExternals).toContain('@firebase/*');
      expect(pyricEsbuildExternals).toContain('google-auth-library');
      expect(pyricEsbuildExternals).toContain('google-auth-library/*');
      expect(pyricEsbuildExternals).toContain('@google-cloud/*');
    });
  });

  describe('PYRIC_EXTERNAL_PACKAGES and bundler interlock plugins', () => {
    test('PYRIC_EXTERNAL_PACKAGES includes Firebase and transitive Google Cloud packages', () => {
      expect(PYRIC_EXTERNAL_PACKAGES).toContain('firebase-admin');
      expect(PYRIC_EXTERNAL_PACKAGES).toContain('firebase');
      expect(PYRIC_EXTERNAL_PACKAGES).toContain('google-auth-library');
      expect(PYRIC_EXTERNAL_PACKAGES).toContain('@google-cloud/firestore');
      expect(PYRIC_EXTERNAL_PACKAGES).toContain('@google-cloud/storage');
    });

    test('createPyricBundlerPlugin implements Rollup/Vite resolveId, Vite ssr.external, and esbuild setup', () => {
      const plugin = createPyricBundlerPlugin();
      expect(plugin.name).toBe('pyric-bundler-interlock');

      expect(plugin.resolveId('firebase-admin/firestore')).toEqual({
        id: 'firebase-admin/firestore',
        external: true,
      });
      expect(plugin.resolveId('@google-cloud/firestore')).toEqual({
        id: '@google-cloud/firestore',
        external: true,
      });
      expect(plugin.resolveId('express')).toBeNull();

      const viteConfig = plugin.config();
      expect(viteConfig.ssr.external).toContain('firebase-admin');
      expect(viteConfig.ssr.external).toContain('@google-cloud/firestore');
      expect(viteConfig.ssr.external).toContain('google-auth-library');

      let registeredCallback: ((args: { path: string }) => { path: string; external: true } | undefined) | undefined;
      plugin.setup({
        onResolve(_opts, cb) {
          registeredCallback = cb;
        },
      });
      expect(registeredCallback).toBeDefined();
      expect(registeredCallback!({ path: 'google-auth-library/build/src/index' })).toEqual({
        path: 'google-auth-library/build/src/index',
        external: true,
      });
      expect(registeredCallback!({ path: 'lodash' })).toBeUndefined();
    });

    test('pyricWebpackExternals marks Pyric-intercepted specifiers as commonjs externals', () => {
      const results: Array<{ err?: Error | null; result?: string }> = [];
      pyricWebpackExternals({}, '@google-cloud/firestore', (err, result) => {
        results.push({ err, result });
      });
      pyricWebpackExternals({}, 'express', (err, result) => {
        results.push({ err, result });
      });
      expect(results[0]).toEqual({ err: null, result: 'commonjs @google-cloud/firestore' });
      expect(results[1]).toEqual({ err: undefined, result: undefined });
    });
  });

  describe('pyricExternals presets', () => {
    test('maps bundler aliases to their supported pattern formats', () => {
      expect(pyricExternals.rolldown).toBe(pyricRollupExternals);
      expect(pyricExternals.rollup).toBe(pyricRollupExternals);
      expect(pyricExternals.vite).toBe(pyricRollupExternals);
      expect(pyricExternals.webpack).toBe(pyricRollupExternals);
      expect(pyricExternals.esbuild).toBe(pyricEsbuildExternals);
      expect(pyricExternals.tsup).toBe(pyricEsbuildExternals);
    });
  });
});

