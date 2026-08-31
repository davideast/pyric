import { describe, expect, test } from 'bun:test';
import {
  isPyricExternal,
  pyricEsbuildExternals,
  pyricExternals,
  pyricRollupExternals,
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

    test('returns false for unrelated google cloud libraries', () => {
      expect(isPyricExternal('@google-cloud/storage')).toBe(false);
      expect(isPyricExternal('@google-cloud/firestore')).toBe(false);
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
    test('matches firebase-admin, firebase, and @firebase packages', () => {
      const matchesAny = (id: string): boolean =>
        pyricRollupExternals.some((regex) => regex.test(id));

      expect(matchesAny('firebase-admin')).toBe(true);
      expect(matchesAny('firebase-admin/firestore')).toBe(true);
      expect(matchesAny('firebase')).toBe(true);
      expect(matchesAny('firebase/app')).toBe(true);
      expect(matchesAny('@firebase/app')).toBe(true);
    });

    test('rejects unrelated packages and partial overlaps', () => {
      const matchesAny = (id: string): boolean =>
        pyricRollupExternals.some((regex) => regex.test(id));

      expect(matchesAny('express')).toBe(false);
      expect(matchesAny('firebase-tools')).toBe(false);
      expect(matchesAny('@google-cloud/storage')).toBe(false);
    });
  });

  describe('pyricEsbuildExternals', () => {
    test('contains expected root and wildcard patterns for esbuild/tsup', () => {
      expect(pyricEsbuildExternals).toContain('firebase-admin');
      expect(pyricEsbuildExternals).toContain('firebase-admin/*');
      expect(pyricEsbuildExternals).toContain('firebase');
      expect(pyricEsbuildExternals).toContain('firebase/*');
      expect(pyricEsbuildExternals).toContain('@firebase/*');
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
