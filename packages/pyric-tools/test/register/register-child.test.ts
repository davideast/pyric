/**
 * Child-process integration for `pyric-tools/register`: real `node --import`
 * runs against fixture scripts in a temp project whose node_modules symlinks
 * the workspace's built pyric packages (plus the real firebase/firebase-admin
 * for the inertness check). No browser, no server — resolution + activation
 * gating only.
 *
 * Requires the packages to be BUILT (`bun run build`) — the child loads
 * dist/register/index.js and the pyric mirrors' dist output.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const toolsRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(toolsRoot, '../..');
const registerDist = join(toolsRoot, 'dist/register/index.js');
const registerUrl = pathToFileURL(registerDist).href;

/** The sync-hooks API needs Node ≥ 22.15; skip the CJS leg without it. */
const hasRegisterHooks =
  spawnSync('node', ['-p', "typeof require('node:module').registerHooks"], {
    encoding: 'utf8',
  }).stdout?.trim() === 'function';

let fixtureDir: string;

function runNode(
  script: string,
  env: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('node', ['--import', registerUrl, script], {
    cwd: fixtureDir,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: undefined, PYRIC_SANDBOX: undefined, PYRIC_SANDBOX_FORCE: undefined, ...env },
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

beforeAll(() => {
  if (!existsSync(registerDist)) {
    throw new Error(`dist/register/index.js missing — run \`bun run build\` first (${registerDist})`);
  }
  // node --version guard: the suite itself needs a node on PATH.
  execFileSync('node', ['--version']);

  fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-register-'));
  const nm = join(fixtureDir, 'node_modules');
  mkdirSync(nm);
  // The pyric mirrors (workspace builds) + the real Firebase packages, so
  // the fixture resolves BOTH the mapped and the unmapped specifiers.
  symlinkSync(join(repoRoot, 'packages/pyric-admin'), join(nm, 'pyric-admin'));
  symlinkSync(join(repoRoot, 'packages/pyric'), join(nm, 'pyric'));
  symlinkSync(join(repoRoot, 'node_modules/firebase-admin'), join(nm, 'firebase-admin'));
  symlinkSync(join(repoRoot, 'node_modules/firebase'), join(nm, 'firebase'));
  writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({ name: 'register-fixture', type: 'commonjs' }));

  // ESM fixture: env is set, firebase-admin/app IS pyric-admin (its
  // ADMIN_APP_TARGET symbol is pyric-admin-only), and the factory global
  // mints the lazy branded handle synchronously.
  writeFileSync(
    join(fixtureDir, 'main.mjs'),
    `import assert from 'node:assert';
assert.ok(process.env.PYRIC_SANDBOX, 'PYRIC_SANDBOX must be set in the child');
const app = await import('firebase-admin/app');
assert.strictEqual(app.ADMIN_APP_TARGET, Symbol.for('pyric.admin.app.target'), 'firebase-admin/app must be pyric-admin/app');
const factory = globalThis[Symbol.for('pyric.remote.sandboxFactory')];
assert.strictEqual(typeof factory, 'function', 'sandbox factory global must be installed');
const handle = factory({ url: 'http://127.0.0.1:9' });
assert.strictEqual(handle[Symbol.for('pyric.remote.sandbox')], true, 'factory must return the branded handle');
assert.strictEqual(typeof handle.channel.op, 'function');
assert.ok(handle.ready instanceof Promise, 'handle.ready must be a promise');
handle.ready.catch(() => {});
handle.close();
console.log('ESM_OK');
`,
  );

  // CJS fixture: require() interception (sync hooks + the ESM-only exports
  // fallback → require(esm)).
  writeFileSync(
    join(fixtureDir, 'main.cjs'),
    `const assert = require('node:assert');
assert.ok(process.env.PYRIC_SANDBOX, 'PYRIC_SANDBOX must be set in the child');
const app = require('firebase-admin/app');
assert.strictEqual(app.ADMIN_APP_TARGET, Symbol.for('pyric.admin.app.target'), 'require(firebase-admin/app) must be pyric-admin/app');
assert.strictEqual(typeof globalThis[Symbol.for('pyric.remote.sandboxFactory')], 'function');
console.log('CJS_OK');
`,
  );

  // Mirror-exemption fixture (the merged-stack repro, scoped to this
  // branch): a USER import of firebase-admin/database is rewritten to
  // pyric-admin/database, whose OWN prod-arm import of
  // firebase-admin/database (getDatabaseWithUrl et al.) must resolve to
  // REAL firebase-admin — without the exemption that import self-rewrites
  // and the load crashes with "does not provide an export named
  // 'getDatabaseWithUrl'".
  writeFileSync(
    join(fixtureDir, 'prod-arm.mjs'),
    `import assert from 'node:assert';
const db = await import('firebase-admin/database');
const direct = await import('pyric-admin/database');
assert.strictEqual(db, direct, 'user import of firebase-admin/database must BE pyric-admin/database');
assert.strictEqual(db.getDatabaseWithUrl, undefined, 'surface must be pyric-admin, not real firebase-admin');
assert.strictEqual(typeof db.getDatabase, 'function');
console.log('PROD_ARM_OK');
`,
  );

  // Inertness probe: reports whether the rewrite happened + factory presence.
  writeFileSync(
    join(fixtureDir, 'probe.mjs'),
    `const app = await import('firebase-admin/app');
const factory = globalThis[Symbol.for('pyric.remote.sandboxFactory')];
console.log(JSON.stringify({
  rewritten: app.ADMIN_APP_TARGET === Symbol.for('pyric.admin.app.target'),
  factory: typeof factory,
}));
`,
  );
});

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe('pyric-tools/register (child process)', () => {
  it('rewrites ESM imports and installs the factory global when PYRIC_SANDBOX is set', () => {
    const res = runNode('main.mjs', { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000' });
    expect(res.stderr).toContain('pyric-tools/register: active');
    expect(res.stdout).toContain('ESM_OK');
    expect(res.status).toBe(0);
  });

  it("rewrites user imports but EXEMPTS the mirrors' own prod-arm imports", () => {
    const res = runNode('prod-arm.mjs', { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000' });
    expect(res.stderr).toContain('pyric-tools/register: active');
    // The success line is only reachable when pyric-admin/database loaded,
    // i.e. its internal firebase-admin/database import stayed unrewritten.
    expect(res.stdout).toContain('PROD_ARM_OK');
    expect(res.status).toBe(0);
  });

  it.skipIf(!hasRegisterHooks)('rewrites CJS require() via the sync hooks', () => {
    const res = runNode('main.cjs', { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000' });
    expect(res.stderr).toContain('pyric-tools/register: active');
    expect(res.stdout).toContain('CJS_OK');
    expect(res.status).toBe(0);
  });

  it('is inert without PYRIC_SANDBOX — real firebase-admin, no factory, no log', () => {
    const res = runNode('probe.mjs', {});
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ rewritten: false, factory: 'undefined' });
    expect(res.stderr).not.toContain('pyric-tools/register');
  });

  it('refuses under NODE_ENV=production (logs, stays inert)', () => {
    const res = runNode('probe.mjs', {
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000',
      NODE_ENV: 'production',
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('refusing to activate under NODE_ENV=production');
    expect(JSON.parse(res.stdout)).toEqual({ rewritten: false, factory: 'undefined' });
  });

  it('PYRIC_SANDBOX_FORCE=1 overrides the production refusal', () => {
    const res = runNode('probe.mjs', {
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000',
      NODE_ENV: 'production',
      PYRIC_SANDBOX_FORCE: '1',
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('pyric-tools/register: active');
    expect(JSON.parse(res.stdout)).toEqual({ rewritten: true, factory: 'function' });
  });
});
