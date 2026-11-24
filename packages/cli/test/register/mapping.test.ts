/**
 * Unit coverage for the register seam's pure pieces: the specifier map
 * (firebase -> pyric, with a register-only app adapter, non-Firebase and
 * unserved firebase/* untouched) and the ESM-only exports walker behind the
 * CJS require() fallback.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { canonicalFirebaseSpecifier, mapFirebaseSpecifier } from '../../src/register/mapping.js';
import { resolveEsmOnlySubpath } from '../../src/register/esm-exports.js';

describe('mapFirebaseSpecifier', () => {
  it('maps firebase-admin root and leaves bare firebase and unserved firebase/* subpaths for swap-or-stop (#1623)', () => {
    expect(mapFirebaseSpecifier('firebase-admin')).toBe('pyric-admin');
    expect(mapFirebaseSpecifier('firebase')).toBeNull();
    const unserved = [
      'firebase/installations',
      'firebase/data-connect',
      'firebase/firestore/pipelines',
      'firebase/compat/app',
      'firebase/sandbox',
      'firebase/firestore/internal',
    ];
    for (const specifier of unserved) {
      expect(mapFirebaseSpecifier(specifier), specifier).toBeNull();
      expect(mapFirebaseSpecifier(specifier, undefined, { sandbox: 'remote' }), `remote ${specifier}`).toBeNull();
    }
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
    expect(mapFirebaseSpecifier('firebase/crashlytics')).toBe('pyric/crashlytics');
  });

  it('maps nested served subpaths verbatim', () => {
    expect(mapFirebaseSpecifier('firebase/messaging/sw')).toBe('pyric/messaging/sw');
    expect(mapFirebaseSpecifier('firebase/firestore/lite')).toBe('pyric/firestore/lite');
    expect(mapFirebaseSpecifier('firebase/crashlytics/react')).toBe('pyric/crashlytics/react');
    expect(mapFirebaseSpecifier('firebase/crashlytics/next-navigation')).toBe('pyric/crashlytics/next-navigation');
    expect(mapFirebaseSpecifier('firebase/crashlytics/react-router')).toBe('pyric/crashlytics/react-router');
    expect(mapFirebaseSpecifier('firebase/crashlytics/angular')).toBe('pyric/crashlytics/angular');
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

  const cliRoot = join(import.meta.dir, '..', '..');

  it('leaves firebase/app unmapped for ESM imports from the shadow app bridge in production AI mode, and swaps CJS or sandbox calls', () => {
    const appBridge = join(cliRoot, 'dist/register/app-bridge.js');
    const shadowBridge = join(cliRoot, 'dist/register/app-bridge-shadow.js');
    const clientBridge = `file://${join(cliRoot, 'dist/register/client/app-bridge.js')}`;
    const passthrough = join(cliRoot, 'src/serve/entries/app-ai-passthrough.ts');
    expect(mapFirebaseSpecifier('firebase/app', appBridge, { aiMode: 'production', isEsmImport: true })).toBeNull();
    expect(mapFirebaseSpecifier('firebase/app', shadowBridge, { aiMode: 'production', isEsmImport: true })).toBeNull();
    expect(mapFirebaseSpecifier('firebase/app', clientBridge, { aiMode: 'production', isEsmImport: true })).toBeNull();
    expect(mapFirebaseSpecifier('firebase/app', passthrough, { aiMode: 'production', isEsmImport: true })).toBeNull();

    // Sandbox AI mode never bypasses bridge importers, and CJS createRequire never bypasses in either mode.
    for (const importer of [appBridge, shadowBridge, clientBridge, passthrough]) {
      expect(mapFirebaseSpecifier('firebase/app', importer, { aiMode: 'sandbox', sandbox: '' })).toBe('pyric/app/register');
      expect(mapFirebaseSpecifier('firebase/app', importer, { aiMode: 'sandbox', sandbox: '', isEsmImport: false })).toBe('pyric/app/register');
      expect(mapFirebaseSpecifier('firebase/app', importer, { aiMode: 'production', sandbox: '', isEsmImport: false })).toBe('@pyric/cli/register/app-bridge');
    }
    // Cross-bridge and wildcard bridge filenames never bypass.
    expect(mapFirebaseSpecifier('firebase/app', join(cliRoot, 'dist/register/app-bridge-anything.js'), { aiMode: 'production', sandbox: '' })).toBe('@pyric/cli/register/app-bridge');
    expect(mapFirebaseSpecifier('firebase/app', join(cliRoot, 'dist/register/app-bridge-admin-app-check.js'), { aiMode: 'production', sandbox: '' })).toBe('@pyric/cli/register/app-bridge');
    expect(mapFirebaseSpecifier('firebase/app', join(cliRoot, 'dist/register/app-bridge-app-check.js'), { aiMode: 'production', sandbox: '' })).toBe('@pyric/cli/register/app-bridge');
    expect(mapFirebaseSpecifier('firebase/app-check', appBridge, { aiMode: 'production', sandbox: '' })).toBe('@pyric/cli/register/app-bridge-app-check');
  });

  it('maps firebase/app-check to the App Check bridge in production AI mode, and only ESM imports from the bridge reach the SDK', () => {
    const appCheckBridge = join(cliRoot, 'dist/register/app-bridge-app-check.js');
    expect(mapFirebaseSpecifier('firebase/app-check', undefined, { aiMode: 'production', sandbox: '' })).toBe('@pyric/cli/register/app-bridge-app-check');
    expect(mapFirebaseSpecifier('firebase/app-check', appCheckBridge, { aiMode: 'production', sandbox: '', isEsmImport: true })).toBeNull();
    expect(mapFirebaseSpecifier('firebase/app-check', appCheckBridge, { aiMode: 'production', sandbox: '', isEsmImport: false })).toBe('@pyric/cli/register/app-bridge-app-check');
    expect(mapFirebaseSpecifier('firebase/app-check', appCheckBridge, { aiMode: 'sandbox', sandbox: '' })).toBe('pyric/app-check');
  });

  it('lets the App Check verifier bridge reach the real firebase-admin via ESM in production AI mode, and maps CJS or app files (#1552)', () => {
    const bridges = [join(cliRoot, 'dist/register/app-bridge-admin-app-check.js'), `file://${join(cliRoot, 'src/register/app-bridge-admin-app-check.ts')}`];
    for (const bridge of bridges) {
      expect(mapFirebaseSpecifier('firebase-admin/app', bridge, { aiMode: 'production', sandbox: 'local', isEsmImport: true })).toBeNull();
      expect(mapFirebaseSpecifier('firebase-admin/app-check', bridge, { aiMode: 'production', sandbox: 'local', isEsmImport: true })).toBeNull();
      expect(mapFirebaseSpecifier('firebase-admin/app', bridge, { aiMode: 'production', sandbox: 'local', isEsmImport: false })).toBe('pyric-admin/app');
      expect(mapFirebaseSpecifier('firebase-admin/app-check', bridge, { aiMode: 'production', sandbox: 'local', isEsmImport: false })).toBe('pyric-admin/app-check');
      expect(mapFirebaseSpecifier('firebase-admin/firestore', bridge, { aiMode: 'production', sandbox: 'local' })).toBe('pyric-admin/firestore');
    }
    for (const appFile of ['/home/me/app/server.mjs', '/home/me/app/dist/register/app-bridge-admin-app-check.js']) {
      expect(mapFirebaseSpecifier('firebase-admin/app', appFile, { aiMode: 'production', sandbox: 'local' })).toBe('pyric-admin/app');
      expect(mapFirebaseSpecifier('firebase-admin/app-check', appFile, { aiMode: 'production', sandbox: 'local' })).toBe('pyric-admin/app-check');
    }
  });

  it('swaps firebase-admin for the verifier bridge in sandbox AI mode, where it never loads', () => {
    const bridge = join(cliRoot, 'dist/register/app-bridge-admin-app-check.js');
    expect(mapFirebaseSpecifier('firebase-admin/app', bridge, { aiMode: 'sandbox', sandbox: 'local' })).toBe('pyric-admin/app');
    expect(mapFirebaseSpecifier('firebase-admin/app-check', bridge, { aiMode: 'sandbox', sandbox: 'local' })).toBe('pyric-admin/app-check');
  });

  it('swaps firebase-admin for every other shadow module, including a forged createRequire importer', () => {
    for (const shadow of ['dist/register/app-bridge.js', 'dist/register/app-bridge-anything.js', 'src/register/app-bridge-shadow.ts']) {
      expect(mapFirebaseSpecifier('firebase-admin/app', join(cliRoot, shadow), { aiMode: 'production', sandbox: 'local' })).toBe('pyric-admin/app');
    }
  });

  it('swaps an app file that is merely named like a bridge', () => {
    for (const userFile of ['/home/me/app/src/register/app-bridge.js', '/home/me/app/dist/register/app-bridge.js', '/home/me/app/app-ai-passthrough.ts']) {
      expect(mapFirebaseSpecifier('firebase/app-check', userFile, { aiMode: 'sandbox', sandbox: '' })).toBe('pyric/app-check');
      expect(mapFirebaseSpecifier('firebase/app', userFile, { aiMode: 'production', sandbox: '' })).toBe('@pyric/cli/register/app-bridge');
    }
  });
});

/**
 * #1443: Next 16's Turbopack keeps server externals external but renames them,
 * so a route handler's `firebase-admin/app` reaches Node as
 * `firebase-admin-<16 hex>/app`. The canonical name is what the map sees.
 */
describe('canonicalFirebaseSpecifier', () => {
  const hash = 'a14c8a5423a75469';

  it("names Turbopack's renamed firebase-admin and firebase imports by their package", () => {
    expect(canonicalFirebaseSpecifier(`firebase-admin-${hash}/app`)).toBe('firebase-admin/app');
    expect(canonicalFirebaseSpecifier(`firebase-admin-${hash}/firestore`)).toBe('firebase-admin/firestore');
    expect(canonicalFirebaseSpecifier(`firebase-admin-${hash}`)).toBe('firebase-admin');
    expect(canonicalFirebaseSpecifier(`firebase-${hash}/firestore`)).toBe('firebase/firestore');
    expect(canonicalFirebaseSpecifier(`firebase-${hash}/firestore/lite`)).toBe('firebase/firestore/lite');
    expect(canonicalFirebaseSpecifier(`firebase-${hash}`)).toBe('firebase');
  });

  it('refuses a hash that is not exactly 16 lowercase hex characters', () => {
    expect(canonicalFirebaseSpecifier(`firebase-admin-${hash.slice(1)}/app`)).toBeNull();
    expect(canonicalFirebaseSpecifier(`firebase-admin-${hash}0/app`)).toBeNull();
    expect(canonicalFirebaseSpecifier(`firebase-admin-${hash.toUpperCase()}/app`)).toBeNull();
    expect(canonicalFirebaseSpecifier(`firebase-admin-${hash}/`)).toBeNull();
  });

  it('refuses other packages, scoped internals, and names that only contain "firebase"', () => {
    expect(canonicalFirebaseSpecifier(`firebase-functions-${hash}/v2`)).toBeNull();
    expect(canonicalFirebaseSpecifier(`firebase-tools-${hash}`)).toBeNull();
    expect(canonicalFirebaseSpecifier(`@firebase/app-${hash}`)).toBeNull();
    expect(canonicalFirebaseSpecifier(`my-firebase-${hash}`)).toBeNull();
    expect(canonicalFirebaseSpecifier(`./firebase-admin-${hash}/app`)).toBeNull();
  });

  it('leaves canonical and non-Firebase specifiers to the map', () => {
    expect(canonicalFirebaseSpecifier('firebase-admin/app')).toBeNull();
    expect(canonicalFirebaseSpecifier('firebase')).toBeNull();
    expect(canonicalFirebaseSpecifier('express')).toBeNull();
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
      for (const service of ['database', 'firestore', 'auth', 'storage', 'functions']) {
        expect(mapFirebaseSpecifier(`firebase/${service}`, undefined, { sandbox }), `${sandbox} ${service}`)
          .toBe(`@pyric/cli/register/client/${service}`);
      }
    }
  });

  it('keeps the mirrors for client SDKs with no path to the host, and for firebase-admin', () => {
    const sandbox = 'remote';
    expect(mapFirebaseSpecifier('firebase/ai', undefined, { sandbox })).toBe('pyric/ai');
    expect(mapFirebaseSpecifier('firebase/messaging', undefined, { sandbox })).toBe('pyric/messaging');
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
