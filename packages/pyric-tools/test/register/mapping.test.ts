/**
 * Unit coverage for the register seam's pure pieces: the specifier map
 * (firebase → pyric, all subpaths 1:1, non-Firebase untouched) and the
 * ESM-only exports walker behind the CJS require() fallback.
 */
import { describe, it, expect } from 'bun:test';
import { mapFirebaseSpecifier } from '../../src/register/mapping.js';
import { resolveEsmOnlySubpath } from '../../src/register/esm-exports.js';

describe('mapFirebaseSpecifier', () => {
  it('maps the bare package roots', () => {
    expect(mapFirebaseSpecifier('firebase-admin')).toBe('pyric-admin');
    expect(mapFirebaseSpecifier('firebase')).toBe('pyric');
  });

  it('maps every subpath 1:1', () => {
    expect(mapFirebaseSpecifier('firebase-admin/app')).toBe('pyric-admin/app');
    expect(mapFirebaseSpecifier('firebase-admin/firestore')).toBe('pyric-admin/firestore');
    expect(mapFirebaseSpecifier('firebase-admin/auth')).toBe('pyric-admin/auth');
    expect(mapFirebaseSpecifier('firebase-admin/database')).toBe('pyric-admin/database');
    expect(mapFirebaseSpecifier('firebase-admin/storage')).toBe('pyric-admin/storage');
    expect(mapFirebaseSpecifier('firebase/app')).toBe('pyric/app');
    expect(mapFirebaseSpecifier('firebase/firestore')).toBe('pyric/firestore');
    expect(mapFirebaseSpecifier('firebase/auth')).toBe('pyric/auth');
  });

  it('maps nested subpaths verbatim', () => {
    expect(mapFirebaseSpecifier('firebase/database/modular')).toBe('pyric/database/modular');
  });

  it('leaves non-Firebase specifiers untouched', () => {
    expect(mapFirebaseSpecifier('express')).toBeNull();
    expect(mapFirebaseSpecifier('node:fs')).toBeNull();
    expect(mapFirebaseSpecifier('./firebase')).toBeNull();
    expect(mapFirebaseSpecifier('/abs/firebase')).toBeNull();
  });

  it('does not match packages that merely contain "firebase"', () => {
    expect(mapFirebaseSpecifier('firebase-functions')).toBeNull();
    expect(mapFirebaseSpecifier('firebase-functions/v2')).toBeNull();
    expect(mapFirebaseSpecifier('firebase-tools')).toBeNull();
    expect(mapFirebaseSpecifier('@firebase/app')).toBeNull();
    expect(mapFirebaseSpecifier('my-firebase')).toBeNull();
  });

  it('does not double-map pyric specifiers', () => {
    expect(mapFirebaseSpecifier('pyric-admin/app')).toBeNull();
    expect(mapFirebaseSpecifier('pyric/firestore')).toBeNull();
  });
});

describe('resolveEsmOnlySubpath', () => {
  const exportsField = {
    './app': { types: './dist/app/index.d.ts', import: './dist/app/index.js' },
    './auth': {
      types: './dist/auth/index.d.ts',
      node: { types: './dist/auth/index.d.ts', import: './dist/auth/node.js' },
      default: './dist/auth/index.js',
    },
  };

  it('resolves an import-condition-only subpath', () => {
    expect(resolveEsmOnlySubpath(exportsField, './app')).toBe('./dist/app/index.js');
  });

  it('prefers node over default and skips types', () => {
    expect(resolveEsmOnlySubpath(exportsField, './auth')).toBe('./dist/auth/node.js');
  });

  it('returns null for unexported subpaths (incl. the root)', () => {
    expect(resolveEsmOnlySubpath(exportsField, './nope')).toBeNull();
    expect(resolveEsmOnlySubpath(exportsField, '.')).toBeNull();
  });

  it('handles string and bare-conditions exports for the root', () => {
    expect(resolveEsmOnlySubpath('./index.js', '.')).toBe('./index.js');
    expect(resolveEsmOnlySubpath({ import: './index.js' }, '.')).toBe('./index.js');
    expect(resolveEsmOnlySubpath({ import: './index.js' }, './x')).toBeNull();
  });

  it('handles missing exports fields', () => {
    expect(resolveEsmOnlySubpath(undefined, './app')).toBeNull();
    expect(resolveEsmOnlySubpath(null, '.')).toBeNull();
  });
});
