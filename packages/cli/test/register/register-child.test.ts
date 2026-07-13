/**
 * Child-process integration for `@pyric/cli/register`: real `node --import`
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
let inactiveFixtureDir: string;

function runNode(
  script: string,
  env: Record<string, string | undefined>,
  cwd: string = fixtureDir,
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('node', ['--import', registerUrl, script], {
    cwd,
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
  // Activated fixture: mirrors only. The canonical Firebase specifiers below
  // must be intercepted before Node attempts to find either production SDK.
  symlinkSync(join(repoRoot, 'packages/pyric-admin'), join(nm, 'pyric-admin'));
  symlinkSync(join(repoRoot, 'packages/pyric'), join(nm, 'pyric'));
  writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({ name: 'register-fixture', type: 'commonjs' }));

  // Inactive production fixture: consumer-owned SDKs only. Importing the
  // register module with no activator must leave their resolution untouched.
  inactiveFixtureDir = mkdtempSync(join(tmpdir(), 'pyric-register-inactive-'));
  const inactiveNm = join(inactiveFixtureDir, 'node_modules');
  mkdirSync(inactiveNm);
  symlinkSync(join(repoRoot, 'node_modules/firebase-admin'), join(inactiveNm, 'firebase-admin'));
  symlinkSync(join(repoRoot, 'node_modules/firebase'), join(inactiveNm, 'firebase'));
  writeFileSync(
    join(inactiveFixtureDir, 'package.json'),
    JSON.stringify({ name: 'register-inactive-fixture', type: 'module' }),
  );

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
const clientApp = require('firebase/app').initializeApp({ projectId: 'cjs-demo' });
assert.strictEqual(clientApp[Symbol.for('pyric.app.target')], 'sandbox');
assert.strictEqual(clientApp.options.projectId, 'cjs-demo');
assert.strictEqual(typeof require('firebase/firestore').getFirestore(clientApp), 'object');
console.log('CJS_OK');
`,
  );

  // Canonical client fixture: unchanged Firebase imports must initialize the
  // process sandbox through the register-only app adapter, then thread that
  // app into another swapped client service.
  writeFileSync(
    join(fixtureDir, 'client.mjs'),
    `import assert from 'node:assert';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
const app = initializeApp({ apiKey: 'ignored', projectId: 'demo-project' });
assert.strictEqual(app[Symbol.for('pyric.app.target')], 'sandbox');
assert.strictEqual(app.options.projectId, 'demo-project');
const db = getFirestore(app);
assert.strictEqual(typeof db, 'object');
const ref = doc(db, 'package-resolution/firestore');
await setDoc(ref, { selected: 'sandbox' });
assert.strictEqual((await getDoc(ref)).data()?.selected, 'sandbox');
const auth = getAuth(app);
assert.strictEqual(getAuth(), auth, 'bare getAuth() must use the registered default sandbox app');
const credential = await signInAnonymously(auth);
assert.strictEqual(auth.currentUser, credential.user, 'canonical auth imports must update sandbox auth state');
console.log('CLIENT_OK');
`,
  );

  // Canonical AI seam: only Firebase imports, no Pyric helper import. The
  // zero-config scripted engine proves a real sandbox operation completed.
  writeFileSync(
    join(fixtureDir, 'ai-client.mjs'),
    `import assert from 'node:assert';
import { initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel } from 'firebase/ai';
const app = initializeApp({ apiKey: 'ignored', projectId: 'demo-ai-project' });
const ai = getAI(app);
assert.strictEqual(getAI(), ai, 'bare getAI() must use the registered default sandbox app');
const model = getGenerativeModel(ai, { model: 'gemini-flash-lite-latest' });
const result = await model.generateContent('hello');
assert.ok(result.response.candidates.length > 0, 'zero-config sandbox engine must answer');
console.log('AI_CLIENT_OK');
`,
  );

  // Inertness probe: reports whether the rewrite happened + factory presence.
  const probeSource = `const app = await import('firebase-admin/app');
const clientAppModule = await import('firebase/app');
const firestoreModule = await import('firebase/firestore');
const factory = globalThis[Symbol.for('pyric.remote.sandboxFactory')];
const clientApp = clientAppModule.initializeApp(
  { apiKey: 'ignored', projectId: 'register-inertness' },
  'register-inertness',
);
const clientDb = firestoreModule.getFirestore(clientApp);
console.log(JSON.stringify({
  rewritten: app.ADMIN_APP_TARGET === Symbol.for('pyric.admin.app.target'),
  clientRewritten: clientApp[Symbol.for('pyric.app.target')] === 'sandbox',
  firestoreRewritten: Object.getOwnPropertySymbols(clientDb)
    .some((symbol) => symbol.description === 'pyric/firestore/target'),
  factory: typeof factory,
}));
`;
  writeFileSync(join(fixtureDir, 'probe.mjs'), probeSource);
  writeFileSync(join(inactiveFixtureDir, 'probe.mjs'), probeSource);
});

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (inactiveFixtureDir) rmSync(inactiveFixtureDir, { recursive: true, force: true });
});

describe('@pyric/cli/register (child process)', () => {
  it('rewrites ESM imports and installs the factory global when PYRIC_SANDBOX is set', () => {
    expect(existsSync(join(fixtureDir, 'node_modules/firebase'))).toBe(false);
    expect(existsSync(join(fixtureDir, 'node_modules/firebase-admin'))).toBe(false);
    const res = runNode('main.mjs', { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000' });
    expect(res.stderr).toContain('@pyric/cli/register: active');
    expect(res.stdout).toContain('ESM_OK');
    expect(res.status).toBe(0);
  });

  it('initializes unchanged client Firebase service imports through the sandbox app adapter', () => {
    const res = runNode('client.mjs', { PYRIC_SANDBOX: 'local' });
    expect(res.stderr).toContain('@pyric/cli/register: active');
    expect(res.stdout).toContain('CLIENT_OK');
    expect(res.status).toBe(0);
  });

  it('executes canonical firebase/app + firebase/ai imports through the sandbox', () => {
    const res = runNode('ai-client.mjs', { PYRIC_SANDBOX: 'local' });
    expect(res.stderr).toContain('@pyric/cli/register: active');
    expect(res.stdout).toContain('AI_CLIENT_OK');
    expect(res.status).toBe(0);
  });

  it.skipIf(!hasRegisterHooks)('rewrites CJS require() via the sync hooks', () => {
    const res = runNode('main.cjs', { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000' });
    expect(res.stderr).toContain('@pyric/cli/register: active');
    expect(res.stdout).toContain('CJS_OK');
    expect(res.status).toBe(0);
  });

  it('is inert without PYRIC_SANDBOX — real firebase-admin, no factory, no log', () => {
    const res = runNode('probe.mjs', {}, inactiveFixtureDir);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      rewritten: false,
      clientRewritten: false,
      firestoreRewritten: false,
      factory: 'undefined',
    });
    expect(res.stderr).not.toContain('@pyric/cli/register');
  });

  it('refuses under NODE_ENV=production (logs, stays inert)', () => {
    const res = runNode('probe.mjs', {
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000',
      NODE_ENV: 'production',
    }, inactiveFixtureDir);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('refusing to activate under NODE_ENV=production');
    expect(JSON.parse(res.stdout)).toEqual({
      rewritten: false,
      clientRewritten: false,
      firestoreRewritten: false,
      factory: 'undefined',
    });
  });

  it('PYRIC_SANDBOX_FORCE=1 overrides the production refusal', () => {
    const res = runNode('probe.mjs', {
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000',
      NODE_ENV: 'production',
      PYRIC_SANDBOX_FORCE: '1',
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('@pyric/cli/register: active');
    expect(JSON.parse(res.stdout)).toEqual({
      rewritten: true,
      clientRewritten: true,
      firestoreRewritten: true,
      factory: 'function',
    });
  });
});
