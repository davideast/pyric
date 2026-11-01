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
const ADMIN_BRIDGE_IMPORTER = pathToFileURL(join(cliRoot, 'src/register/app-bridge-admin-app-check.ts')).href;
const APP_IMPORTER = 'file:///work/app/src/route.js';

/** Packages by path segment, as the manifests on disk would name them. */
const PACKAGES: ReadonlyArray<readonly [segment: string, name: string]> = [
  ['/node_modules/firebase-admin/', 'firebase-admin'],
  ['/node_modules/admin/', 'firebase-admin'],
  ['/node_modules/firebase/', 'firebase'],
  ['/node_modules/fb/', 'firebase'],
  ['/node_modules/@firebase/firestore/', '@firebase/firestore'],
  ['/node_modules/@firebase/ai/', '@firebase/ai'],
  ['/node_modules/@firebase/util/', '@firebase/util'],
  ['/node_modules/@firebase/auth/', '@firebase/auth'],
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
const ADMIN_UTILS_FILE = 'file:///work/app/node_modules/firebase-admin/lib/utils/index.js';
const FIREBASE_AI_FILE = 'file:///work/app/node_modules/firebase/ai/dist/index.mjs';
const FIREBASE_APP_FILE = 'file:///work/app/node_modules/firebase/app/dist/index.mjs';
const FIREBASE_APP_CHECK_FILE = 'file:///work/app/node_modules/firebase/app-check/dist/index.mjs';
const FIREBASE_FIRESTORE_FILE = 'file:///work/app/node_modules/firebase/firestore/dist/index.mjs';
const AT_FIRESTORE_FILE = 'file:///work/app/node_modules/@firebase/firestore/dist/index.node.mjs';
const AT_AI_FILE = 'file:///work/app/node_modules/@firebase/ai/dist/index.node.mjs';

describe('stopFor: firebase-admin', () => {
  it('stops the real firebase-admin from app code, naming the import, the importer, the file and the fix', () => {
    const stop = stopFor(load({ specifier: '/work/app/node_modules/firebase-admin/lib/app/index.js', url: ADMIN_FILE }), noneAllowed());
    expect(stop).not.toBeNull();
    expect((stop as Error & { code: string }).code).toBe(REAL_SDK_STOPPED_CODE);
    expect(stop!.message).toContain('stopped loading the real firebase-admin');
    expect(stop!.message).toContain(`from   ${APP_IMPORTER}`);
    expect(stop!.message).toContain(`found  ${ADMIN_FILE}`);
    expect(stop!.message).toContain("'firebase-admin/app'");
    expect(stop!.message).toContain('without @pyric/cli/register');
  });

  it('stops an npm alias, because the manifest names firebase-admin', () => {
    const stop = stopFor(load({ specifier: 'admin/app', url: 'file:///work/app/node_modules/admin/lib/app/index.js' }), noneAllowed());
    expect(stop?.message).toContain('stopped loading the real firebase-admin');
  });

  it('stops firebase-admin in production AI mode too', () => {
    expect(stopFor(load({ url: ADMIN_FILE, aiMode: 'production' }), noneAllowed())).not.toBeNull();
  });

  it("lets production AI mode's App Check verifier bridge load firebase-admin, and only it (#1552)", () => {
    const bridge = load({ specifier: 'firebase-admin/app', url: ADMIN_FILE, importer: ADMIN_BRIDGE_IMPORTER, aiMode: 'production' });
    expect(stopFor(bridge, noneAllowed())).toBeNull();
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

  it("lets Node 22 resolve an allowed CommonJS file again by its own path with no importer (#1707)", () => {
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

  it('stops @firebase/* imported by app code, and names the firebase/* import to use', () => {
    const stop = stopFor(load({ specifier: '@firebase/firestore', url: AT_FIRESTORE_FILE }), noneAllowed());
    expect(stop?.message).toContain("import 'firebase/firestore' instead of '@firebase/firestore'");
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

  it('lets a shadow module reach the firebase/app it wraps', () => {
    expect(stopFor(load({ specifier: 'firebase/app', url: FIREBASE_APP_FILE, importer: SHADOW_IMPORTER }), noneAllowed())).toBeNull();
  });

  it('lets production AI mode load the real AI SDK and its packages from any importer, such as a server runner', () => {
    const vite = 'file:///work/app/node_modules/vite/dist/node/module-runner.js';
    for (const url of [FIREBASE_AI_FILE, FIREBASE_APP_FILE, FIREBASE_APP_CHECK_FILE, AT_AI_FILE]) {
      expect(stopFor(load({ url, aiMode: 'production', importer: vite }), noneAllowed())).toBeNull();
    }
    expect(stopFor(load({ url: 'file:///work/app/node_modules/@firebase/util/dist/index.mjs', aiMode: 'production' }), noneAllowed())).toBeNull();
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

describe('stopFor: everything else', () => {
  it('leaves files outside node_modules alone without reading a manifest', () => {
    const read: string[] = [];
    const result = stopFor(load({ url: 'file:///work/app/src/lib.js', nameOf: (url) => { read.push(url); return 'app'; } }), noneAllowed());
    expect({ result, read }).toEqual({ result: null, read: [] });
  });

  it('leaves packages that only contain "firebase" in their name alone', () => {
    expect(stopFor(load({ url: 'file:///work/app/node_modules/firebase-functions/lib/v2/index.js' }), noneAllowed())).toBeNull();
  });

  it('leaves built-ins and other non-file URLs alone', () => {
    expect(stopFor(load({ url: 'node:fs' }), noneAllowed())).toBeNull();
  });
});

describe('createStopReporter', () => {
  it('writes each stopped file once', () => {
    const lines: string[] = [];
    const report = createStopReporter((line) => lines.push(line));
    const stop = stopFor(load({ url: ADMIN_FILE }), noneAllowed())!;
    report(stop);
    report(stop);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('code: PYRIC_REAL_SDK_STOPPED');
  });
});
