/**
 * Child-process integration for `@pyric/cli/register` handshake beacon and
 * `PYRIC_SANDBOX=local` multi-service rules loading (#1120).
 *
 * Requires the packages to be BUILT (`bun run build`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closedPort } from '../closed-port.js';

const toolsRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(toolsRoot, '../..');
const registerDist = join(toolsRoot, 'dist/register/index.js');
const registerUrl = pathToFileURL(registerDist).href;

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

/**
 * Same launch, non-blocking. Required whenever this process must SERVE the
 * child while it runs, as the beacon POST needs.
 */
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
      ...env,
    } as NodeJS.ProcessEnv,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolveRun) => {
    child.once('exit', (status) => resolveRun({ status, stdout, stderr }));
  });
}

beforeAll(() => {
  if (!existsSync(registerDist)) {
    throw new Error(`dist/register/index.js missing -- run \`bun run build\` first (${registerDist})`);
  }
  execFileSync('node', ['--version']);

  fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-register-beacon-'));
  mkdirSync(join(fixtureDir, 'node_modules'));
  writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({ name: 'register-beacon-fixture', type: 'module' }));

  inactiveFixtureDir = mkdtempSync(join(tmpdir(), 'pyric-register-beacon-inactive-'));
  mkdirSync(join(inactiveFixtureDir, 'node_modules'));
  writeFileSync(
    join(inactiveFixtureDir, 'package.json'),
    JSON.stringify({ name: 'register-beacon-inactive-fixture', type: 'module' }),
  );

  const beaconSource = `await new Promise((r) => setTimeout(r, 1200));
console.log('BEACON_FIXTURE_OK');
`;
  writeFileSync(join(fixtureDir, 'beacon.mjs'), beaconSource);
  writeFileSync(join(inactiveFixtureDir, 'beacon.mjs'), beaconSource);
});

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (inactiveFixtureDir) rmSync(inactiveFixtureDir, { recursive: true, force: true });
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

  it('writes one structured beacon line when PYRIC_DEBUG is set explicitly', () => {
    const res = runNode('beacon.mjs', { PYRIC_SANDBOX: 'local', PYRIC_DEBUG: '1' });
    expect(res.status).toBe(0);
    const line = res.stderr.split('\n').find((l) => l.includes('@pyric/cli/register: beacon'));
    expect(line).toBeDefined();
    expect(line).toContain('beacon ACTIVE');
    expect(line).toMatch(/pid=\d+/);
    expect(line).not.toContain('guard=');
    expect(line).toContain('hooks=1');
    // `local` carries no bridge URL, so the line says so rather than guessing.
    expect(line).toContain('bridge=none');
  });

  it('prints a deprecation notice and succeeds when legacy PYRIC_GUARD is set', () => {
    const res = runNode('beacon.mjs', { PYRIC_SANDBOX: 'local', PYRIC_GUARD: 'warn' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('BEACON_FIXTURE_OK');
    expect(res.stderr).toContain('PYRIC_GUARD is deprecated');
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
      req.on('data', (chunk: string) => { raw += chunk; });
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
        PYRIC_DEBUG: '1',
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('BEACON_FIXTURE_OK');
      expect(received).toHaveLength(1);
      const firstReceived = received[0];
      expect(firstReceived?.method).toBe('POST');
      expect(firstReceived?.url).toBe('/__pyric/beacon');
      const report = JSON.parse(firstReceived?.body ?? '{}') as {
        pid: number;
        hooks: boolean;
        sandbox: string;
      };
      expect('guard' in report).toBe(false);
      expect(report.hooks).toBe(true);
      expect(report.pid).toBeGreaterThan(0);
      // The stderr fallback carries the same facts, always.
      expect(res.stderr).toContain(`bridge=http://127.0.0.1:${port}/__pyric/beacon`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it('survives a bridge that refuses the beacon, and the child still runs', async () => {
    // Nothing listens on a freed port; the POST must fail silently.
    const port = await closedPort();
    const res = runNode('beacon.mjs', {
      PYRIC_SANDBOX: `remote:http://127.0.0.1:${port}`,
      PYRIC_DEBUG: '1',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('BEACON_FIXTURE_OK');
    expect(res.stderr).toContain('@pyric/cli/register: beacon ACTIVE');
  }, 30_000);
});

/**
 * #1120: `PYRIC_SANDBOX=local` runs the client SDKs in process. The project's
 * `firebase.json` rules govern them as they govern the dev server: Firestore,
 * each Realtime Database instance (named and deploy-target entries), and
 * Storage. Before the fix only `firestore.rules` loaded, so every RTDB and
 * Storage call was denied by the default policy.
 */
describe('@pyric/cli/register local rules (child process)', () => {
  let rulesFixtureDir: string;

  beforeAll(() => {
    rulesFixtureDir = mkdtempSync(join(tmpdir(), 'pyric-register-rules-'));
    const nm = join(rulesFixtureDir, 'node_modules');
    mkdirSync(nm);
    symlinkSync(join(repoRoot, 'packages/pyric-admin'), join(nm, 'pyric-admin'));
    symlinkSync(join(repoRoot, 'packages/pyric'), join(nm, 'pyric'));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'register-rules-fixture', type: 'module' }),
      'firebase.json': JSON.stringify({
        firestore: { rules: 'firestore.rules' },
        database: [
          { instance: 'rules-demo-default-rtdb', rules: 'database.rules.json' },
          { target: 'chat', rules: 'chat.rules.json' },
        ],
        storage: { rules: 'storage.rules' },
      }),
      '.firebaserc': JSON.stringify({
        projects: { default: 'rules-demo' },
        targets: { 'rules-demo': { database: { chat: ['rules-demo-chat'] } } },
      }),
      'firestore.rules': `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /open/{doc} { allow read, write: if true; }
  }
}`,
      'database.rules.json': JSON.stringify({ rules: { open: { '.read': true, '.write': true } } }),
      'chat.rules.json': JSON.stringify({ rules: { rooms: { '.read': true, '.write': true } } }),
      'storage.rules': `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /public/{file} { allow read, write: if true; }
  }
}`,
      'rules.mjs': `import assert from 'node:assert';
import { initializeApp } from 'firebase/app';
import { doc, getFirestore, setDoc } from 'firebase/firestore';
import { getDatabase, ref, set } from 'firebase/database';
import { getStorage, ref as storageRef, uploadString } from 'firebase/storage';
const app = initializeApp({ apiKey: 'ignored', projectId: 'rules-demo', storageBucket: 'rules-demo.appspot.com' });
const denied = (code) => (error) => error?.code === code;
const failures = [];
async function check(service, run) {
  try {
    await run();
  } catch (error) {
    failures.push(service + ': ' + (error?.message ?? String(error)));
  }
}

const db = getFirestore(app);
await check('firestore', async () => {
  await setDoc(doc(db, 'open/a'), { ok: true });
  await assert.rejects(setDoc(doc(db, 'closed/a'), { ok: false }), denied('permission-denied'));
});

const rtdb = getDatabase(app);
await check('rtdb default instance', async () => {
  await set(ref(rtdb, 'open/a'), 'default instance allows open/');
  await assert.rejects(set(ref(rtdb, 'rooms/a'), 'no rule'), denied('PERMISSION_DENIED'));
});

const chat = getDatabase(app, 'https://rules-demo-chat.firebaseio.com');
await check('rtdb chat target', async () => {
  await set(ref(chat, 'rooms/a'), 'chat target allows rooms/');
  await assert.rejects(set(ref(chat, 'open/a'), 'no rule'), denied('PERMISSION_DENIED'));
});

const storage = getStorage(app);
await check('storage', async () => {
  await uploadString(storageRef(storage, 'public/a.txt'), 'hello');
  await assert.rejects(uploadString(storageRef(storage, 'private/a.txt'), 'no rule'), denied('storage/unauthorized'));
});

console.log(failures.length === 0 ? 'LOCAL_RULES_OK' : 'LOCAL_RULES_FAILED\\n' + failures.join('\\n'));
process.exit(0);
`,
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(rulesFixtureDir, name), content);
  });

  afterAll(() => {
    if (rulesFixtureDir) rmSync(rulesFixtureDir, { recursive: true, force: true });
  });

  it('applies every rules file firebase.json declares to the in-process client SDKs', () => {
    const res = runNode('rules.mjs', { PYRIC_SANDBOX: 'local' }, rulesFixtureDir);
    expect(res.stderr).not.toContain('could not load');
    expect(res).toMatchObject({ status: 0, stdout: expect.stringContaining('LOCAL_RULES_OK') });
  });
});
