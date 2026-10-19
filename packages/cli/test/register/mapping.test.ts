/**
 * Unit coverage for the register seam's pure pieces: the specifier map
 * (firebase → pyric, with a register-only app adapter, non-Firebase untouched)
 * and the ESM-only exports walker behind the CJS require() fallback.
 */
import { describe, it, expect } from 'bun:test';
import { mapFirebaseSpecifier } from '../../src/register/mapping.js';
import { resolveEsmOnlySubpath } from '../../src/register/esm-exports.js';

describe('mapFirebaseSpecifier', () => {
  it('maps the bare package roots', () => {
    expect(mapFirebaseSpecifier('firebase-admin')).toBe('pyric-admin');
    expect(mapFirebaseSpecifier('firebase')).toBe('pyric');
  });

  it('maps service subpaths and routes app through the register adapter', () => {
    expect(mapFirebaseSpecifier('firebase-admin/app')).toBe('pyric-admin/app');
    expect(mapFirebaseSpecifier('firebase-admin/firestore')).toBe('pyric-admin/firestore');
    expect(mapFirebaseSpecifier('firebase-admin/auth')).toBe('pyric-admin/auth');
    expect(mapFirebaseSpecifier('firebase-admin/database')).toBe('pyric-admin/database');
    expect(mapFirebaseSpecifier('firebase-admin/storage')).toBe('pyric-admin/storage');
    expect(mapFirebaseSpecifier('firebase/app')).toBe('pyric/app/register');
    expect(mapFirebaseSpecifier('firebase/firestore')).toBe('pyric/firestore');
    expect(mapFirebaseSpecifier('firebase/auth')).toBe('pyric/auth');
  });

  it('maps nested subpaths verbatim', () => {
    expect(mapFirebaseSpecifier('firebase/messaging/sw')).toBe('pyric/messaging/sw');
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

  it('skips mapping firebase/ai and maps firebase/app to app-bridge when in production AI mode', () => {
    expect(mapFirebaseSpecifier('firebase/ai', undefined, { aiMode: 'production' })).toBeNull();
    expect(mapFirebaseSpecifier('firebase/app', undefined, { aiMode: 'production' })).toBe('@pyric/cli/register/app-bridge');
    expect(mapFirebaseSpecifier('firebase/firestore', undefined, { aiMode: 'production' })).toBe('pyric/firestore');
  });

  it('leaves firebase/app unmapped when importer is the shadow app bridge', () => {
    expect(mapFirebaseSpecifier('firebase/app', '/cli/dist/register/app-bridge.js', { aiMode: 'production' })).toBeNull();
    expect(mapFirebaseSpecifier('firebase/app', '/cli/src/serve/entries/app-ai-passthrough.ts', { aiMode: 'production' })).toBeNull();
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

describe('mapFirebaseSpecifier under a remote activation (#1082)', () => {
  const remoteSettings = ['remote', 'remote:http://127.0.0.1:5173', '1', 'true'];

  it('sends the client SDKs the Node host serves to its Node client', () => {
    for (const sandbox of remoteSettings) {
      expect(mapFirebaseSpecifier('firebase/app', undefined, { sandbox }), sandbox).toBe('@pyric/cli/register/client/app');
      for (const service of ['database', 'firestore', 'auth', 'storage']) {
        expect(mapFirebaseSpecifier(`firebase/${service}`, undefined, { sandbox }), `${sandbox} ${service}`)
          .toBe(`@pyric/cli/register/client/${service}`);
      }
    }
  });

  it('keeps the mirrors for client SDKs with no path to the host, and for firebase-admin', () => {
    const sandbox = 'remote';
    expect(mapFirebaseSpecifier('firebase/ai', undefined, { sandbox })).toBe('pyric/ai');
    expect(mapFirebaseSpecifier('firebase/messaging', undefined, { sandbox })).toBe('pyric/messaging');
    expect(mapFirebaseSpecifier('firebase/functions', undefined, { sandbox })).toBe('pyric/functions');
    expect(mapFirebaseSpecifier('firebase/firestore/lite', undefined, { sandbox })).toBe('pyric/firestore/lite');
    expect(mapFirebaseSpecifier('firebase-admin/database', undefined, { sandbox })).toBe('pyric-admin/database');
  });

  it('routes app through the Node client bridge when production AI pass-through is on', () => {
    expect(mapFirebaseSpecifier('firebase/app', undefined, { sandbox: 'remote', aiMode: 'production' }))
      .toBe('@pyric/cli/register/client/app-bridge');
  });

  it('keeps the in-process adapter under local, an empty remote url, or no activation', () => {
    for (const sandbox of ['local', 'remote:', '']) {
      expect(mapFirebaseSpecifier('firebase/app', undefined, { sandbox }), sandbox).toBe('pyric/app/register');
      expect(mapFirebaseSpecifier('firebase/database', undefined, { sandbox }), sandbox).toBe('pyric/database');
    }
  });
});
