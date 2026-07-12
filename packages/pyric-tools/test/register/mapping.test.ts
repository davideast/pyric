/**
 * Unit coverage for the register seam's pure pieces: the specifier map
 * (firebase → pyric, all subpaths 1:1, non-Firebase untouched), the
 * mirror-package exemption (Firebase imports FROM WITHIN the pyric mirrors
 * stay Firebase — their prod arms), and the ESM-only exports walker behind
 * the CJS require() fallback.
 */
import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mapFirebaseSpecifier } from '../../src/register/mapping.js';
import { owningPackageName, rewriteSpecifier } from '../../src/register/exempt.js';
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

describe('rewriteSpecifier (mirror-package exemption)', () => {
  const repoRoot = resolve(import.meta.dir, '../../../..');
  const pyricAdminParent = pathToFileURL(
    join(repoRoot, 'packages/pyric-admin/src/database/index.ts'),
  ).href;
  const pyricParent = pathToFileURL(join(repoRoot, 'packages/pyric/src/app/index.ts')).href;
  const cliParent = pathToFileURL(
    join(repoRoot, 'packages/pyric-tools/src/deploy/index.ts'),
  ).href;

  it('does NOT rewrite Firebase imports made from within the pyric mirrors', () => {
    // The repro: pyric-admin/database's own prod-arm import — a rewrite
    // turns it into a self-import missing getDatabaseWithUrl.
    expect(rewriteSpecifier('firebase-admin/database', pyricAdminParent)).toBeNull();
    expect(rewriteSpecifier('firebase-admin/app', pyricAdminParent)).toBeNull();
    expect(rewriteSpecifier('firebase/app', pyricParent)).toBeNull();
    expect(rewriteSpecifier('firebase-admin/firestore', cliParent)).toBeNull();
  });

  it('rewrites from user modules, entry points, and non-file parents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-exempt-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'user-app' }));
      const userParent = pathToFileURL(join(dir, 'server.mjs')).href;
      expect(rewriteSpecifier('firebase-admin/database', userParent)).toBe('pyric-admin/database');
      expect(rewriteSpecifier('firebase/app', userParent)).toBe('pyric/app');
      expect(rewriteSpecifier('firebase-admin/app', undefined)).toBe('pyric-admin/app');
      expect(rewriteSpecifier('firebase-admin/app', 'data:text/javascript,')).toBe(
        'pyric-admin/app',
      );
      // Non-Firebase specifiers stay null regardless of parent.
      expect(rewriteSpecifier('express', userParent)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('identifies the owner by package NAME, skipping nameless format-marker package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-owner-'));
    try {
      // A copy under an arbitrary 'pyric'-flavored path: identity must come
      // from the package.json name, never from a path substring.
      const pkgDir = join(dir, 'some-pyric-worktree/node_modules/pyric-admin');
      mkdirSync(join(pkgDir, 'dist'), { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pyric-admin' }));
      // Nameless format marker inside dist — skipped, not the owner.
      writeFileSync(join(pkgDir, 'dist', 'package.json'), JSON.stringify({ type: 'module' }));
      const parent = pathToFileURL(join(pkgDir, 'dist', 'database.js')).href;
      expect(owningPackageName(parent)).toBe('pyric-admin');
      expect(rewriteSpecifier('firebase-admin/database', parent)).toBeNull();

      // A user package on a path CONTAINING 'pyric' still gets rewritten.
      const userDir = join(dir, 'my-pyric-app');
      mkdirSync(userDir, { recursive: true });
      writeFileSync(join(userDir, 'package.json'), JSON.stringify({ name: 'my-pyric-app' }));
      const userParent = pathToFileURL(join(userDir, 'index.mjs')).href;
      expect(rewriteSpecifier('firebase-admin/database', userParent)).toBe('pyric-admin/database');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
