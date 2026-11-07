/**
 * The Admin rows on the live register (`admin-row.ts`): with `firebase-admin`
 * passed through and the Admin rows open, the four class-defining loads of
 * the real Admin SDK, and the two that define the App Check and Messaging
 * classes, resolve to the fixed Admin row modules, whose source
 * comes from the installed `@pyric/live`, and each row loads the real module.
 * Every other `lib/<service>/` load of the Admin SDK loads the real module,
 * unobserved (ADR 0022, amendment 2026-11-07). The rows stay
 * shut unless the register opens them, so a passed-through Admin SDK loads
 * the real modules directly.
 *
 * Each case runs a child process under the `node` on PATH. On Node 22,
 * firebase-admin's own `require()` calls skip the resolve hooks, so the rows
 * are never reached there: the case checks that. Requires the CLI and
 * `@pyric/live` to be built (`dist/`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerRows, adminTreeResolution } from '../../src/register/supplied-rows.js';

const cliDir = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliDir, '../..');
const liveDir = join(repoRoot, 'packages/live');
const adminRowDist = join(cliDir, 'dist/register/admin-row.js');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const realAdminDir = realpathSync(dirname(requireFromRepo.resolve('firebase-admin/package.json')));
/** The Admin row ids the built register serves, the ones a child process sees. */
const { ADMIN_ROW_URLS } = (await import(pathToFileURL(adminRowDist).href)) as { ADMIN_ROW_URLS: ReadonlyMap<string, string> };

/**
 * Opens the live rows in this process, with `firebase-admin` passed through
 * and the Admin rows as `ADMIN_ROWS` says, then records what the register
 * answers at the six loads, and calls each Admin service by its modular
 * entry and by the namespace.
 */
const PROBE = `import Module from 'node:module';
import { writeSync } from 'node:fs';
import { activateWithSuppliedRows } from '@pyric/cli/register/internal/supplied-rows';
await activateWithSuppliedRows({ passThrough: ['firebase-admin'], adminRows: process.env.ADMIN_ROWS === '1' });
const resolved = [];
const ROW_SPECIFIERS = new Set(['@google-cloud/firestore', '@google-cloud/storage', '@firebase/database-compat/standalone', './base-auth', './app-check', './messaging']);
Module.registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (ROW_SPECIFIERS.has(specifier)) resolved.push({ specifier, from: context.parentURL, url: result.url });
  return result;
} });
const outcome = {};
async function attempt(name, call) {
  try { await call(); outcome[name] = 'ok'; } catch (error) { outcome[name] = error?.code ?? 'threw: ' + String(error?.message ?? error).split('\\n')[0]; }
}
const { initializeApp } = await import('firebase-admin/app');
const app = initializeApp({ projectId: 'admin-row-fixture', databaseURL: 'https://admin-row-fixture.firebaseio.com', storageBucket: 'admin-row-fixture.appspot.com' });
await attempt('getFirestore', async () => { const { getFirestore } = await import('firebase-admin/firestore'); getFirestore(app); });
await attempt('getStorage', async () => { const { getStorage } = await import('firebase-admin/storage'); getStorage(app).bucket(); });
await attempt('getDatabase', async () => { const { getDatabase } = await import('firebase-admin/database'); getDatabase(app); });
await attempt('getAuth', async () => { const { getAuth } = await import('firebase-admin/auth'); getAuth(app); });
const admin = (await import('firebase-admin')).default;
await attempt('admin.firestore', () => admin.firestore());
await attempt('admin.securityRules', () => admin.securityRules());
await attempt('getMessaging', async () => { const { getMessaging } = await import('firebase-admin/messaging'); getMessaging(app); });
await attempt('getAppCheck', async () => { const { getAppCheck } = await import('firebase-admin/app-check'); getAppCheck(app); });
writeSync(1, 'OUTCOME ' + JSON.stringify({ node: process.versions.node, outcome, resolved }) + '\\n');
process.exit(0);
`;

let projectDir: string;

interface Run {
  status: number | null;
  stderr: string;
  node: string;
  outcome: Record<string, string>;
  resolved: { specifier: string; from?: string; url: string }[];
}

function run(adminRows: boolean): Run {
  const result = spawnSync('node', [join(projectDir, 'probe.mjs')], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: projectDir, ADMIN_ROWS: adminRows ? '1' : '0' },
  });
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('OUTCOME '));
  if (line === undefined) throw new Error(`no outcome (status ${result.status}):\n${result.stderr}`);
  return { status: result.status, stderr: result.stderr, ...(JSON.parse(line.slice('OUTCOME '.length)) as Omit<Run, 'status' | 'stderr'>) };
}

/** The URLs a specifier resolved to in a run, for every importer but a row module itself. */
function urlsOf(res: Run, specifier: string): string[] {
  const rowUrls: readonly string[] = [...ADMIN_ROW_URLS.values()];
  const fromSdk = res.resolved.filter((entry) => entry.specifier === specifier && !rowUrls.includes(entry.from ?? ''));
  return [...new Set(fromSdk.map((entry) => entry.url))];
}

function isNode22(res: Run): boolean {
  return Number(res.node.split('.')[0]) < 23;
}

beforeAll(() => {
  for (const built of [adminRowDist, join(liveDir, 'dist/node-modules.js')]) {
    if (!existsSync(built)) throw new Error(`${built} missing: build @pyric/cli and @pyric/live first`);
  }
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-admin-row-')));
  const nm = join(projectDir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });
  symlinkSync(cliDir, join(nm, '@pyric/cli'));
  symlinkSync(liveDir, join(nm, '@pyric/live'));
  symlinkSync(realAdminDir, join(nm, 'firebase-admin'));
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'admin-row-fixture', type: 'module' }));
  writeFileSync(join(projectDir, '.firebaserc'), JSON.stringify({ projects: { default: 'admin-row-fixture' } }));
  writeFileSync(join(projectDir, 'probe.mjs'), PROBE);
});

afterAll(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

/** The specifier each row stands for, as firebase-admin's own files require it. */
const ROW_SPECIFIERS = {
  firestore: '@google-cloud/firestore',
  storage: '@google-cloud/storage',
  database: '@firebase/database-compat/standalone',
  auth: './base-auth',
  'app-check': './app-check',
  messaging: './messaging',
} as const;

describe('Admin rows on the live register', () => {
  it('stay shut by default', () => {
    const rows = registerRows(new Set(['firebase-admin']));
    const request = { specifier: '@google-cloud/firestore', url: 'file:///app/node_modules/@google-cloud/firestore/build/src/index.js' };
    expect(adminTreeResolution(rows, request)).toEqual({ kind: 'unserved' });
  });

  it('let a lib/<service>/ load the rows do not serve through as an unobserved Admin subpath', () => {
    const rows = registerRows(new Set(['firebase-admin']), true);
    rows.open({
      projectUrl: 'file:///app/package.json',
      refusal: (specifier) => Object.assign(new Error(`refused ${specifier}`), { code: 'PYRIC_LIVE_REFUSED' }),
      moduleSource: () => null,
    });
    const load = (folder: string) => adminTreeResolution(rows, {
      specifier: `../${folder}/index.js`,
      url: `file:///app/node_modules/firebase-admin/lib/${folder}/index.js`,
      nameOf: () => 'firebase-admin',
      pathInPackage: () => `lib/${folder}/index.js`,
    });
    expect([load('remote-config'), load('security-rules')]).toEqual([
      { kind: 'admin-unobserved', subpath: 'firebase-admin/remote-config' },
      { kind: 'admin-unobserved', subpath: 'firebase-admin/security-rules' },
    ]);
  });

  it('serve the App Check and Messaging rows at the loads that define their classes', () => {
    const rows = registerRows(new Set(['firebase-admin']), true);
    rows.open({
      projectUrl: 'file:///app/package.json',
      refusal: (specifier) => Object.assign(new Error(`refused ${specifier}`), { code: 'PYRIC_LIVE_REFUSED' }),
      moduleSource: () => null,
    });
    const load = (folder: string, file: string) => adminTreeResolution(rows, {
      specifier: `./${file}`,
      url: `file:///app/node_modules/firebase-admin/lib/${folder}/${file}.js`,
      nameOf: () => 'firebase-admin',
      pathInPackage: () => `lib/${folder}/${file}.js`,
    });
    expect([load('app-check', 'app-check'), load('messaging', 'messaging'), load('messaging', 'messaging-internal')]).toEqual([
      { kind: 'admin-row', url: ADMIN_ROW_URLS.get('app-check' as never) },
      { kind: 'admin-row', url: ADMIN_ROW_URLS.get('messaging' as never) },
      { kind: 'unserved' },
    ]);
  });

  it('serve the row module at each of the six loads, through the modular entries and the namespace, and load other services unobserved', () => {
    const res = run(true);
    if (isNode22(res)) {
      // Node 22 runs firebase-admin's own require() outside the hooks: no row is reached.
      for (const url of ADMIN_ROW_URLS.values()) expect(res.resolved.map((entry) => entry.url)).not.toContain(url);
      return;
    }
    for (const [row, specifier] of Object.entries(ROW_SPECIFIERS)) {
      expect(urlsOf(res, specifier), specifier).toEqual([ADMIN_ROW_URLS.get(row as keyof typeof ROW_SPECIFIERS)!]);
    }
    const fromNamespace = res.resolved.find((entry) => entry.specifier === '@google-cloud/firestore' && entry.from?.endsWith('/lib/app/firebase-namespace.js'));
    expect(fromNamespace?.url).toBe(ADMIN_ROW_URLS.get('firestore'));
    expect(res.outcome).toEqual({
      getFirestore: 'ok',
      getStorage: 'ok',
      getDatabase: 'ok',
      getAuth: 'ok',
      'admin.firestore': 'ok',
      'admin.securityRules': 'ok',
      getMessaging: 'ok',
      getAppCheck: 'ok',
    });
  });

  it('load the real modules directly while shut', () => {
    const res = run(false);
    const rowUrls = [...ADMIN_ROW_URLS.values()];
    expect(res.resolved.some((entry) => rowUrls.includes(entry.url))).toBe(false);
    expect(res.outcome['admin.securityRules']).toBe('ok');
    expect(res.outcome.getFirestore).toBe('ok');
    if (isNode22(res)) return;
    expect(urlsOf(res, '@google-cloud/firestore')[0]).toContain('/node_modules/@google-cloud/firestore/');
  });
});
