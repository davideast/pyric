/**
 * ADR 0022, swap or stop: which resolved loads the register stops. The
 * package is read from a stand-in manifest lookup, so these cases cover the
 * rule itself; `real-sdk-stop.test.ts` runs it in registered child processes.
 */
import { describe, expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REAL_SDK_STOPPED_CODE, createStopReporter, stopFor, type ResolvedLoad } from '../../src/register/swap-or-stop.js';

const cliRoot = resolve(import.meta.dir, '../..');
const SHADOW_IMPORTER = pathToFileURL(join(cliRoot, 'src/register/app-bridge-shadow.ts')).href;
const APP_IMPORTER = 'file:///work/app/src/route.js';

/** Packages by path segment, as the manifests on disk would name them. */
const PACKAGES: ReadonlyArray<readonly [segment: string, name: string]> = [
  ['/node_modules/firebase-admin/', 'firebase-admin'],
  ['/node_modules/admin/', 'firebase-admin'],
  ['/node_modules/firebase/', 'firebase'],
  ['/node_modules/@firebase/firestore/', '@firebase/firestore'],
  ['/node_modules/@firebase/ai/', '@firebase/ai'],
  ['/node_modules/@firebase/util/', '@firebase/util'],
  ['/node_modules/firebase-functions/', 'firebase-functions'],
  ['/node_modules/next/', 'next'],
  ['/work/app/', 'app'],
];

function nameOf(url: string): string | null {
  return PACKAGES.find(([segment]) => url.includes(segment))?.[1] ?? null;
}

function load(overrides: Partial<ResolvedLoad> & Pick<ResolvedLoad, 'url'>): ResolvedLoad {
  return { specifier: 'x', importer: APP_IMPORTER, aiMode: 'sandbox', nameOf, ...overrides };
}

const ADMIN_FILE = 'file:///work/app/node_modules/firebase-admin/lib/app/index.js';
const FIREBASE_AI_FILE = 'file:///work/app/node_modules/firebase/ai/dist/index.mjs';
const FIREBASE_APP_FILE = 'file:///work/app/node_modules/firebase/app/dist/index.mjs';
const AT_FIRESTORE_FILE = 'file:///work/app/node_modules/@firebase/firestore/dist/index.node.mjs';
const AT_AI_FILE = 'file:///work/app/node_modules/@firebase/ai/dist/index.node.mjs';

describe('stopFor: firebase-admin', () => {
  it('stops the real firebase-admin from app code, naming the import, the importer, the file and the fix', () => {
    const stop = stopFor(load({ specifier: '/work/app/node_modules/firebase-admin/lib/app/index.js', url: ADMIN_FILE }));
    expect(stop).not.toBeNull();
    expect((stop as Error & { code: string }).code).toBe(REAL_SDK_STOPPED_CODE);
    expect(stop!.message).toContain('stopped loading the real firebase-admin');
    expect(stop!.message).toContain(`from   ${APP_IMPORTER}`);
    expect(stop!.message).toContain(`found  ${ADMIN_FILE}`);
    expect(stop!.message).toContain("'firebase-admin/app'");
    expect(stop!.message).toContain('without @pyric/cli/register');
  });

  it('stops an npm alias, because the manifest names firebase-admin', () => {
    const stop = stopFor(load({ specifier: 'admin/app', url: 'file:///work/app/node_modules/admin/lib/app/index.js' }));
    expect(stop?.message).toContain('stopped loading the real firebase-admin');
  });

  it('stops firebase-admin in production AI mode too', () => {
    expect(stopFor(load({ url: ADMIN_FILE, aiMode: 'production' }))).not.toBeNull();
  });

  it("lets production AI mode's App Check verifier bridge load firebase-admin, and only it (#1552)", () => {
    const bridge = load({ specifier: 'firebase-admin/app', url: ADMIN_FILE, importer: SHADOW_IMPORTER, aiMode: 'production' });
    expect(stopFor(bridge)).toBeNull();
    expect(stopFor({ ...bridge, importer: APP_IMPORTER })).not.toBeNull();
    expect(stopFor({ ...bridge, specifier: 'firebase-admin/auth' })).not.toBeNull();
  });

  it('lets one firebase-admin file import another', () => {
    const importer = 'file:///work/app/node_modules/firebase-admin/lib/app/index.js';
    expect(stopFor(load({ url: 'file:///work/app/node_modules/firebase-admin/lib/utils/index.js', importer }))).toBeNull();
  });
});

describe('stopFor: the client SDK', () => {
  it('stops the real firebase in sandbox AI mode', () => {
    const stop = stopFor(load({ specifier: 'firebase-a14c8a5423a75469/ai', url: FIREBASE_AI_FILE }));
    expect(stop?.message).toContain('stopped loading the real firebase');
    expect(stop?.message).toContain("with the app's API key");
  });

  it('stops @firebase/* imported by app code, and names the firebase/* import to use', () => {
    const stop = stopFor(load({ specifier: '@firebase/firestore', url: AT_FIRESTORE_FILE }));
    expect(stop?.message).toContain("import 'firebase/firestore' instead of '@firebase/firestore'");
  });

  it('lets a firebase file import @firebase/*', () => {
    expect(stopFor(load({ url: AT_FIRESTORE_FILE, importer: 'file:///work/app/node_modules/firebase/firestore/dist/index.mjs' }))).toBeNull();
  });

  it('lets a shadow module reach the firebase/app it wraps', () => {
    expect(stopFor(load({ specifier: 'firebase/app', url: FIREBASE_APP_FILE, importer: SHADOW_IMPORTER }))).toBeNull();
  });

  it('lets production AI mode load the real AI SDK and its packages from any importer, such as a server runner', () => {
    const vite = 'file:///work/app/node_modules/vite/dist/node/module-runner.js';
    expect(stopFor(load({ url: FIREBASE_AI_FILE, aiMode: 'production', importer: vite }))).toBeNull();
    expect(stopFor(load({ url: AT_AI_FILE, aiMode: 'production', importer: vite }))).toBeNull();
    expect(stopFor(load({ url: 'file:///work/app/node_modules/@firebase/util/dist/index.mjs', aiMode: 'production' }))).toBeNull();
  });

  it('still stops other @firebase/* packages in production AI mode', () => {
    expect(stopFor(load({ url: AT_FIRESTORE_FILE, aiMode: 'production' }))).not.toBeNull();
  });
});

describe('stopFor: everything else', () => {
  it('leaves files outside node_modules alone without reading a manifest', () => {
    const read: string[] = [];
    const result = stopFor(load({ url: 'file:///work/app/src/lib.js', nameOf: (url) => { read.push(url); return 'app'; } }));
    expect({ result, read }).toEqual({ result: null, read: [] });
  });

  it('leaves packages that only contain "firebase" in their name alone', () => {
    expect(stopFor(load({ url: 'file:///work/app/node_modules/firebase-functions/lib/v2/index.js' }))).toBeNull();
  });

  it('leaves built-ins and other non-file URLs alone', () => {
    expect(stopFor(load({ url: 'node:fs' }))).toBeNull();
  });
});

describe('createStopReporter', () => {
  it('writes each stopped file once', () => {
    const lines: string[] = [];
    const report = createStopReporter((line) => lines.push(line));
    const stop = stopFor(load({ url: ADMIN_FILE }))!;
    report(stop);
    report(stop);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('code: PYRIC_REAL_SDK_STOPPED');
  });
});
