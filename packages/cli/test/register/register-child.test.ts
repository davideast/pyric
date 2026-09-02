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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
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
let isolatedFixtureDir: string;

function runNode(
  script: string,
  env: Record<string, string | undefined>,
  cwd: string = fixtureDir,
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('node', ['--import', registerUrl, script], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: undefined,
      PYRIC_SANDBOX: undefined,
      PYRIC_SANDBOX_FORCE: undefined,
      PYRIC_GUARD: undefined,
      ...env,
    },
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Same launch, non-blocking. Required whenever this process must SERVE the
 *  child while it runs, as the beacon POST needs. */
function runNodeAsync(
  script: string,
  env: Record<string, string | undefined>,
  cwd: string = fixtureDir,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn('node', ['--import', registerUrl, script], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: undefined,
      PYRIC_SANDBOX: undefined,
      PYRIC_SANDBOX_FORCE: undefined,
      PYRIC_GUARD: undefined,
      ...env,
    } as NodeJS.ProcessEnv,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => { stdout += c; });
  child.stderr.on('data', (c: string) => { stderr += c; });
  return new Promise((resolve) => {
    child.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
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
  writeFileSync(join(fixtureDir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' } }));
  writeFileSync(
    join(fixtureDir, 'firestore.rules'),
    `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /package-resolution/{doc} { allow read, write: if true; }
    match /{document=**} { allow read, write: if false; }
  }
}`,
  );

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

  // Installed-CLI fixture: the user package intentionally has neither
  // firebase-admin nor pyric-admin in its own dependency tree. The register
  // hook must resolve its mapped target from @pyric/cli's installation.
  isolatedFixtureDir = mkdtempSync(join(tmpdir(), 'pyric-register-isolated-'));
  mkdirSync(join(isolatedFixtureDir, 'node_modules'));
  writeFileSync(
    join(isolatedFixtureDir, 'package.json'),
    JSON.stringify({ name: 'register-isolated-fixture', type: 'commonjs' }),
  );
  writeFileSync(
    join(isolatedFixtureDir, 'database.cjs'),
    `const assert = require('node:assert');
const database = require('firebase-admin/database');
assert.strictEqual(typeof database.getDatabaseWithUrl, 'function');
console.log('ISOLATED_DATABASE_OK');
`,
  );

  // ESM fixture: env is set, firebase-admin/app IS pyric-admin (its
  // ADMIN_APP_TARGET symbol is pyric-admin-only), and the factory global
  // mints the lazy branded handle synchronously.
  writeFileSync(
    join(fixtureDir, 'main.mjs'),
    `import assert from 'node:assert';
import { createServer } from 'node:net';
assert.ok(process.env.PYRIC_SANDBOX, 'PYRIC_SANDBOX must be set in the child');
const app = await import('firebase-admin/app');
assert.strictEqual(app.ADMIN_APP_TARGET, Symbol.for('pyric.admin.app.target'), 'firebase-admin/app must be pyric-admin/app');
const factory = globalThis[Symbol.for('pyric.remote.sandboxFactory')];
assert.strictEqual(typeof factory, 'function', 'sandbox factory global must be installed');
const server = createServer();
await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
const { port } = server.address();
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const handle = factory({ url: 'http://127.0.0.1:' + port });
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
assert.strictEqual(clientApp.name, '[DEFAULT]');
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
assert.strictEqual(app.name, '[DEFAULT]');
assert.strictEqual(app.options.projectId, 'demo-project');
const db = getFirestore(app);
assert.strictEqual(typeof db, 'object');
assert.strictEqual(db.app, app);
const ref = doc(db, 'package-resolution/firestore');
await setDoc(ref, { selected: 'sandbox' });
assert.strictEqual((await getDoc(ref)).data()?.selected, 'sandbox');
await assert.rejects(
  setDoc(doc(db, 'forbidden/write'), { should: 'deny' }),
  (error) => error?.code === 'permission-denied',
  'the Node register must apply firestore.rules from firebase.json',
);
const auth = getAuth(app);
assert.strictEqual(auth.app, app);
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
  firestoreRewritten: Object.getOwnPropertySymbols(clientDb)
    .some((symbol) => symbol.description === 'pyric/firestore/target'),
  factory: typeof factory,
}));
`;
  writeFileSync(join(fixtureDir, 'probe.mjs'), probeSource);
  writeFileSync(join(inactiveFixtureDir, 'probe.mjs'), probeSource);

  // Beacon fixture: touches nothing, just lingers long enough for the
  // fire-and-forget POST to land before the process exits.
  const beaconSource = `await new Promise((r) => setTimeout(r, 1200));
console.log('BEACON_FIXTURE_OK');
`;
  writeFileSync(join(fixtureDir, 'beacon.mjs'), beaconSource);
  writeFileSync(join(inactiveFixtureDir, 'beacon.mjs'), beaconSource);

  // A plain CJS entry point with NO Next.js anywhere in sight: the
  // entry-point-agnostic production refusal has to hold here too.
  writeFileSync(
    join(inactiveFixtureDir, 'plain.cjs'),
    `console.log('PLAIN_CJS_OK:' + (globalThis[Symbol.for('pyric.remote.sandboxFactory')] === undefined));
`,
  );
});

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (inactiveFixtureDir) rmSync(inactiveFixtureDir, { recursive: true, force: true });
  if (isolatedFixtureDir) rmSync(isolatedFixtureDir, { recursive: true, force: true });
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

  it.skipIf(!hasRegisterHooks)('resolves mapped packages from the installed CLI rather than the requiring package', () => {
    expect(existsSync(join(isolatedFixtureDir, 'node_modules/pyric-admin'))).toBe(false);
    expect(existsSync(join(isolatedFixtureDir, 'node_modules/firebase-admin'))).toBe(false);
    const res = runNode(
      'database.cjs',
      { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000' },
      isolatedFixtureDir,
    );
    expect(res).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('ISOLATED_DATABASE_OK'),
    });
  });

  it('is inert without PYRIC_SANDBOX — real firebase-admin, no factory, no log', () => {
    const res = runNode('probe.mjs', {}, inactiveFixtureDir);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      rewritten: false,
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
      firestoreRewritten: true,
      factory: 'function',
    });
  });

  /**
   * The NODE_ENV=production refusal is a property of the ACTIVATOR, not of any
   * entry point: it is gated on `PYRIC_SANDBOX` alone, so it holds for a bare
   * CJS script with no Next.js, no bundler and no framework config in the
   * picture. The passthrough is the single existing `PYRIC_SANDBOX_FORCE=1`
   * flag that `next/guard.ts:isProductionPassthrough` also reads. There is
   * deliberately no second override.
   */
  it('refuses NODE_ENV=production for a plain CJS entry point too (no Next anywhere)', () => {
    const res = runNode(
      'plain.cjs',
      { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000', NODE_ENV: 'production' },
      inactiveFixtureDir,
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('refusing to activate under NODE_ENV=production');
    expect(res.stderr).not.toContain('@pyric/cli/register: beacon');
    expect(res.stdout).toContain('PLAIN_CJS_OK:true');
  });

  it('honours PYRIC_SANDBOX_FORCE=1 for a plain CJS entry point', () => {
    const res = runNode(
      'plain.cjs',
      {
        PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000',
        NODE_ENV: 'production',
        PYRIC_SANDBOX_FORCE: '1',
        PYRIC_DEBUG: '1',
      },
      inactiveFixtureDir,
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('@pyric/cli/register: beacon ACTIVE');
    expect(res.stdout).toContain('PLAIN_CJS_OK:false');
  });
});

/**
 * The handshake beacon. Two channels: the POST to `/__pyric/beacon` whenever
 * the child env carries a bridge URL, and the structured stderr line when the
 * developer asked for detail. Both prove the same thing, that interception is
 * installed in THIS process, so the parent can observe it without guessing.
 */
describe('@pyric/cli/register beacon (child process)', () => {
  it('stays quiet on the default first run: the POST is the machine channel', () => {
    const res = runNode('beacon.mjs', { PYRIC_SANDBOX: 'local' });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('@pyric/cli/register: beacon');
  });

  it('writes one structured beacon line when PYRIC_GUARD is set explicitly', () => {
    const res = runNode('beacon.mjs', { PYRIC_SANDBOX: 'local', PYRIC_GUARD: 'block' });
    expect(res.status).toBe(0);
    const line = res.stderr.split('\n').find((l) => l.includes('@pyric/cli/register: beacon'));
    expect(line).toBeDefined();
    expect(line).toContain('beacon ACTIVE');
    expect(line).toMatch(/pid=\d+/);
    expect(line).toContain('guard=block');
    expect(line).toContain('hooks=1');
    // `local` carries no bridge URL, so the line says so rather than guessing.
    expect(line).toContain('bridge=none');
  });

  it('emits no beacon at all without the activator', () => {
    const res = runNode('beacon.mjs', {}, inactiveFixtureDir);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('@pyric/cli/register: beacon');
  });

  it('POSTs the report to /__pyric/beacon on the bridge from PYRIC_SANDBOX', async () => {
    const received: Array<{ url: string; method: string; body: string }> = [];
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { raw += c; });
      req.on('end', () => {
        received.push({ url: req.url ?? '', method: req.method ?? '', body: raw });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      // ASYNC spawn, deliberately: `spawnSync` would block this process's
      // event loop for the child's whole lifetime, so the listener above
      // could never accept the beacon it is here to receive.
      const res = await runNodeAsync('beacon.mjs', {
        PYRIC_SANDBOX: `remote:http://127.0.0.1:${port}`,
        PYRIC_GUARD: 'warn',
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('BEACON_FIXTURE_OK');
      expect(received).toHaveLength(1);
      expect(received[0]!.method).toBe('POST');
      expect(received[0]!.url).toBe('/__pyric/beacon');
      const report = JSON.parse(received[0]!.body) as {
        pid: number;
        guard: string;
        hooks: boolean;
      };
      expect(report.guard).toBe('warn');
      expect(report.hooks).toBe(true);
      expect(report.pid).toBeGreaterThan(0);
      // The stderr fallback carries the same facts, always.
      expect(res.stderr).toContain(`bridge=http://127.0.0.1:${port}/__pyric/beacon`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it('survives a bridge that refuses the beacon, and the child still runs', () => {
    // Port 1 is reliably not listening; the POST must fail silently.
    const res = runNode('beacon.mjs', {
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:1',
      PYRIC_DEBUG: '1',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('BEACON_FIXTURE_OK');
    expect(res.stderr).toContain('@pyric/cli/register: beacon ACTIVE');
  }, 30_000);
});
