/**
 * Child-process integration for `@pyric/cli/register`: real `node --import`
 * runs against fixture scripts in a temp project whose node_modules symlinks
 * the workspace's built pyric packages (plus the real firebase/firebase-admin
 * for the inertness check). No browser, no server -- resolution + activation
 * gating only. Beacon and local-rules child suites live in
 * `register-child-beacon-and-rules.test.ts`.
 *
 * Requires the packages to be BUILT (`bun run build`) -- the child loads
 * dist/register/index.js and the pyric mirrors' dist output.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { blackholedPort } from '../blackholed-port.js';
import { closedPort } from '../closed-port.js';

const toolsRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(toolsRoot, '../..');
const registerDist = join(toolsRoot, 'dist/register/index.js');
const registerUrl = pathToFileURL(registerDist).href;
const activationUrl = pathToFileURL(join(toolsRoot, 'dist/register/activation.js')).href;

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
      ...env,
    },
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

beforeAll(() => {
  if (!existsSync(registerDist)) {
    throw new Error(`dist/register/index.js missing -- run \`bun run build\` first (${registerDist})`);
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
await new Promise((resolveListen, reject) => server.listen(0, '127.0.0.1', resolveListen).once('error', reject));
const { port } = server.address();
await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
const handle = factory({ url: 'http://127.0.0.1:' + port });
assert.strictEqual(handle[Symbol.for('pyric.remote.sandbox')], true, 'factory must return the branded handle');
assert.strictEqual(typeof handle.channel.op, 'function');
handle.close();
console.log('ESM_OK');
`,
  );

  // Stale-url fixture: the factory takes the PYRIC_SANDBOX url as a setting
  // that may be stale. Nothing answers there and this project runs no host,
  // so the first connect names the url as stale.
  writeFileSync(
    join(fixtureDir, 'stale.mjs'),
    `import assert from 'node:assert';
const factory = globalThis[Symbol.for('pyric.remote.sandboxFactory')];
const url = process.env.PYRIC_SANDBOX.slice('remote:'.length);
const handle = factory({ url });
await assert.rejects(handle.ready, (error) => {
  assert.strictEqual(error.code, 'not-found');
  assert.ok(error.message.includes('PYRIC_SANDBOX=remote:' + url + ' is stale'), error.message);
  assert.ok(error.message.includes('Set PYRIC_SANDBOX=remote'), error.message);
  return true;
});
handle.close();
console.log('STALE_OK');
`,
  );

  // CJS fixture: require() interception (sync hooks + the ESM-only exports
  // fallback -> require(esm)).
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
// Under a remote activation firebase/firestore is the Node host client (#1082):
// its handle is the hosted client's, and making it opens no connection.
assert.strictEqual(require('firebase/firestore').getFirestore(clientApp).__kind, 'client-db');
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
import { CustomProvider, initializeAppCheck } from 'firebase/app-check';
const app = initializeApp({ apiKey: 'ignored', projectId: 'demo-ai-project', appId: '1:100000000000:web:demoaiproject' });
// The sandbox refuses AI Logic requests without an App Check token, so App
// Check comes before getAI. Node has no document for reCAPTCHA, so the debug
// token stands in for the provider.
globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
initializeAppCheck(app, { provider: new CustomProvider({ getToken: async () => { throw new Error('not called'); } }) });
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
// Under a remote activation firebase/firestore is the Node host client
// (#1082), whose handle is the hosted client's; otherwise the pyric mirror's
// handle carries its target symbol, and the real SDK's carries neither.
function isFirestoreRewritten() {
  const db = firestoreModule.getFirestore(clientApp);
  const isNodeHostClient = db.__kind === 'client-db';
  if (isNodeHostClient) return true;
  return Object.getOwnPropertySymbols(db)
    .some((symbol) => symbol.description === 'pyric/firestore/target');
}
console.log(JSON.stringify({
  rewritten: app.ADMIN_APP_TARGET === Symbol.for('pyric.admin.app.target'),
  firestoreRewritten: isFirestoreRewritten(),
  factory: typeof factory,
}));
`;
  writeFileSync(join(fixtureDir, 'probe.mjs'), probeSource);
  writeFileSync(join(inactiveFixtureDir, 'probe.mjs'), probeSource);

  // Activation-mark probe (#1654): reads `isRegisterActive()` and `active`.
  const markProbeSource = `import { isRegisterActive } from ${JSON.stringify(activationUrl)};
import { active } from ${JSON.stringify(registerUrl)};
console.log(JSON.stringify({ marked: isRegisterActive(), active }));
`;
  writeFileSync(join(fixtureDir, 'mark.mjs'), markProbeSource);
  writeFileSync(join(inactiveFixtureDir, 'mark.mjs'), markProbeSource);

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

  it('sets the activation mark under PYRIC_SANDBOX and leaves it absent under NODE_ENV=production or with PYRIC_SANDBOX unset (#1654)', () => {
    const activeRes = runNode('mark.mjs', { PYRIC_SANDBOX: 'local' });
    expect(activeRes.status, activeRes.stderr).toBe(0);
    expect(JSON.parse(activeRes.stdout)).toEqual({ marked: true, active: true });

    const refusedRes = runNode(
      'mark.mjs',
      { PYRIC_SANDBOX: 'local', NODE_ENV: 'production' },
      inactiveFixtureDir,
    );
    expect(refusedRes.status, refusedRes.stderr).toBe(0);
    expect(refusedRes.stderr).toContain('refusing to activate under NODE_ENV=production');
    expect(JSON.parse(refusedRes.stdout)).toEqual({ marked: false, active: false });

    const unsetRes = runNode('mark.mjs', {}, inactiveFixtureDir);
    expect(unsetRes.status, unsetRes.stderr).toBe(0);
    expect(JSON.parse(unsetRes.stdout)).toEqual({ marked: false, active: false });

    const forcedRes = runNode('mark.mjs', {
      PYRIC_SANDBOX: 'local',
      NODE_ENV: 'production',
      PYRIC_SANDBOX_FORCE: '1',
    });
    expect(forcedRes.status, forcedRes.stderr).toBe(0);
    expect(JSON.parse(forcedRes.stdout)).toEqual({ marked: true, active: true });
  });

  it('reports a stale PYRIC_SANDBOX url when nothing answers and the project runs no host', async () => {
    const port = await closedPort();
    const res = runNode('stale.mjs', { PYRIC_SANDBOX: `remote:http://127.0.0.1:${port}` });
    expect(res.stdout).toContain('STALE_OK');
    expect(res.status).toBe(0);
  });

  it('exits promptly when the project pointer names a port whose connect never completes', async () => {
    // #1162: the discovery probe of the pointer's port must close its socket
    // at the deadline, or the pending connect holds the child open about 10 s.
    const hole = await blackholedPort();
    const projectDir = join(fixtureDir, 'blackholed-project');
    try {
      mkdirSync(join(projectDir, '.pyric'), { recursive: true });
      writeFileSync(
        join(projectDir, '.pyric', 'serve.json'),
        JSON.stringify({ port: hole.port, url: `http://localhost:${hole.port}`, instanceId: 'blackholed-host' }),
      );
      const stalePort = await closedPort();
      const started = performance.now();
      const res = runNode('../stale.mjs', { PYRIC_SANDBOX: `remote:http://127.0.0.1:${stalePort}` }, projectDir);
      const exitMs = performance.now() - started;
      expect(res.stdout).toContain('STALE_OK');
      expect(res.status).toBe(0);
      expect(exitMs).toBeLessThan(5_000);
    } finally {
      hole.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

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

  it('rewrites CJS require() via the sync hooks', () => {
    const res = runNode('main.cjs', { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000' });
    expect(res.stderr).toContain('@pyric/cli/register: active');
    expect(res.stdout, res.stderr).toContain('CJS_OK');
    expect(res.status).toBe(0);
  });

  it('resolves mapped packages from the installed CLI rather than the requiring package', () => {
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

  it('is inert without PYRIC_SANDBOX -- real firebase-admin, no factory, no log', () => {
    const res = runNode('probe.mjs', {}, inactiveFixtureDir);
    expect(res.status, res.stderr).toBe(0);
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
 * #1443: Next 16's Turbopack keeps `firebase-admin` external but links it as
 * `.next/node_modules/firebase-admin-<16 hex>` and imports
 * `firebase-admin-<hash>/app`. The register maps the renamed import once it
 * resolves into the real package, and leaves a package that merely has such a
 * name alone.
 */
describe('@pyric/cli/register renamed imports (child process)', () => {
  let renamedFixtureDir: string;
  const ADMIN = 'firebase-admin-0123456789abcdef';
  const CLIENT = 'firebase-1111222233334444';
  const DECOY = 'firebase-fedcba9876543210';

  beforeAll(() => {
    renamedFixtureDir = mkdtempSync(join(tmpdir(), 'pyric-register-renamed-'));
    const nm = join(renamedFixtureDir, 'node_modules');
    mkdirSync(join(nm, DECOY), { recursive: true });
    symlinkSync(join(repoRoot, 'node_modules/firebase-admin'), join(nm, ADMIN));
    symlinkSync(join(repoRoot, 'node_modules/firebase'), join(nm, CLIENT));
    writeFileSync(join(nm, DECOY, 'package.json'), JSON.stringify({ name: 'decoy', main: 'index.js' }));
    writeFileSync(join(nm, DECOY, 'index.js'), 'module.exports = { decoy: true };\n');
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'register-renamed-fixture', type: 'commonjs' }),
      'renamed.mjs': `import assert from 'node:assert';
const admin = await import('${ADMIN}/app');
assert.strictEqual(admin.ADMIN_APP_TARGET, Symbol.for('pyric.admin.app.target'), '${ADMIN}/app must be pyric-admin/app');
const firestore = await import('${ADMIN}/firestore');
assert.strictEqual(typeof firestore.getFirestore, 'function');
const { initializeApp } = await import('${CLIENT}/app');
const { getFirestore } = await import('${CLIENT}/firestore');
const clientApp = initializeApp({ projectId: 'renamed-demo' });
assert.strictEqual(getFirestore(clientApp).__kind, 'client-db', '${CLIENT}/firestore must be the Node host client');
const decoy = await import('${DECOY}');
assert.strictEqual(decoy.default.decoy, true, 'a package that is only named like firebase stays itself');
console.log('RENAMED_ESM_OK');
`,
      'renamed.cjs': `const assert = require('node:assert');
const admin = require('${ADMIN}/app');
assert.strictEqual(admin.ADMIN_APP_TARGET, Symbol.for('pyric.admin.app.target'), 'require(${ADMIN}/app) must be pyric-admin/app');
const { initializeApp } = require('${CLIENT}/app');
const { getFirestore } = require('${CLIENT}/firestore');
assert.strictEqual(getFirestore(initializeApp({ projectId: 'renamed-cjs' })).__kind, 'client-db');
assert.strictEqual(require('${DECOY}').decoy, true, 'a package that is only named like firebase stays itself');
console.log('RENAMED_CJS_OK');
`,
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(renamedFixtureDir, name), content);
  });

  afterAll(() => {
    if (renamedFixtureDir) rmSync(renamedFixtureDir, { recursive: true, force: true });
  });

  it('maps renamed firebase-admin and firebase imports to the sandbox, and leaves a decoy alone', () => {
    const res = runNode('renamed.mjs', { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000' }, renamedFixtureDir);
    expect(res.stderr).toContain('@pyric/cli/register: active');
    expect(res.stdout, res.stderr).toContain('RENAMED_ESM_OK');
    expect(res.status).toBe(0);
  });

  it('maps renamed require() calls the same way', () => {
    const res = runNode('renamed.cjs', { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000' }, renamedFixtureDir);
    expect(res.stdout, res.stderr).toContain('RENAMED_CJS_OK');
    expect(res.status).toBe(0);
  });
});
