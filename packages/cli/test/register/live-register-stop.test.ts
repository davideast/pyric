/**
 * Which register opens the real SDK, in Node processes with `@pyric/live`
 * installed in the project.
 *
 * `@pyric/live/register` opens the real-SDK stop only for its four live
 * rows: `firebase/app`, `firebase/auth`, `firebase/firestore` and
 * `firebase/app-check` load the installed SDK, every other Firebase import
 * and `firebase-admin` is refused with `PYRIC_LIVE_REFUSED`, and a load of
 * the real SDK by any other route stops. `@pyric/cli/register` alone keeps
 * the stop for every real `firebase/*` and `firebase-admin` load, the row
 * module ids included, and no file under the real packages loads.
 *
 * Each case runs under the `node` on PATH; run the file under Node 22.15 and
 * Node 24 to cover both hook implementations. Requires the CLI and
 * `@pyric/live` to be built (`dist/`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appFirebaseRoot } from '../../../live/src/start-checks.js';
import { liveAppDirs } from '../../src/register/live-package.js';

const cliDir = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliDir, '../..');
const liveDir = join(repoRoot, 'packages/live');
const liveRegisterFile = join(liveDir, 'dist/register.js');
const rowsDist = join(cliDir, 'dist/register/live-row.js');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const realFirebaseDir = realpathSync(dirname(requireFromRepo.resolve('firebase/package.json')));
const realAdminDir = realpathSync(dirname(requireFromRepo.resolve('firebase-admin/package.json')));
const requireFromFirebase = createRequire(join(realFirebaseDir, 'package.json'));

/** The root of an installed package: the nearest directory whose manifest has this name. */
function packageDir(fromFile: string, name: string): string {
  let dir = dirname(fromFile);
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === name) return dir;
    dir = dirname(dir);
  }
  throw new Error(`no ${name} above ${fromFile}`);
}

const storageDir = packageDir(requireFromFirebase.resolve('@firebase/storage'), '@firebase/storage');

/**
 * Imports each specifier in LOAD_SPECIFIERS in turn and reports each
 * outcome, and every file the process loaded from the real Firebase SDKs.
 * The load hook is registered before any register, so it sees every load the
 * register lets through.
 */
const OBSERVER = `import Module from 'node:module';
const loaded = [];
globalThis[Symbol.for('live.stop.loaded')] = loaded;
Module.registerHooks({ load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context); } });
`;

const PROBE = `const outcome = {};
for (const specifier of JSON.parse(process.env.LOAD_SPECIFIERS)) {
  try {
    await import(specifier);
    outcome[specifier] = 'loaded';
  } catch (error) {
    outcome[specifier] = error?.code ?? 'threw: ' + String(error?.message ?? error).split('\\n')[0];
  }
}
const isSdkFile = (url) => /\\/node_modules\\/(firebase|firebase-admin|@firebase\\/[^/]+)\\//.test(url);
const sdkFiles = globalThis[Symbol.for('live.stop.loaded')].filter(isSdkFile);
console.log('OUTCOME ' + JSON.stringify({ outcome, sdkFiles }));
`;

let projectDir: string;
/** A project with no @pyric/live: no node_modules above it has one. */
let otherDir: string;

interface Run {
  status: number | null;
  stderr: string;
  outcome: Record<string, string>;
  sdkFiles: string[];
}

/** Runs the probe under `registers` from `cwd`, with the probe in `entryDir` (the project by default). */
function run(registers: readonly string[], specifiers: readonly string[], options: { cwd?: string; entryDir?: string; env?: Record<string, string> } = {}): Run {
  const cwd = options.cwd ?? projectDir;
  const imports = ['--import', pathToFileURL(join(projectDir, 'observer.mjs')).href, ...registers.flatMap((entry) => ['--import', entry])];
  const result = spawnSync('node', [...imports, join(options.entryDir ?? projectDir, 'probe.mjs')], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: projectDir,
      LOAD_SPECIFIERS: JSON.stringify(specifiers),
      ...options.env,
    },
  });
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('OUTCOME ')) ?? 'OUTCOME {"outcome":{},"sdkFiles":[]}';
  const parsed = JSON.parse(line.slice('OUTCOME '.length)) as { outcome: Record<string, string>; sdkFiles: string[] };
  return { status: result.status, stderr: result.stderr, ...parsed };
}

/** The packages a list of loaded SDK file URLs came from, by their folder under node_modules. */
function packagesOf(files: readonly string[]): string[] {
  const names = files.map((url) => /\/node_modules\/((?:@firebase\/)?[^/]+)\//.exec(url.slice(url.lastIndexOf('/node_modules/')))?.[1] ?? url);
  return [...new Set(names)].sort();
}

/** The live row module id the CLI fixes for a specifier. */
async function rowUrl(specifier: string): Promise<string> {
  const rows = (await import(pathToFileURL(rowsDist).href)) as { REGISTER_ROW_URLS: ReadonlyMap<string, string> };
  const url = rows.REGISTER_ROW_URLS.get(specifier);
  if (url === undefined) throw new Error(`no row for ${specifier}`);
  return url;
}

const realFirestoreFile = pathToFileURL(requireFromFirebase.resolve('firebase/firestore')).href;
const realStorageFile = pathToFileURL(requireFromFirebase.resolve('firebase/storage')).href;
const realAdminFile = pathToFileURL(createRequire(join(realAdminDir, 'package.json')).resolve('firebase-admin/app')).href;

beforeAll(() => {
  for (const built of [liveRegisterFile, rowsDist]) {
    if (!existsSync(built)) throw new Error(`${built} missing: build @pyric/cli and @pyric/live first`);
  }
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-stop-')));
  const nm = join(projectDir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });
  mkdirSync(join(nm, '@firebase'), { recursive: true });
  symlinkSync(cliDir, join(nm, '@pyric/cli'));
  symlinkSync(liveDir, join(nm, '@pyric/live'));
  symlinkSync(realFirebaseDir, join(nm, 'firebase'));
  symlinkSync(realAdminDir, join(nm, 'firebase-admin'));
  symlinkSync(storageDir, join(nm, '@firebase/storage'));
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'live-stop-fixture', type: 'module' }));
  // The Firebase project live mode names, from the app's own Firebase config.
  writeFileSync(join(projectDir, '.firebaserc'), JSON.stringify({ projects: { default: 'live-stop-fixture' } }));
  writeFileSync(join(projectDir, 'observer.mjs'), OBSERVER);
  writeFileSync(join(projectDir, 'probe.mjs'), PROBE);
  otherDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-stop-other-')));
  writeFileSync(join(otherDir, 'package.json'), JSON.stringify({ name: 'no-live', type: 'module' }));
  writeFileSync(join(otherDir, 'probe.mjs'), PROBE);
});

afterAll(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  if (otherDir) rmSync(otherDir, { recursive: true, force: true });
});

const LIVE_REGISTER = '@pyric/live/register';
const CLI_REGISTER = '@pyric/cli/register';
const LIVE_ROWS = ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/app-check'];

describe('@pyric/live/register', () => {
  it('loads the installed SDK for the four live rows and refuses every other Firebase import and firebase-admin', () => {
    const refused = ['firebase/storage', 'firebase/firestore/lite', 'firebase/functions', 'firebase/compat/app', 'firebase', 'firebase-admin', 'firebase-admin/app'];
    const res = run([LIVE_REGISTER], [...LIVE_ROWS, ...refused]);
    expect(res.status, res.stderr).toBe(0);
    for (const specifier of LIVE_ROWS) expect(res.outcome[specifier], specifier).toBe('loaded');
    for (const specifier of refused) expect(res.outcome[specifier], specifier).toBe('PYRIC_LIVE_REFUSED');
    const loaded = packagesOf(res.sdkFiles);
    expect(loaded).toContain('firebase');
    expect(loaded).toContain('@firebase/firestore');
    expect(loaded).toContain('@firebase/auth');
    for (const name of ['firebase-admin', '@firebase/storage', '@firebase/database', '@firebase/functions']) expect(loaded, name).not.toContain(name);
  }, 60_000);

  it('names live mode and the service in the refusal', () => {
    const script = `import('firebase-admin/app').catch((error) => { console.log('OUTCOME ' + JSON.stringify({ outcome: { message: error.message }, sdkFiles: [] })); });`;
    writeFileSync(join(projectDir, 'refusal.mjs'), script);
    const result = spawnSync('node', ['--import', LIVE_REGISTER, join(projectDir, 'refusal.mjs')], {
      cwd: projectDir, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: projectDir },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('firebase-admin/app (the Admin SDK) is refused in live mode');
    expect(result.stdout).toContain('to a Node process');
  }, 60_000);

  it('stops the real SDK reached by any route but a live row: a file URL or an @firebase/* import', async () => {
    const res = run([LIVE_REGISTER], [realStorageFile, '@firebase/storage', realAdminFile]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.outcome).toEqual({
      [realStorageFile]: 'PYRIC_REAL_SDK_STOPPED',
      '@firebase/storage': 'PYRIC_REAL_SDK_STOPPED',
      [realAdminFile]: 'PYRIC_REAL_SDK_STOPPED',
    });
    expect(res.sdkFiles).toEqual([]);
    expect(res.stderr).toContain("In live mode, the installed SDK loads only through @pyric/live's rows.");
    expect(res.stderr).toContain(
      'Fix: import firebase/app, firebase/auth, firebase/firestore, firebase/app-check, firebase/database or firebase/ai by its package name',
    );
    // The row's id names the row module, never the installed SDK behind it: imported directly, it is the row.
    const firestoreRow = await rowUrl('firebase/firestore');
    const direct = run([LIVE_REGISTER], [firestoreRow]);
    expect(direct.outcome[firestoreRow]).toBe('loaded');
  }, 60_000);

  it('gives a createRequire forged from a row the row again, and stops one forged from an allowed SDK file', async () => {
    const firestoreRow = await rowUrl('firebase/firestore');
    const script = `import { createRequire } from 'node:module';
const row = await import('firebase/firestore');
const loaded = globalThis[Symbol.for('live.stop.loaded')];
const allowedFile = loaded.find((url) => /\\/node_modules\\/firebase\\/firestore\\/dist\\/.+\\.mjs$/.test(url));
const attempt = (fromUrl, specifier) => {
  try {
    const required = createRequire(fromUrl)(specifier);
    return required === row ? 'row' : 'loaded ' + Object.keys(required).length;
  } catch (error) {
    return error?.code ?? 'threw: ' + String(error?.message ?? error).split('\\n')[0];
  }
};
const before = loaded.length;
const outcome = { allowedFile: allowedFile ?? 'none', fromRow: attempt(${JSON.stringify(firestoreRow)}, 'firebase/firestore') };
for (const specifier of ['@firebase/storage', '@firebase/database', '@firebase/functions', '@firebase/firestore', 'firebase/storage']) {
  outcome[specifier] = attempt(allowedFile, specifier);
}
const isSdkFile = (url) => /\\/node_modules\\/(firebase|firebase-admin|@firebase\\/[^/]+)\\//.test(url);
console.log('OUTCOME ' + JSON.stringify({ outcome, sdkFiles: loaded.slice(before).filter(isSdkFile) }));
`;
    writeFileSync(join(projectDir, 'forge.mjs'), script);
    const imports = ['--import', pathToFileURL(join(projectDir, 'observer.mjs')).href, '--import', LIVE_REGISTER];
    const result = spawnSync('node', [...imports, join(projectDir, 'forge.mjs')], {
      cwd: projectDir, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: projectDir },
    });
    const line = result.stdout.split('\n').find((entry) => entry.startsWith('OUTCOME ')) ?? 'OUTCOME {"outcome":{},"sdkFiles":[]}';
    const { outcome, sdkFiles } = JSON.parse(line.slice('OUTCOME '.length)) as { outcome: Record<string, string>; sdkFiles: string[] };
    expect(result.status, result.stderr).toBe(0);
    expect(outcome.allowedFile, result.stderr).not.toBe('none');
    // The row's own URL as importer, through require: the row again, never the unobserved Firestore.
    expect(outcome.fromRow, result.stderr).toBe('row');
    // An allowed client SDK file as importer, through require: stopped, whatever package it names.
    for (const specifier of ['@firebase/storage', '@firebase/database', '@firebase/functions', '@firebase/firestore']) {
      expect(outcome[specifier], specifier).toBe('PYRIC_REAL_SDK_STOPPED');
    }
    expect(outcome['firebase/storage']).toBe('PYRIC_LIVE_REFUSED');
    expect(sdkFiles).toEqual([]);
  }, 60_000);

  it("serves require() the live row, or stops it where Node's require skips the hooks; firebase-admin never loads", () => {
    const script = `const outcome = {};
for (const specifier of ['firebase/firestore', 'firebase-admin']) {
  try { require(specifier); outcome[specifier] = 'loaded'; } catch (error) { outcome[specifier] = error?.code ?? String(error); }
}
const files = globalThis[Symbol.for('live.stop.loaded')].filter((url) => url.includes('/node_modules/firebase-admin/'));
console.log('OUTCOME ' + JSON.stringify({ outcome: { ...outcome, node: process.versions.node }, sdkFiles: files }));
`;
    writeFileSync(join(projectDir, 'probe.cjs'), script);
    const imports = ['--import', pathToFileURL(join(projectDir, 'observer.mjs')).href, '--import', LIVE_REGISTER];
    const result = spawnSync('node', [...imports, join(projectDir, 'probe.cjs')], {
      cwd: projectDir, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: projectDir },
    });
    const line = result.stdout.split('\n').find((entry) => entry.startsWith('OUTCOME ')) ?? 'OUTCOME {}';
    const { outcome, sdkFiles } = JSON.parse(line.slice('OUTCOME '.length)) as { outcome: Record<string, string>; sdkFiles: string[] };
    expect(result.status, result.stderr).toBe(0);
    expect(sdkFiles).toEqual([]);
    // Node 22.15 resolves a CommonJS entry's require() without the sync hooks, so the stop is what meets it.
    const requireReachesHooks = Number(outcome.node.split('.')[0]) >= 23;
    if (requireReachesHooks) {
      expect(outcome['firebase/firestore']).toBe('loaded');
      expect(outcome['firebase-admin']).toBe('PYRIC_LIVE_REFUSED');
    } else {
      expect(outcome['firebase/firestore']).toBe('PYRIC_REAL_SDK_STOPPED');
      expect(['PYRIC_LIVE_REFUSED', 'PYRIC_REAL_SDK_STOPPED']).toContain(outcome['firebase-admin']);
      expect(result.stderr).toContain(`CommonJS require() on Node ${outcome.node} can't be served under live mode`);
      expect(result.stderr).toContain('from an ES module, or run Node 23 or later');
    }
  }, 60_000);

  it("opens the parent's project rows in a child process started in a directory without @pyric/live", () => {
    const child = `import('firebase/firestore').then((m) => console.log('CHILD ' + typeof m.getFirestore), (e) => console.log('CHILD ' + (e?.code ?? e)));`;
    const script = `import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(child)}], { cwd: ${JSON.stringify(otherDir)}, encoding: 'utf8' });
console.log('OUTCOME ' + JSON.stringify({ outcome: { status: String(result.status), stdout: result.stdout.trim(), stderr: result.stderr }, sdkFiles: [] }));
`;
    writeFileSync(join(projectDir, 'parent.mjs'), script);
    const result = spawnSync('node', ['--import', LIVE_REGISTER, join(projectDir, 'parent.mjs')], {
      cwd: projectDir, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: projectDir },
    });
    const line = result.stdout.split('\n').find((entry) => entry.startsWith('OUTCOME ')) ?? 'OUTCOME {"outcome":{}}';
    const { outcome } = JSON.parse(line.slice('OUTCOME '.length)) as { outcome: Record<string, string> };
    expect(result.status, result.stderr).toBe(0);
    expect(outcome.status, outcome.stderr).toBe('0');
    expect(outcome.stdout).toBe('CHILD function');
    // The first process prints the start line; a child opens the same rows quietly.
    expect(result.stderr).toContain('@pyric/live/register: live mode for the Firebase project live-stop-fixture.');
    expect(outcome.stderr).not.toContain('@pyric/live/register: live mode');
  }, 60_000);

  it('opens from its own package in a project without @pyric/live, refuses to start without the app SDK, and nothing loads', () => {
    // The probe in otherDir too: the register reads the app's firebase from the entry script's folder first (#2166).
    const res = run([pathToFileURL(liveRegisterFile).href], ['firebase/firestore'], { cwd: otherDir, entryDir: otherDir });
    expect(res.status).not.toBe(0);
    // The register found @pyric/live where it was loaded from (#2116), so the start checks ran.
    expect(res.stderr).not.toContain('live rows need @pyric/live installed in the project');
    expect(res.stderr).toContain('This project has no firebase installed');
    // The refusal names the folder it looked from and says where to start.
    expect(res.stderr).toContain(`None resolves from ${otherDir}.`);
    expect(res.stderr).toContain('Start from the folder of the app that installs firebase.');
    expect(res.sdkFiles).toEqual([]);
  }, 60_000);

  it('refuses to start beside an active @pyric/cli/register', () => {
    const res = run([CLI_REGISTER, LIVE_REGISTER], ['firebase/firestore'], { env: { PYRIC_SANDBOX: 'local' } });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('@pyric/cli/register is already active in this process');
  }, 60_000);

  it('keeps @pyric/cli/register from activating after it', () => {
    const res = run([LIVE_REGISTER, CLI_REGISTER], ['firebase/firestore'], { env: { PYRIC_SANDBOX: 'local' } });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain('@pyric/cli/register: not activating, because @pyric/live/register is active');
    expect(res.outcome['firebase/firestore']).toBe('loaded');
    expect(packagesOf(res.sdkFiles)).toContain('@firebase/firestore');
  }, 60_000);
});

describe('@pyric/cli/register alone, with @pyric/live installed', () => {
  it('keeps the stop for every real firebase/* and firebase-admin load, the live row ids included, and loads no SDK file', async () => {
    const rowIds = await Promise.all(LIVE_ROWS.map(rowUrl));
    const specifiers = [realFirestoreFile, realStorageFile, '@firebase/storage', realAdminFile, ...rowIds];
    const res = run([CLI_REGISTER], specifiers, { env: { PYRIC_SANDBOX: 'local' } });
    expect(res.status, res.stderr).toBe(0);
    for (const specifier of [realFirestoreFile, realStorageFile, '@firebase/storage', realAdminFile]) {
      expect(res.outcome[specifier], specifier).toBe('PYRIC_REAL_SDK_STOPPED');
    }
    for (const id of rowIds) expect(res.outcome[id], id).toBe('ERR_MODULE_NOT_FOUND');
    expect(res.sdkFiles).toEqual([]);
  }, 60_000);
});

describe('the folders the register reads the app firebase from (#2166)', () => {
  let base: string;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-app-dirs-')));
    for (const name of ['entry', 'cwd', 'root', 'links']) mkdirSync(join(base, name));
    for (const name of ['entry', 'cwd']) {
      mkdirSync(join(base, name, 'node_modules', 'firebase'), { recursive: true });
      writeFileSync(join(base, name, 'node_modules', 'firebase', 'package.json'), JSON.stringify({ name: 'firebase', version: '12.12.0' }));
    }
    writeFileSync(join(base, 'entry', 'server.mjs'), '');
    symlinkSync(join(base, 'entry', 'server.mjs'), join(base, 'links', 'server.mjs'));
  });
  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('lists the entry script folder, then the working directory', () => {
    expect(liveAppDirs(join(base, 'entry', 'server.mjs'), join(base, 'cwd'), [])).toEqual([join(base, 'entry'), join(base, 'cwd')]);
  });

  it('lists the working directory once when the entry script is in it, and alone without an entry script', () => {
    expect(liveAppDirs(join(base, 'cwd', 'server.mjs'), join(base, 'cwd'), [])).toEqual([join(base, 'cwd')]);
    expect(liveAppDirs(undefined, join(base, 'cwd'), [])).toEqual([join(base, 'cwd')]);
  });

  it('skips argv[1] when the process runs code from the command line', () => {
    for (const flag of ['-e', '--eval', '-p', '--print']) {
      expect(liveAppDirs(join(base, 'entry', 'server.mjs'), join(base, 'cwd'), [flag, 'code'])).toEqual([join(base, 'cwd')]);
    }
  });

  it('follows a symlinked entry script to its real folder, unless --preserve-symlinks-main', () => {
    const link = join(base, 'links', 'server.mjs');
    expect(liveAppDirs(link, join(base, 'cwd'), [])[0]).toBe(join(base, 'entry'));
    expect(liveAppDirs(link, join(base, 'cwd'), ['--preserve-symlinks-main'])[0]).toBe(join(base, 'links'));
  });

  it('reads firebase from the first folder that resolves it, else the project root', () => {
    const [entry, cwd, root] = ['entry', 'cwd', 'root'].map((name) => join(base, name));
    expect(appFirebaseRoot([entry, cwd], root)).toBe(entry);
    expect(appFirebaseRoot([cwd, entry], root)).toBe(cwd);
    expect(appFirebaseRoot([join(base, 'links'), cwd], root)).toBe(cwd);
    expect(appFirebaseRoot([join(base, 'links')], root)).toBe(root);
  });
});
