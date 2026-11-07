/**
 * The Node register's half of live mode's pass-through (#2122) and where it
 * finds `@pyric/live` (#2116):
 *
 * - the installed `@pyric/live` resolves from the register entry's own
 *   package first, then from the project root;
 * - the pass-through list takes what `pyricLive({ passThrough })` takes, and
 *   throws on anything else;
 * - a listed import resolves to the app's installed SDK, and the stop lets its
 *   entry and the packages it needs load, while unlisted imports stay refused;
 * - `firebase-admin`, listed, resolves to the real Admin SDK, and the stop
 *   lets its entry and everything its tree imports load.
 *
 * Live mode's network report, which never refuses a call, is
 * `live-net-report.test.ts` (ADR 0022, amendment 2026-11-07).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveResolutionRoot, recordedPassThrough, LIVE_PASS_THROUGH_VARIABLE } from '../../src/register/live-package.js';
import { registerRows, registerRowsResolution, type RegisterRowPackage } from '../../src/register/supplied-rows.js';
import { suppliedRowsStopFor, type ResolvedLoad } from '../../src/register/swap-or-stop.js';
import { passThroughSdkPackages, passThroughSet, type PassThroughSpecifier } from '../../src/serve/vite-supplied-rows.js';
import type { ServedFirebaseSpecifier } from '../../src/serve/firebase-module-swap.js';

const scratch = mkdtempSync(join(tmpdir(), 'live-register-pass-through-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A folder holding a package named `@pyric/live` with a `register` export, as an install has it. */
function livePackageAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@pyric/live', type: 'module', exports: { './register': './register.js' } }));
  writeFileSync(join(dir, 'register.js'), '');
  return dir;
}

/** A project folder, with `@pyric/live` installed in its `node_modules` or not. */
function projectAt(name: string, installed: boolean): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true }));
  if (installed) livePackageAt(join(dir, 'node_modules', '@pyric', 'live'));
  return dir;
}

describe('where the register finds @pyric/live', () => {
  test('from the package the register entry was loaded from, before the project root', () => {
    const project = projectAt('both', true);
    const beside = livePackageAt(join(scratch, 'rules', 'node_modules', '@pyric', 'live'));
    expect(liveResolutionRoot(project, beside)).toBe(beside);
  });

  test('from the project root when the entry gives no folder, or the package does not resolve there', () => {
    const project = projectAt('project-only', true);
    expect(liveResolutionRoot(project, undefined)).toBe(project);
    const empty = join(scratch, 'not-a-package');
    mkdirSync(empty, { recursive: true });
    expect(liveResolutionRoot(project, empty)).toBe(project);
  });

  test('beside the app when the project root has none', () => {
    const project = projectAt('web', false);
    const beside = livePackageAt(join(scratch, 'sibling', 'node_modules', '@pyric', 'live'));
    expect(liveResolutionRoot(project, beside)).toBe(beside);
  });
});

describe('the pass-through list', () => {
  test('takes every served import with no live row', () => {
    expect([...passThroughSet(['firebase/remote-config', 'firebase/functions'])]).toEqual([
      'firebase/remote-config',
      'firebase/functions',
    ]);
  });

  test('takes firebase-admin, with no SDK package of its own for the page', () => {
    expect([...passThroughSet(['firebase-admin', 'firebase/functions'])]).toEqual(['firebase-admin', 'firebase/functions']);
    expect([...passThroughSdkPackages(passThroughSet(['firebase-admin']))]).toEqual([]);
  });

  test('throws on a row, its service under another entry, an Admin SDK subpath or an SDK package', () => {
    for (const entry of ['firebase/firestore', 'firebase/auth', 'firebase/firestore/lite', 'firebase-admin/app', '@firebase/database']) {
      expect(() => passThroughSet([entry])).toThrow(`${entry} cannot pass through`);
    }
  });

  test('reaches children as the first process recorded it', () => {
    expect(recordedPassThrough({})).toEqual([]);
    expect(recordedPassThrough({ [LIVE_PASS_THROUGH_VARIABLE]: '' })).toEqual([]);
    expect(recordedPassThrough({ [LIVE_PASS_THROUGH_VARIABLE]: 'firebase/remote-config,firebase/functions' })).toEqual(['firebase/remote-config', 'firebase/functions']);
  });
});

const ROWS: RegisterRowPackage = {
  projectUrl: 'file:///app/package.json',
  refusal: (specifier) => Object.assign(new Error(`refused ${specifier}`), { code: 'PYRIC_LIVE_REFUSED' }),
  moduleSource: () => null,
};

function resolutionOf(passThrough: readonly PassThroughSpecifier[], specifier: string, open = true) {
  const rows = registerRows(new Set(passThrough));
  if (open) rows.open(ROWS);
  return registerRowsResolution(rows, { specifier, importer: 'file:///app/server.mjs', conditions: ['node', 'import'] });
}

describe('a passed-through import under the register', () => {
  test('resolves to the installed SDK as the app wrote it, and an unlisted one is refused', () => {
    expect(resolutionOf(['firebase/functions'], 'firebase/functions')).toEqual({ kind: 'pass-through' });
    const remoteConfig = resolutionOf(['firebase/functions'], 'firebase/remote-config');
    expect(remoteConfig.kind).toBe('refused');
    expect(resolutionOf([], 'firebase/functions').kind).toBe('refused');
  });

  test('is refused while the rows are shut', () => {
    expect(resolutionOf(['firebase/functions'], 'firebase/functions', false).kind).toBe('refused');
  });
});

describe('firebase-admin under the register', () => {
  test('resolves to the real Admin SDK, by every entry, only when it is listed', () => {
    for (const specifier of ['firebase-admin', 'firebase-admin/app', 'firebase-admin/firestore']) {
      expect(resolutionOf(['firebase-admin'], specifier), specifier).toEqual({ kind: 'admin-pass-through' });
      expect(resolutionOf(['firebase/functions'], specifier).kind, specifier).toBe('refused');
      expect(resolutionOf(['firebase-admin'], specifier, false).kind, specifier).toBe('refused');
    }
  });

  test('passes no client import through', () => {
    expect(resolutionOf(['firebase-admin'], 'firebase/functions').kind).toBe('refused');
  });
});

const FIREBASE_DIR = 'file:///app/node_modules/firebase/';
const FUNCTIONS_DIR = 'file:///app/node_modules/@firebase/functions/';
const ADMIN_DIR = 'file:///app/node_modules/firebase-admin/';
const SERVER_FIRESTORE_DIR = 'file:///app/node_modules/@google-cloud/firestore/';
const SERVER_STORAGE_DIR = 'file:///app/node_modules/@google-cloud/storage/';

const PACKAGE_DIRS: ReadonlyArray<readonly [string, string]> = [
  [FIREBASE_DIR, 'firebase'],
  [FUNCTIONS_DIR, '@firebase/functions'],
  [ADMIN_DIR, 'firebase-admin'],
  [SERVER_FIRESTORE_DIR, '@google-cloud/firestore'],
  [SERVER_STORAGE_DIR, '@google-cloud/storage'],
];

/** A load with its package named from the URL, so no manifest is read. */
function loadOf(specifier: string, url: string, importer: string | undefined): ResolvedLoad {
  const nameOf = (file: string) => PACKAGE_DIRS.find(([dir]) => file.startsWith(dir))?.[1] ?? null;
  const pathInPackage = (file: string) => (file.startsWith(FIREBASE_DIR) ? file.slice(FIREBASE_DIR.length) : null);
  return { specifier, url, importer, nameOf, pathInPackage };
}

describe('the stop for a passed-through import', () => {
  const passThrough = new Set<ServedFirebaseSpecifier>(['firebase/functions']);
  const packages = passThroughSdkPackages(passThrough);
  const entry = `${FIREBASE_DIR}functions/dist/index.mjs`;

  test('lets its entry load, then the SDK package that entry imports', () => {
    const allowed = new Set<string>();
    const grant = { isRowImport: false, isEsmImport: true, isPassThroughImport: true, passThroughPackages: packages };
    expect(suppliedRowsStopFor(loadOf('firebase/functions', entry, 'file:///app/server.mjs'), allowed, grant)).toBeNull();
    expect(allowed.has(entry)).toBe(true);
    const sdk = `${FUNCTIONS_DIR}dist/esm/index.esm.js`;
    const fromEntry = { isRowImport: false, isEsmImport: true, passThroughPackages: packages };
    expect(suppliedRowsStopFor(loadOf('@firebase/functions', sdk, entry), allowed, fromEntry)).toBeNull();
    expect(allowed.has(sdk)).toBe(true);
  });

  test('stops a load of another entry by the listed name, a require(), and the package without the list', () => {
    const grant = { isRowImport: false, isEsmImport: true, isPassThroughImport: true, passThroughPackages: packages };
    const other = `${FIREBASE_DIR}remote-config/dist/index.mjs`;
    expect(suppliedRowsStopFor(loadOf('firebase/functions', other, 'file:///app/server.mjs'), new Set(), grant)).not.toBeNull();
    const required = { ...grant, isEsmImport: false };
    expect(suppliedRowsStopFor(loadOf('firebase/functions', entry, 'file:///app/server.cjs'), new Set(), required)).not.toBeNull();
    const sdk = `${FUNCTIONS_DIR}dist/esm/index.esm.js`;
    const withoutList = { isRowImport: false, isEsmImport: true };
    expect(suppliedRowsStopFor(loadOf('@firebase/functions', sdk, entry), new Set([entry]), withoutList)).not.toBeNull();
  });
});

describe('the stop for firebase-admin, listed', () => {
  const adminEntry = `${ADMIN_DIR}lib/app/index.js`;
  const serverFirestore = `${SERVER_FIRESTORE_DIR}build/src/index.js`;
  const adminImport = { isRowImport: false, isEsmImport: true, isAdminImport: true };
  const fromAdminTree = { isRowImport: false, isEsmImport: false, isFromAdminTree: true };
  const fromApp = { isRowImport: false, isEsmImport: true };

  test("lets the app's firebase-admin import load the real Admin SDK, by import or require()", () => {
    const outcomes = [
      suppliedRowsStopFor(loadOf('firebase-admin/app', adminEntry, 'file:///app/server.mjs'), new Set(), adminImport),
      suppliedRowsStopFor(loadOf('firebase-admin/app', adminEntry, 'file:///app/server.cjs'), new Set(), { ...adminImport, isEsmImport: false }),
    ];
    expect(outcomes).toEqual([null, null]);
  });

  test('lets the files of its tree load what it needs, the server Firestore SDK and the client SDK among them', () => {
    const loads = [
      loadOf('@google-cloud/firestore', serverFirestore, adminEntry),
      loadOf('@firebase/functions', `${FUNCTIONS_DIR}dist/index.cjs.js`, adminEntry),
      loadOf('./utils', `${ADMIN_DIR}lib/utils/index.js`, adminEntry),
    ];
    expect(loads.map((load) => suppliedRowsStopFor(load, new Set(), fromAdminTree))).toEqual([null, null, null]);
  });

  test("stops the app's own import of the server Storage SDK, and lets the Admin SDK's tree load it", () => {
    const serverStorage = `${SERVER_STORAGE_DIR}build/cjs/src/index.js`;
    const fromAppStop = suppliedRowsStopFor(loadOf('@google-cloud/storage', serverStorage, 'file:///app/server.mjs'), new Set(), fromApp);
    const fromTreeStop = suppliedRowsStopFor(loadOf('@google-cloud/storage', serverStorage, adminEntry), new Set(), fromAdminTree);
    expect({ fromApp: (fromAppStop as { code?: string } | null)?.code, fromTree: fromTreeStop }).toEqual({
      fromApp: 'PYRIC_REAL_SDK_STOPPED',
      fromTree: null,
    });
  });

  test("stops the app's own load of the Admin SDK by any other route, and of the server Firestore SDK", () => {
    const stops = [
      suppliedRowsStopFor(loadOf('/app/node_modules/firebase-admin/lib/app/index.js', adminEntry, 'file:///app/server.mjs'), new Set(), fromApp),
      suppliedRowsStopFor(loadOf('@google-cloud/firestore', serverFirestore, 'file:///app/server.mjs'), new Set(), fromApp),
      suppliedRowsStopFor(loadOf('firebase-admin/app', `${FIREBASE_DIR}app/dist/index.mjs`, 'file:///app/server.mjs'), new Set(), adminImport),
    ];
    expect(stops.map((stop) => (stop as { code?: string } | null)?.code)).toEqual([
      'PYRIC_REAL_SDK_STOPPED',
      'PYRIC_REAL_SDK_STOPPED',
      'PYRIC_REAL_SDK_STOPPED',
    ]);
  });
});
