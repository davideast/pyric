/**
 * ADR 0022, swap or stop: which resolved loads the register stops. The
 * package is read from a stand-in manifest lookup, so these cases cover the
 * rule itself; `real-sdk-stop.test.ts` runs it in registered child processes.
 */
import { describe, expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REAL_SDK_STOPPED_CODE,
  createStopReporter,
  isImportCondition,
  isUnservedFirebaseImport,
  isUnservedFirebaseSubpath,
  stopFor,
  suppliedRowsStopFor,
  unservedFirebaseSubpathStop,
  type ResolvedLoad,
} from '../../src/register/swap-or-stop.js';

const cliRoot = resolve(import.meta.dir, '../..');
const SHADOW_IMPORTER = pathToFileURL(join(cliRoot, 'src/register/app-bridge-shadow.ts')).href;
const APP_CHECK_BRIDGE_IMPORTER = pathToFileURL(join(cliRoot, 'src/register/app-bridge-app-check.ts')).href;
const ADMIN_BRIDGE_IMPORTER = pathToFileURL(join(cliRoot, 'src/register/app-bridge-admin-app-check.ts')).href;
const APP_IMPORTER = 'file:///work/app/src/route.js';

/** Packages by path segment, as the manifests on disk would name them. */
const PACKAGES: ReadonlyArray<readonly [segment: string, name: string]> = [
  ['/node_modules/firebase-admin/', 'firebase-admin'],
  ['/node_modules/admin/', 'firebase-admin'],
  ['/vendor/firebase-admin/', 'firebase-admin'],
  ['/linked-admin/', 'firebase-admin'],
  ['/node_modules/firebase/', 'firebase'],
  ['/vendor/firebase/', 'firebase'],
  ['/node_modules/fb/', 'firebase'],
  ['/node_modules/@firebase/firestore/', '@firebase/firestore'],
  ['/node_modules/@firebase/ai/', '@firebase/ai'],
  ['/node_modules/@firebase/util/', '@firebase/util'],
  ['/node_modules/@firebase/app/', '@firebase/app'],
  ['/node_modules/@firebase/app-check/', '@firebase/app-check'],
  ['/node_modules/@firebase/auth/', '@firebase/auth'],
  ['/node_modules/@firebase/crashlytics/', '@firebase/crashlytics'],
  ['/node_modules/firebase-functions/', 'firebase-functions'],
  ['/node_modules/next/', 'next'],
  ['/work/app/', 'app'],
];

function nameOf(url: string): string | null {
  return PACKAGES.find(([segment]) => url.includes(segment))?.[1] ?? null;
}

/** The file's path inside its package, as the package root on disk would give it. */
function pathInPackage(url: string): string | null {
  const segment = PACKAGES.find(([candidate]) => url.includes(candidate))?.[0];
  return segment === undefined ? null : url.slice(url.indexOf(segment) + segment.length);
}

function load(overrides: Partial<ResolvedLoad> & Pick<ResolvedLoad, 'url'>): ResolvedLoad {
  return { specifier: 'x', importer: APP_IMPORTER, aiMode: 'sandbox', nameOf, pathInPackage, ...overrides };
}

/** A fresh hook's record of the loads it allowed. */
function noneAllowed(): Set<string> {
  return new Set();
}

const ADMIN_FILE = 'file:///work/app/node_modules/firebase-admin/lib/app/index.js';
const VENDOR_ADMIN_FILE = 'file:///work/app/vendor/firebase-admin/lib/app/index.js';
const LINKED_ADMIN_FILE = 'file:///work/app/linked-admin/lib/app/index.js';
const ADMIN_UTILS_FILE = 'file:///work/app/node_modules/firebase-admin/lib/utils/index.js';
const FIREBASE_AI_FILE = 'file:///work/app/node_modules/firebase/ai/dist/index.mjs';
const FIREBASE_APP_FILE = 'file:///work/app/node_modules/firebase/app/dist/index.mjs';
const FIREBASE_APP_CHECK_FILE = 'file:///work/app/node_modules/firebase/app-check/dist/index.mjs';
const FIREBASE_FIRESTORE_FILE = 'file:///work/app/node_modules/firebase/firestore/dist/index.mjs';
const FIREBASE_INSTALLATIONS_FILE = 'file:///work/app/node_modules/firebase/installations/dist/index.mjs';
const AT_FIRESTORE_FILE = 'file:///work/app/node_modules/@firebase/firestore/dist/index.node.mjs';
const AT_AI_FILE = 'file:///work/app/node_modules/@firebase/ai/dist/index.node.mjs';
const AT_APP_FILE = 'file:///work/app/node_modules/@firebase/app/dist/esm/index.esm.js';
const AT_APP_CHECK_FILE = 'file:///work/app/node_modules/@firebase/app-check/dist/esm/index.esm.js';
const AT_UTIL_FILE = 'file:///work/app/node_modules/@firebase/util/dist/node-esm/index.node.esm.js';

describe('stopFor: firebase-admin', () => {
  it('stops the real firebase-admin from app code, naming the import, the importer, the file and the fix', () => {
    const stop = stopFor(load({ specifier: '/work/app/node_modules/firebase-admin/lib/app/index.js', url: ADMIN_FILE }), noneAllowed());
    expect(stop).not.toBeNull();
    expect((stop as Error & { code: string }).code).toBe(REAL_SDK_STOPPED_CODE);
    expect(stop?.message).toContain('stopped loading the real firebase-admin');
    expect(stop?.message).toContain(`from   ${APP_IMPORTER}`);
    expect(stop?.message).toContain(`found  ${ADMIN_FILE}`);
    expect(stop?.message).toContain("'firebase-admin/app'");
    expect(stop?.message).toContain('without @pyric/cli/register');
  });

  it('stops an npm alias, because the manifest names firebase-admin', () => {
    const stop = stopFor(load({ specifier: 'admin/app', url: 'file:///work/app/node_modules/admin/lib/app/index.js' }), noneAllowed());
    expect(stop?.message).toContain('stopped loading the real firebase-admin');
  });

  it('stops a vendored copy or preserved symlink outside node_modules (#1620)', () => {
    const vendored = stopFor(load({ specifier: 'admin/app', url: VENDOR_ADMIN_FILE }), noneAllowed());
    const linked = stopFor(load({ specifier: './linked-admin/lib/app/index.js', url: LINKED_ADMIN_FILE }), noneAllowed());
    expect(vendored?.message).toContain('stopped loading the real firebase-admin');
    expect(vendored?.message).toContain(`found  ${VENDOR_ADMIN_FILE}`);
    expect(linked?.message).toContain('stopped loading the real firebase-admin');
    expect(linked?.message).toContain(`found  ${LINKED_ADMIN_FILE}`);

    const liveVendored = suppliedRowsStopFor(
      load({ specifier: 'admin/app', url: VENDOR_ADMIN_FILE }),
      noneAllowed(),
      { isRowImport: false, isEsmImport: true },
    );
    expect((liveVendored as (Error & { code?: string }) | null)?.code).toBe(REAL_SDK_STOPPED_CODE);
  });

  it('stops firebase-admin in production AI mode too', () => {
    expect(stopFor(load({ url: ADMIN_FILE, aiMode: 'production' }), noneAllowed())).not.toBeNull();
  });

  it("lets production AI mode's App Check verifier bridge load firebase-admin via ESM, and stops CJS createRequire forges (#1552)", () => {
    const bridge = load({
      specifier: 'firebase-admin/app',
      url: ADMIN_FILE,
      importer: ADMIN_BRIDGE_IMPORTER,
      aiMode: 'production',
      isEsmImport: true,
    });
    expect(stopFor(bridge, noneAllowed())).toBeNull();
    expect(stopFor({ ...bridge, isEsmImport: false }, noneAllowed())).not.toBeNull();
    expect(stopFor({ ...bridge, importer: APP_IMPORTER }, noneAllowed())).not.toBeNull();
    expect(stopFor({ ...bridge, specifier: 'firebase-admin/auth' }, noneAllowed())).not.toBeNull();
  });

  it('stops the verifier bridge pair in sandbox AI mode', () => {
    const bridge = load({ specifier: 'firebase-admin/app', url: ADMIN_FILE, importer: ADMIN_BRIDGE_IMPORTER, aiMode: 'sandbox' });
    expect(stopFor(bridge, noneAllowed())).not.toBeNull();
  });

  it('stops the admin pair from any other shadow module, which only wraps the client SDK', () => {
    const forged = load({ specifier: 'firebase-admin/app', url: ADMIN_FILE, importer: SHADOW_IMPORTER, aiMode: 'production' });
    expect(stopFor(forged, noneAllowed())).not.toBeNull();
  });

  it('lets a firebase-admin file the hook allowed import another, and records each allowed file', () => {
    const allowed = noneAllowed();
    const bridge = load({ specifier: 'firebase-admin/app', url: ADMIN_FILE, importer: ADMIN_BRIDGE_IMPORTER, aiMode: 'production' });
    expect(stopFor(bridge, allowed)).toBeNull();
    expect(stopFor(load({ url: ADMIN_UTILS_FILE, importer: ADMIN_FILE, aiMode: 'production' }), allowed)).toBeNull();
    expect([...allowed]).toEqual([ADMIN_FILE, ADMIN_UTILS_FILE]);
  });

  it("stops a forge from an allowed firebase-admin file beyond the verifier bridge pair's own files", () => {
    const allowed = new Set([ADMIN_FILE]);
    const fromApp = (url: string) => load({ url, importer: ADMIN_FILE, aiMode: 'production' });
    expect(stopFor(fromApp('file:///work/app/node_modules/firebase-admin/lib/firestore/index.js'), allowed)).not.toBeNull();
    expect(stopFor(fromApp('file:///work/app/node_modules/firebase-admin/lib/auth/index.js'), allowed)).not.toBeNull();
    expect(stopFor(fromApp('file:///work/app/node_modules/firebase-admin/lib/app-check/token-verifier.js'), allowed)).toBeNull();
    expect(stopFor(fromApp('file:///work/app/node_modules/firebase-admin/package.json'), allowed)).toBeNull();
  });

  it('lets Node 22 resolve an allowed CommonJS file again by its own path with no importer (#1707)', () => {
    const allowed = new Set([ADMIN_FILE]);
    const reload = load({ specifier: '/work/app/node_modules/firebase-admin/lib/app/index.js', url: ADMIN_FILE, importer: undefined, aiMode: 'production' });
    expect(stopFor(reload, allowed)).toBeNull();
  });

  it('stops a no-importer load of a firebase-admin file the hook never allowed, or by another specifier', () => {
    const reload = load({ specifier: '/work/app/node_modules/firebase-admin/lib/app/index.js', url: ADMIN_FILE, importer: undefined, aiMode: 'production' });
    expect(stopFor(reload, noneAllowed())).not.toBeNull();
    expect(stopFor({ ...reload, specifier: 'firebase-admin/app' }, new Set([ADMIN_FILE]))).not.toBeNull();
  });

  it('stops a createRequire forge of a firebase-admin importer the hook never allowed', () => {
    const forgedImporter = 'file:///work/app/node_modules/firebase-admin/x.js';
    expect(stopFor(load({ specifier: './lib/app/index.js', url: ADMIN_FILE, importer: forgedImporter }), noneAllowed())).not.toBeNull();
  });

  it('stops a client SDK importer reaching firebase-admin, even one the hook allowed', () => {
    const forgedImporter = 'file:///work/app/node_modules/firebase/x.js';
    expect(stopFor(load({ url: ADMIN_FILE, importer: forgedImporter }), noneAllowed())).not.toBeNull();
    const allowed = new Set([FIREBASE_APP_FILE]);
    expect(stopFor(load({ url: ADMIN_FILE, importer: FIREBASE_APP_FILE, aiMode: 'production' }), allowed)).not.toBeNull();
  });
});

describe('stopFor: the client SDK', () => {
  it('stops the real firebase in sandbox AI mode', () => {
    const stop = stopFor(load({ specifier: 'firebase-a14c8a5423a75469/ai', url: FIREBASE_AI_FILE }), noneAllowed());
    expect(stop?.message).toContain('stopped loading the real firebase');
    expect(stop?.message).toContain("with the app's API key");
  });

  it('stops an unserved firebase/* subpath and names a served import instead of telling the caller to import by package name (#1623)', () => {
    expect(isUnservedFirebaseSubpath('firebase/installations')).toBe(true);
    expect(isUnservedFirebaseSubpath('firebase/firestore')).toBe(false);
    expect(isUnservedFirebaseSubpath('firebase')).toBe(false);
    expect(isUnservedFirebaseImport('firebase')).toBe(true);
    expect(isUnservedFirebaseImport('firebase/installations')).toBe(true);
    expect(isUnservedFirebaseImport('firebase/firestore')).toBe(false);

    const stop = stopFor(
      load({ specifier: 'firebase/installations', url: FIREBASE_INSTALLATIONS_FILE }),
      noneAllowed(),
    );
    expect((stop as (Error & { code?: string }) | null)?.code).toBe(REAL_SDK_STOPPED_CODE);
    expect(stop?.message).toContain("pyric serves no firebase/* import for 'firebase/installations'");
    expect(stop?.message).toContain("'firebase/firestore'");
    expect(stop?.message).not.toContain('import firebase by its package name');

    const renamedStop = stopFor(
      load({
        specifier: 'firebase-a14c8a5423a75469/installations',
        canonical: 'firebase/installations',
        url: FIREBASE_INSTALLATIONS_FILE,
      }),
      noneAllowed(),
    );
    expect(renamedStop?.message).toContain("pyric serves no firebase/* import for 'firebase/installations'");

    const missingTargetStop = unservedFirebaseSubpathStop('firebase/data-connect', APP_IMPORTER);
    expect((missingTargetStop as Error & { code?: string }).code).toBe(REAL_SDK_STOPPED_CODE);
    expect(missingTargetStop.message).toContain("pyric serves no firebase/* import for 'firebase/data-connect'");

    const bareFirebaseStop = unservedFirebaseSubpathStop('firebase', APP_IMPORTER);
    expect((bareFirebaseStop as Error & { code?: string }).code).toBe(REAL_SDK_STOPPED_CODE);
    expect(bareFirebaseStop.message).toContain("import firebase by its package name (for example 'firebase/firestore')");
  });

  it('stops @firebase/* imported by app code, and names the firebase/* import to use', () => {
    const stop = stopFor(load({ specifier: '@firebase/firestore', url: AT_FIRESTORE_FILE }), noneAllowed());
    expect(stop?.message).toContain("import 'firebase/firestore' instead of '@firebase/firestore'");

    const crashlyticsReactStop = stopFor(
      load({
        specifier: '@firebase/crashlytics/react',
        url: 'file:///work/app/node_modules/@firebase/crashlytics/dist/react/index.esm.js',
      }),
      noneAllowed(),
    );
    expect(crashlyticsReactStop?.message).toContain(
      "import 'firebase/crashlytics/react' instead of '@firebase/crashlytics/react'",
    );
  });

  it('names no firebase/* import that pyric does not serve', () => {
    const stop = stopFor(load({ specifier: '@firebase/util', url: 'file:///work/app/node_modules/@firebase/util/dist/index.mjs' }), noneAllowed());
    expect(stop?.message).not.toContain("'firebase/util'");
    expect(stop?.message).toContain("pyric serves no firebase/* import for '@firebase/util'");
  });

  it('lets a firebase file the hook allowed import @firebase/*', () => {
    const allowed = new Set([FIREBASE_AI_FILE]);
    expect(stopFor(load({ url: AT_AI_FILE, importer: FIREBASE_AI_FILE }), allowed)).toBeNull();
  });

  it('stops a forge from an allowed firebase/ai file into @firebase/* packages the production AI entries never import', () => {
    const allowed = new Set([FIREBASE_AI_FILE]);
    const fromAi = (url: string) => load({ url, importer: FIREBASE_AI_FILE, aiMode: 'production' });
    expect(stopFor(fromAi(AT_FIRESTORE_FILE), allowed)).not.toBeNull();
    expect(stopFor(fromAi('file:///work/app/node_modules/@firebase/auth/dist/node-esm/index.js'), allowed)).not.toBeNull();
  });

  it('stops a createRequire forge of a firebase importer the hook never allowed', () => {
    const forgedImporter = 'file:///work/app/node_modules/firebase/firestore/dist/index.mjs';
    expect(stopFor(load({ url: AT_FIRESTORE_FILE, importer: forgedImporter }), noneAllowed())).not.toBeNull();
  });

  it('stops a shadow module reaching firebase/app in sandbox AI mode, and allows it via ESM in production AI mode', () => {
    expect(
      stopFor(load({ specifier: 'firebase/app', url: FIREBASE_APP_FILE, importer: SHADOW_IMPORTER, aiMode: 'sandbox' }), noneAllowed()),
    ).not.toBeNull();
    expect(
      stopFor(
        load({ specifier: 'firebase/app', url: FIREBASE_APP_FILE, importer: SHADOW_IMPORTER, aiMode: 'sandbox', isEsmImport: false }),
        noneAllowed(),
      ),
    ).not.toBeNull();
    expect(
      stopFor(
        load({ specifier: 'firebase/app', url: FIREBASE_APP_FILE, importer: SHADOW_IMPORTER, aiMode: 'production', isEsmImport: true }),
        noneAllowed(),
      ),
    ).toBeNull();
  });

  it("lets production AI mode load the firebase package's ai entry from any importer, while stopping app and app-check files outside wrappers and the allowed chain (#1735)", () => {
    const vite = 'file:///work/app/node_modules/vite/dist/node/module-runner.js';
    expect(stopFor(load({ url: FIREBASE_AI_FILE, aiMode: 'production', importer: vite }), noneAllowed())).toBeNull();
    for (const url of [FIREBASE_APP_FILE, FIREBASE_APP_CHECK_FILE]) {
      expect(stopFor(load({ specifier: url, url, aiMode: 'production' }), noneAllowed())).not.toBeNull();
      expect(stopFor(load({ specifier: url, url, aiMode: 'production', importer: vite }), noneAllowed())).not.toBeNull();
      expect(stopFor(load({ specifier: url, url, aiMode: 'production', importer: undefined }), noneAllowed())).not.toBeNull();
    }
    expect(
      stopFor(
        load({ specifier: 'firebase/app-check', url: FIREBASE_APP_CHECK_FILE, importer: APP_CHECK_BRIDGE_IMPORTER, aiMode: 'production', isEsmImport: true }),
        noneAllowed(),
      ),
    ).toBeNull();
    const allowedFromAi = new Set([FIREBASE_AI_FILE]);
    expect(stopFor(load({ url: FIREBASE_APP_FILE, importer: FIREBASE_AI_FILE, aiMode: 'production' }), allowedFromAi)).toBeNull();
    expect(stopFor(load({ url: FIREBASE_APP_CHECK_FILE, importer: FIREBASE_AI_FILE, aiMode: 'production' }), allowedFromAi)).toBeNull();
    expect(stopFor(load({ url: FIREBASE_FIRESTORE_FILE, importer: FIREBASE_AI_FILE, aiMode: 'production' }), allowedFromAi)).not.toBeNull();
    // Even after the wrapper or chain allowed those files, app code importing them by absolute path still stops.
    expect(stopFor(load({ specifier: FIREBASE_APP_FILE, url: FIREBASE_APP_FILE, aiMode: 'production' }), allowedFromAi)).not.toBeNull();
    expect(stopFor(load({ specifier: FIREBASE_APP_CHECK_FILE, url: FIREBASE_APP_CHECK_FILE, aiMode: 'production' }), allowedFromAi)).not.toBeNull();
  });

  it('stops app code importing the @firebase/* packages firebase/ai needs, in production AI mode too (#1635)', () => {
    const vite = 'file:///work/app/node_modules/vite/dist/node/module-runner.js';
    const direct = [AT_AI_FILE, AT_APP_FILE, AT_APP_CHECK_FILE, AT_UTIL_FILE];
    for (const url of direct) {
      expect(stopFor(load({ specifier: '@firebase/x', url, aiMode: 'production' }), noneAllowed())).not.toBeNull();
      expect(stopFor(load({ specifier: '@firebase/x', url, aiMode: 'production', importer: vite }), noneAllowed())).not.toBeNull();
      expect(stopFor(load({ specifier: '@firebase/x', url, aiMode: 'production', importer: undefined }), noneAllowed())).not.toBeNull();
    }
  });

  it('still stops app code importing @firebase/* after firebase/ai loaded the same files (#1635)', () => {
    const allowed = noneAllowed();
    expect(stopFor(load({ specifier: 'firebase/ai', url: FIREBASE_AI_FILE, aiMode: 'production' }), allowed)).toBeNull();
    expect(stopFor(load({ specifier: '@firebase/ai', url: AT_AI_FILE, importer: FIREBASE_AI_FILE, aiMode: 'production' }), allowed)).toBeNull();
    expect(stopFor(load({ specifier: '@firebase/app-check', url: AT_APP_CHECK_FILE, importer: AT_AI_FILE, aiMode: 'production' }), allowed)).toBeNull();
    for (const url of [AT_AI_FILE, AT_APP_CHECK_FILE]) {
      expect(stopFor(load({ specifier: '@firebase/x', url, aiMode: 'production' }), allowed)).not.toBeNull();
    }
  });

  it('stops the rest of the firebase package in production AI mode, by alias or by absolute path', () => {
    const aliased = load({ specifier: 'fb/firestore', url: 'file:///work/app/node_modules/fb/firestore/dist/index.mjs', aiMode: 'production' });
    const absolute = load({ specifier: '/work/app/node_modules/firebase/auth/dist/index.mjs', url: 'file:///work/app/node_modules/firebase/auth/dist/index.mjs', aiMode: 'production' });
    expect(stopFor(aliased, noneAllowed())).not.toBeNull();
    expect(stopFor(absolute, noneAllowed())).not.toBeNull();
    expect(stopFor(load({ url: FIREBASE_FIRESTORE_FILE, aiMode: 'production' }), noneAllowed())).not.toBeNull();
  });

  it('still stops other @firebase/* packages in production AI mode', () => {
    expect(stopFor(load({ url: AT_FIRESTORE_FILE, aiMode: 'production' }), noneAllowed())).not.toBeNull();
  });
});

describe('suppliedRowsStopFor: @firebase/ai under live rows', () => {
  const fromAllowedFile = { isRowImport: false, isEsmImport: true };

  it("lets an allowed firebase/ai file's ESM import load @firebase/ai, as a live row's would", () => {
    const allowed = new Set([FIREBASE_AI_FILE]);
    const atAi = load({ specifier: '@firebase/ai', url: AT_AI_FILE, importer: FIREBASE_AI_FILE });
    expect(suppliedRowsStopFor(atAi, allowed, fromAllowedFile)).toBeNull();
    expect(allowed.has(AT_AI_FILE)).toBe(true);
  });

  it('still stops an app file importing @firebase/ai, by ESM import or require()', () => {
    const fromApp = load({ specifier: '@firebase/ai', url: AT_AI_FILE });
    const stop = suppliedRowsStopFor(fromApp, new Set([FIREBASE_AI_FILE]), fromAllowedFile);
    expect((stop as Error & { code?: string } | null)?.code).toBe(REAL_SDK_STOPPED_CODE);
    expect(stop?.message).toContain('@pyric/live/register: stopped loading');
    const required = load({ specifier: '@firebase/ai', url: AT_AI_FILE, importer: FIREBASE_AI_FILE });
    expect(suppliedRowsStopFor(required, new Set([FIREBASE_AI_FILE]), { isRowImport: false, isEsmImport: false })).not.toBeNull();
  });

  it('lets an ?iitm=true ESM wrapper shim re-import its own allowed file and allowed @firebase/* dependencies, while stopping other firebase/* entries and CJS loads', () => {
    const allowed = noneAllowed();
    const shimmedEntry = `${FIREBASE_FIRESTORE_FILE}?iitm=true`;
    expect(
      suppliedRowsStopFor(
        load({ specifier: 'firebase/firestore', url: shimmedEntry, importer: 'file:///live/row/firestore.js' }),
        allowed,
        { isRowImport: true, isEsmImport: true },
      ),
    ).toBeNull();
    expect(allowed.has(FIREBASE_FIRESTORE_FILE)).toBe(true);

    const selfReimport = load({
      specifier: `${FIREBASE_FIRESTORE_FILE}?iitm=ignore`,
      url: FIREBASE_FIRESTORE_FILE,
      importer: shimmedEntry,
    });
    expect(suppliedRowsStopFor(selfReimport, allowed, fromAllowedFile)).toBeNull();

    const childImport = load({
      specifier: '@firebase/firestore',
      url: AT_FIRESTORE_FILE,
      importer: shimmedEntry,
    });
    expect(suppliedRowsStopFor(childImport, allowed, fromAllowedFile)).toBeNull();

    const differentFirebaseEntry = load({
      specifier: 'firebase/auth',
      url: 'file:///work/app/node_modules/firebase/auth/dist/index.mjs',
      importer: shimmedEntry,
    });
    expect(suppliedRowsStopFor(differentFirebaseEntry, allowed, fromAllowedFile)).not.toBeNull();

    const cjsSelfReimport = load({
      specifier: FIREBASE_FIRESTORE_FILE,
      url: FIREBASE_FIRESTORE_FILE,
      importer: shimmedEntry,
    });
    expect(suppliedRowsStopFor(cjsSelfReimport, allowed, { isRowImport: false, isEsmImport: false })).not.toBeNull();
  });
});

describe('suppliedRowsStopFor: live row entry gate (#2302)', () => {
  const rowGrant = { isRowImport: true, isEsmImport: true };

  it("lets each live row load only its own firebase/<subpath>/dist/ entry", () => {
    const validEntries: ReadonlyArray<readonly [specifier: string, path: string]> = [
      ['firebase/app', 'app/dist/index.mjs'],
      ['firebase/auth', 'auth/dist/esm/index.esm.js'],
      ['firebase/firestore', 'firestore/dist/index.mjs'],
      ['firebase/app-check', 'app-check/dist/index.mjs'],
      ['firebase/database', 'database/dist/index.mjs'],
      ['firebase/ai', 'ai/dist/index.mjs'],
      ['firebase/storage', 'storage/dist/index.mjs'],
      ['firebase/messaging', 'messaging/dist/index.mjs'],
      ['firebase/messaging/sw', 'messaging/sw/dist/index.mjs'],
    ];
    for (const [specifier, entryPath] of validEntries) {
      const allowed = noneAllowed();
      const url = `file:///work/app/node_modules/firebase/${entryPath}`;
      const rowLoad = load({ specifier, url, importer: `pyric-live-row:${specifier}` });
      expect(suppliedRowsStopFor(rowLoad, allowed, rowGrant)).toBeNull();
      expect(allowed.has(url)).toBe(true);
    }
  });

  it('stops a live row redirected to another firebase entry, naming the row specifier, the resolved file and the fix', () => {
    const redirectedEntries: ReadonlyArray<readonly [specifier: string, path: string]> = [
      ['firebase/firestore', 'firestore/lite/dist/index.mjs'],
      ['firebase/firestore', 'firestore/lite/dist/esm/index.esm.js'],
      ['firebase/firestore', 'firestore/pipelines/dist/index.mjs'],
      ['firebase/firestore', 'firebase-firestore.js'],
      ['firebase/firestore', 'firestore/dist/../../firestore/lite/dist/index.mjs'],
      ['firebase/messaging', 'messaging/sw/dist/index.mjs'],
      ['firebase/messaging/sw', 'messaging/dist/index.mjs'],
      ['firebase/auth', 'auth/cordova/dist/index.mjs'],
      ['firebase', 'firestore/dist/index.mjs'],
      ['firebase/', 'firestore/dist/index.mjs'],
      ['custom-firestore-alias', 'firestore/dist/index.mjs'],
    ];
    for (const [specifier, entryPath] of redirectedEntries) {
      const allowed = noneAllowed();
      const url = `file:///work/app/node_modules/firebase/${entryPath}`;
      const rowLoad = load({ specifier, url, importer: `pyric-live-row:${specifier}` });
      const stop = suppliedRowsStopFor(rowLoad, allowed, rowGrant) as (Error & { code?: string }) | null;
      expect(stop).not.toBeNull();
      expect(stop?.code).toBe(REAL_SDK_STOPPED_CODE);
      expect(allowed.size).toBe(0);
    }

    const liteUrl = 'file:///work/app/node_modules/firebase/firestore/lite/dist/index.mjs';
    const liteStop = suppliedRowsStopFor(
      load({ specifier: 'firebase/firestore', url: liteUrl, importer: 'pyric-live-row:firebase/firestore' }),
      noneAllowed(),
      rowGrant,
    );
    expect(liteStop?.message).toContain(`found  ${liteUrl}`);
    expect(liteStop?.message).toContain("@pyric/live's firebase/firestore row loads only firebase/firestore's own entry in firebase.");
    expect(liteStop?.message).toContain("remove any alias or redirect on 'firebase/firestore'");
  });

  it('stops an aliased live row in a node --import @pyric/live/register subprocess before any SDK file loads', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const { tmpdir } = await import('node:os');
    const { dirname } = await import('node:path');

    const repoRoot = resolve(cliRoot, '../..');
    const liveDir = join(repoRoot, 'packages/live');
    const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
    const realFirebaseDir = realpathSync(dirname(requireFromRepo.resolve('firebase/package.json')));
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-row-alias-')));
    try {
      mkdirSync(join(workDir, 'node_modules/@pyric'), { recursive: true });
      symlinkSync(cliRoot, join(workDir, 'node_modules/@pyric/cli'));
      symlinkSync(liveDir, join(workDir, 'node_modules/@pyric/live'));
      symlinkSync(realFirebaseDir, join(workDir, 'node_modules/firebase'));
      writeFileSync(join(workDir, 'package.json'), JSON.stringify({ name: 'row-alias-app', type: 'module' }));
      writeFileSync(join(workDir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-row-alias' } }));
      const preload = join(workDir, 'preload.mjs');
      writeFileSync(preload, [
        "import Module from 'node:module';",
        'const loaded = [];',
        "globalThis[Symbol.for('row.alias.loaded')] = loaded;",
        'Module.registerHooks({',
        "  resolve(specifier, context, nextResolve) {",
        "    if (specifier === 'firebase/firestore') return nextResolve('firebase/firestore/lite', context);",
        '    return nextResolve(specifier, context);',
        '  },',
        '  load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context); },',
        '});',
      ].join('\n'));
      const entry = join(workDir, 'entry.mjs');
      writeFileSync(entry, [
        'let code = "loaded", message = "";',
        "try { await import('firebase/firestore'); } catch (err) { code = err?.code ?? 'threw'; message = String(err?.message ?? err); }",
        "const sdkFiles = globalThis[Symbol.for('row.alias.loaded')].filter((u) => /\\/node_modules\\/(firebase|@firebase\\/[^/]+)\\//.test(u));",
        "console.log('OUTCOME ' + JSON.stringify({ code, message, sdkFiles }));",
      ].join('\n'));
      const result = spawnSync('node', ['--import', pathToFileURL(preload).href, '--import', '@pyric/live/register', entry], {
        cwd: workDir, encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH, HOME: workDir },
      });
      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout.split('\n').find((text) => text.startsWith('OUTCOME ')) ?? 'OUTCOME {}';
      const outcome = JSON.parse(line.slice('OUTCOME '.length)) as { code?: string; message?: string; sdkFiles?: string[] };
      const firestoreFiles = (outcome.sdkFiles ?? []).filter((url) => url.includes('firestore'));
      expect(outcome.code).toBe(REAL_SDK_STOPPED_CODE);
      expect(firestoreFiles).toEqual([]);
      expect(outcome.message).toContain("@pyric/live's firebase/firestore row loads only firebase/firestore's own entry in firebase.");
      expect(outcome.message).toContain('firestore/lite/dist/');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('stopFor: everything else', () => {
  it('checks manifest identity for file URLs outside node_modules and leaves non-Firebase app files alone (#1620)', () => {
    const read: string[] = [];
    const result = stopFor(
      load({
        url: 'file:///work/app/src/lib.js',
        nameOf: (url) => {
          read.push(url);
          return 'app';
        },
      }),
      noneAllowed(),
    );
    expect({ result, read }).toEqual({ result: null, read: ['file:///work/app/src/lib.js'] });
  });

  it('leaves packages that only contain "firebase" in their name alone', () => {
    expect(stopFor(load({ url: 'file:///work/app/node_modules/firebase-functions/lib/v2/index.js' }), noneAllowed())).toBeNull();
  });

  it('leaves built-ins and other non-file URLs alone without reading a manifest', () => {
    const read: string[] = [];
    const result = stopFor(
      load({
        url: 'node:fs',
        nameOf: (url) => {
          read.push(url);
          return 'firebase-admin';
        },
      }),
      noneAllowed(),
    );
    expect({ result, read }).toEqual({ result: null, read: [] });
  });
});

describe('createStopReporter', () => {
  it('writes each stopped file once', () => {
    const lines: string[] = [];
    const report = createStopReporter((line) => lines.push(line));
    const stop = stopFor(load({ url: ADMIN_FILE }), noneAllowed());
    expect(stop).not.toBeNull();
    if (stop !== null) {
      report(stop);
      report(stop);
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('code: PYRIC_REAL_SDK_STOPPED');
  });
});

describe('isImportCondition', () => {
  it('handles Array, Set, custom iterables, non-iterable objects, primitives, and undefined', () => {
    expect(isImportCondition(['node', 'import'])).toBe(true);
    expect(isImportCondition(['node', 'require'])).toBe(false);
    expect(isImportCondition(new Set(['node', 'import']))).toBe(true);
    expect(isImportCondition(new Set(['node', 'require']))).toBe(false);
    const customIterable = {
      *[Symbol.iterator]() {
        yield 'node';
        yield 'import';
      },
    };
    expect(isImportCondition(customIterable)).toBe(true);
    expect(isImportCondition({})).toBe(false);
    expect(isImportCondition(null)).toBe(false);
    expect(isImportCondition(undefined)).toBe(false);
    expect(isImportCondition('import')).toBe(false);
  });
});
