/**
 * The `pyric-live` command through real entry points: the bin `@pyric/live`
 * declares starts the Node host in live mode, a Node process under
 * `node --import @pyric/live/register` reports its calls to it, and the chip
 * in Chromium shows "Live: <project-id>", the billed-call count and the
 * process's rows as production's. The SDK points at a closed loopback port,
 * so nothing reaches a Firebase backend.
 *
 * Also: each start check refuses the command with its reason, the register
 * says when no host is reachable, and `pyric sandbox --hosted` with every
 * flag, config key and environment variable a developer might try stays a
 * sandbox host.
 *
 * Every process runs under the `node` on PATH. The `test/apps/` scenario
 * drives the same path through the packed packages.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const cliDir = fileURLToPath(new URL('../../', import.meta.url));
const liveDir = fileURLToPath(new URL('../../../live/', import.meta.url));
const require = createRequire(import.meta.url);
const firebaseDir = realpathSync(dirname(require.resolve('firebase/package.json')));
const PROJECT_ID = 'live-command-demo';

async function freeLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  return address.port;
}

/** The server code, as an app writes it: the client SDK pointed at a closed port. */
const SERVER_SOURCE = `
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDocFromCache, getFirestore } from 'firebase/firestore';
const port = Number(process.env.CLOSED_PORT);
const app = initializeApp({ projectId: '${PROJECT_ID}', apiKey: 'live-command-key', appId: '1:1:web:1' });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:' + port, { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', port);
const codes = {};
await getDocFromCache(doc(db, 'rooms/lobby')).catch((error) => { codes.firestore = error.code; });
await signInAnonymously(auth).catch((error) => { codes.auth = error.code; });
console.log('RESULT ' + JSON.stringify({ codes }));
`;

/** A Hosting page that imports the SDK, as a static site does. */
const PAGE = `<!doctype html><html><body><p id="status">loading</p>
<script type="module">
import('firebase/firestore').then(() => 'loaded', (error) => error.message).then((text) => { document.querySelector('#status').textContent = text; });
</script></body></html>`;

interface Started {
  child: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; output: string }>;
}

function started(command: string, args: string[], cwd: string, env: Record<string, string>): Started {
  const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? '', ...env } });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<{ code: number | null; output: string }>((resolve) => child.once('exit', (code) => resolve({ code, output })));
  return { child, output: () => output, exited };
}

async function healthOf(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${url}/__pyric/health`);
    return response.ok ? (await response.json()) as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function waitForHost(host: Started, url: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const health = await healthOf(url);
    if (health !== null) return health;
    if (host.child.exitCode !== null) throw new Error(`the host exited:\n${host.output()}`);
    if (Date.now() > deadline) throw new Error(`the host did not serve ${url}:\n${host.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The `pyric-live` bin, as `@pyric/live`'s package.json declares it. */
function liveBin(root: string): string {
  const manifest = JSON.parse(readFileSync(join(liveDir, 'package.json'), 'utf8')) as { bin?: Record<string, string> };
  const bin = manifest.bin?.['pyric-live'];
  if (bin === undefined) throw new Error('@pyric/live declares no pyric-live bin');
  return join(root, 'node_modules/@pyric/live', bin);
}

/** A project with @pyric/cli, @pyric/live and firebase installed, a Hosting site and a Firebase project. */
function project(roots: string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-command-')));
  roots.push(root);
  mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
  symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
  symlinkSync(liveDir, join(root, 'node_modules/@pyric/live'));
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'live-command', private: true, type: 'module' }));
  writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
  writeFileSync(join(root, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, hosting: { public: 'public' } }));
  writeFileSync(join(root, 'firestore.rules'), "rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if false; } } }\n");
  writeFileSync(join(root, 'public/index.html'), PAGE);
  writeFileSync(join(root, 'server.mjs'), SERVER_SOURCE);
  return root;
}

async function openChip(page: Page): Promise<ReturnType<Page['locator']>> {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  return chip;
}

test.describe('pyric-live', () => {
  const roots: string[] = [];
  const hosts: Started[] = [];
  test.afterEach(async () => {
    for (const host of hosts.splice(0)) {
      host.child.kill('SIGTERM');
      await host.exited;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('starts the Node host in live mode, and the chip shows the project, the count and a Node process as production', async ({ page }) => {
    test.setTimeout(150_000);
    const root = project(roots);
    symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-command-home-')));
    roots.push(home);
    const port = await freeLoopbackPort();
    const url = `http://127.0.0.1:${port}`;
    const host = started('node', [liveBin(root), '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)], root, { HOME: home });
    hosts.push(host);
    const health = await waitForHost(host, url);
    expect(health.live).toEqual({ projectId: PROJECT_ID });
    expect(host.output()).toContain(`pyric-live: live mode for the Firebase project ${PROJECT_ID}.`);
    expect(host.output()).toContain(`The chip and Studio show "Live: ${PROJECT_ID}" while it runs.`);
    expect(host.output()).toContain('node --import @pyric/live/register server.js');
    expect(host.output()).not.toContain('export PYRIC_SANDBOX=remote');

    // The server process, as a developer starts it: the host found from the project.
    const server = started('node', ['--import', '@pyric/live/register', 'server.mjs'], root, { HOME: home, CLOSED_PORT: String(await freeLoopbackPort()) });
    const finished = await server.exited;
    expect(finished.code, finished.output).toBe(0);
    expect(finished.output).toContain(`@pyric/live/register: live mode for the Firebase project ${PROJECT_ID}.`);
    expect(finished.output).toContain(`@pyric/live/register: reporting calls to the live host at`);
    expect(finished.output).toContain('RESULT {"codes":{"firestore":"unavailable","auth":"auth/network-request-failed"}}');

    // A Hosting page on the live host gets no Firebase SDK.
    await page.goto(`${url}/`);
    await expect(page.locator('#status')).toContainText('firebase/firestore is not served to pages of the pyric-live host');

    const chip = await openChip(page);
    await expect(chip.locator('[data-expand] [data-chip-live]')).toHaveText(`Live: ${PROJECT_ID}`);
    await chip.locator('[data-expand]').click();
    await expect(chip.locator('.panel-header [data-chip-live]')).toHaveText(`Live: ${PROJECT_ID}`);
    await expect(chip.locator('[data-chip-billed]')).toHaveText('Billed calls: 0 reads, 0 writes, 0 listener deliveries');
    await chip.locator('[data-chip-tab=traffic]').click();
    await chip.locator('[data-traffic-scope=all]').click();
    const rows = chip.locator('[data-traffic-rows] [data-request-row]');
    for (const method of ['firestore.getDocFromCache', 'auth.signInAnonymously']) {
      const row = rows.filter({ hasText: method });
      await expect(row).toHaveCount(1);
      await expect(row.locator('[data-traffic-row-production]')).toHaveText('Production');
      await expect(row.locator('[data-traffic-row-source]')).toHaveText('Server (client SDK)');
    }

    // With the host stopped, the register says no host is reachable and how to start one.
    host.child.kill('SIGTERM');
    await host.exited;
    const alone = started('node', ['--import', '@pyric/live/register', 'server.mjs'], root, { HOME: home, CLOSED_PORT: String(await freeLoopbackPort()) });
    const aloneFinished = await alone.exited;
    expect(aloneFinished.code, aloneFinished.output).toBe(0);
    expect(aloneFinished.output).toContain("@pyric/live/register: no host is reachable, so this process's calls are not shown in the chip or Studio.");
    expect(aloneFinished.output).toContain(`Start one in ${root} with npx pyric-live, or vite dev with pyricLive() from @pyric/live/vite.`);
  });

  test('refuses to start with an unsupported firebase, naming the version found', async () => {
    const root = project(roots);
    mkdirSync(join(root, 'node_modules/firebase'));
    writeFileSync(join(root, 'node_modules/firebase/package.json'), JSON.stringify({ name: 'firebase', version: '11.10.0' }));
    const run = started('node', [liveBin(root), '--no-open'], root, { HOME: root });
    const finished = await run.exited;
    expect(finished.code).toBe(1);
    expect(finished.output).toContain('pyric-live: Live mode did not start. @pyric/live needs firebase ^12.12.0. This project has firebase 11.10.0 installed.');
  });

  test('refuses to start with two copies of @firebase/app, naming the path of each', async () => {
    const root = project(roots);
    symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
    const extra = join(root, 'node_modules/some-wrapper/node_modules/@firebase/app');
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, 'package.json'), JSON.stringify({ name: '@firebase/app', version: '0.13.0' }));
    const run = started('node', [liveBin(root), '--no-open'], root, { HOME: root });
    const finished = await run.exited;
    expect(finished.code).toBe(1);
    expect(finished.output).toMatch(/This project has \d+ copies of @firebase\/app installed:/);
    expect(finished.output).toContain(extra);
  });
});

test('pyric sandbox --hosted stays a sandbox host with @pyric/live installed and every live flag, config key and variable a developer might try', async ({ page }) => {
  test.setTimeout(120_000);
  const roots: string[] = [];
  let host: Started | undefined;
  try {
    const root = project(roots);
    symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
    writeFileSync(join(root, 'pyric.json'), JSON.stringify({ live: true, mode: 'live' }));
    const port = await freeLoopbackPort();
    const url = `http://127.0.0.1:${port}`;
    host = started('node', [join(cliDir, 'dist/cli/index.js'), 'sandbox', '--hosted', '--live', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)], root, {
      HOME: root, PYRIC_LIVE: '1', PYRIC_MODE: 'live', PYRIC_LIVE_PROJECT_ROOT: root,
    });
    const health = await waitForHost(host, url);
    expect(health.live).toBeUndefined();
    expect(host.output()).not.toContain('live mode');
    // The page gets the sandbox SDK, so the chip names no live project.
    await page.goto(`${url}/`);
    await expect(page.locator('#status')).toHaveText('loaded');
    const chip = await openChip(page);
    await expect(chip.locator('[data-expand]')).toHaveText('pyric');
    await expect(chip.locator('[data-chip-live]')).toHaveCount(0);
  } finally {
    await page.close();
    host?.child.kill('SIGTERM');
    await host?.exited;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
