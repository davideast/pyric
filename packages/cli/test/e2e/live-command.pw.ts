/**
 * The `pyric-live` command through real entry points: the bin `@pyric/live`
 * declares starts the Node host in live mode, a Node process under
 * `node --import @pyric/live/register` reports its calls to it, and the chip
 * in Chromium shows "Live: <project-id>", the billed-call count and the
 * process's rows as production's. The SDK points at a closed loopback port,
 * so nothing reaches a Firebase backend.
 *
 * When the app's Firebase config names another project than `.firebaserc`,
 * the host names the app's and warns in the terminal and the chip.
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

/**
 * The server code, as an app writes it: the client SDK pointed at a closed
 * port, its app config naming `projectId`. The listener's first delivery
 * comes from the SDK's cache, so it is a delivery the count includes.
 */
const serverSource = (projectId: string) => `
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDocFromCache, getFirestore, onSnapshot } from 'firebase/firestore';
const port = Number(process.env.CLOSED_PORT);
const app = initializeApp({ projectId: '${projectId}', apiKey: 'live-command-key', appId: '1:1:web:1' });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:' + port, { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', port);
const codes = {};
await getDocFromCache(doc(db, 'rooms/lobby')).catch((error) => { codes.firestore = error.code; });
await signInAnonymously(auth).catch((error) => { codes.auth = error.code; });
await new Promise((resolve) => { const stop = onSnapshot(doc(db, 'rooms/lobby'), () => { stop(); resolve(); }, resolve); });
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

/**
 * Waits until the host's output contains `text`. The host prints some lines
 * after it starts serving, so health answering does not mean they are there.
 */
async function waitForOutput(host: Started, text: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!host.output().includes(text)) {
    if (host.child.exitCode !== null) throw new Error(`the host exited before printing ${JSON.stringify(text)}:\n${host.output()}`);
    if (Date.now() > deadline) throw new Error(`the host did not print ${JSON.stringify(text)} within ${timeoutMs} ms:\n${host.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The `pyric-live` bin, as `@pyric/live`'s package.json declares it. */
function liveBin(root: string): string {
  const manifest = JSON.parse(readFileSync(join(liveDir, 'package.json'), 'utf8')) as { bin?: Record<string, string> };
  const bin = manifest.bin?.['pyric-live'];
  if (bin === undefined) throw new Error('@pyric/live declares no pyric-live bin');
  return join(root, 'node_modules/@pyric/live', bin);
}

/**
 * A project with @pyric/cli, @pyric/live and firebase installed, a Hosting
 * site, `.firebaserc` naming `rcProject`, and server code whose app config
 * names `appProject`.
 */
function project(roots: string[], rcProject = PROJECT_ID, appProject = PROJECT_ID): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-command-')));
  roots.push(root);
  mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
  symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
  symlinkSync(liveDir, join(root, 'node_modules/@pyric/live'));
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'live-command', private: true, type: 'module' }));
  writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: rcProject } }));
  writeFileSync(join(root, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, hosting: { public: 'public' } }));
  writeFileSync(join(root, 'firestore.rules'), "rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if false; } } }\n");
  writeFileSync(join(root, 'public/index.html'), PAGE);
  writeFileSync(join(root, 'server.mjs'), serverSource(appProject));
  return root;
}

/** One JSON-RPC request to the host's MCP route, keeping the session it opened. */
function mcpClient(base: string) {
  let sessionId: string | null = null;
  return async (id: number | null, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    if (id !== null) body.id = id;
    const response = await fetch(`${base}/__pyric/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    const text = await response.text();
    if (text.length === 0) return null;
    const line = text.split('\n').find((entry) => entry.startsWith('data:')) ?? text;
    return JSON.parse(line.replace(/^data:\s*/, '')) as Record<string, unknown>;
  };
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
    // The host prints how clients reach it after it starts serving.
    await waitForOutput(host, 'node --import @pyric/live/register server.js');
    expect(health.live).toEqual({
      projectId: PROJECT_ID,
      configProjectId: PROJECT_ID,
      configSource: '.firebaserc',
      appProjectIds: [],
      billed: { reads: 0, writes: 0, deliveries: 0 },
    });
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
    // The host's count: the listener's delivery; the failed read and the Auth call are not billed.
    await expect(chip.locator('[data-chip-billed]')).toHaveText('Billed calls: 0 reads, 0 writes, 1 document delivered to listeners');
    await expect(chip.locator('[data-chip-live-mismatch]')).toHaveCount(0);
    expect((await healthOf(url))?.live).toMatchObject({ appProjectIds: [PROJECT_ID], billed: { reads: 0, writes: 0, deliveries: 1 } });
    await chip.locator('[data-chip-tab=traffic]').click();
    await chip.locator('[data-traffic-scope=all]').click();
    const rows = chip.locator('[data-traffic-rows] [data-request-row]');
    for (const method of ['firestore.getDocFromCache', 'auth.signInAnonymously', 'firestore.onSnapshot']) {
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

  test("names the project the app's Firebase config names, and warns in the terminal and the chip when .firebaserc names another", async ({ page }) => {
    test.setTimeout(150_000);
    const root = project(roots, 'staging-demo', 'prod-demo');
    symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
    const port = await freeLoopbackPort();
    const url = `http://127.0.0.1:${port}`;
    const host = started('node', [liveBin(root), '--no-open', '--host', '127.0.0.1', '--port', String(port)], root, { HOME: root });
    hosts.push(host);
    await waitForHost(host, url);
    expect(host.output()).toContain('pyric-live: live mode for the Firebase project staging-demo.');

    const server = started('node', ['--import', '@pyric/live/register', 'server.mjs'], root, { HOME: root, CLOSED_PORT: String(await freeLoopbackPort()) });
    const finished = await server.exited;
    expect(finished.code, finished.output).toBe(0);

    const warning = 'Your Firebase config says prod-demo; .firebaserc says staging-demo.';
    expect(host.output()).toContain(`Live mode: your app's calls go to the Firebase project prod-demo, not staging-demo. ${warning}`);
    expect((await healthOf(url))?.live).toMatchObject({ projectId: 'prod-demo', configProjectId: 'staging-demo', appProjectIds: ['prod-demo'] });

    await page.goto(`${url}/`);
    const chip = await openChip(page);
    await expect(chip.locator('[data-expand] [data-chip-live]')).toHaveText('Live: prod-demo');
    await chip.locator('[data-expand]').click();
    await expect(chip.locator('.panel-header [data-chip-live]')).toHaveText('Live: prod-demo');
    await expect(chip.locator('[data-chip-live-mismatch]')).toHaveText(warning);
  });

  test('refuses a seed file: a live host makes none of pyric\'s own writes', async () => {
    const root = project(roots);
    symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
    writeFileSync(join(root, 'seed.json'), JSON.stringify({ 'rooms/lobby': { name: 'Lobby' } }));
    const run = started('node', [liveBin(root), '--no-open', '--seed', 'seed.json', '--port', String(await freeLoopbackPort())], root, { HOME: root });
    hosts.push(run);
    const finished = await run.exited;
    expect(finished.code, finished.output).not.toBe(0);
    expect(finished.output).toContain('@pyric/live: seed seed.json from the seed file is refused in live mode.');
  });

  test("refuses pyric's own writes on the running host: an MCP tool's and a pyric command's", async () => {
    test.setTimeout(120_000);
    const root = project(roots);
    symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
    const port = await freeLoopbackPort();
    const url = `http://127.0.0.1:${port}`;
    const host = started('node', [liveBin(root), '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)], root, { HOME: root });
    hosts.push(host);
    const health = await waitForHost(host, url) as { instanceId: string };

    const mcp = mcpClient(url);
    await mcp(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-command', version: '0' } });
    await mcp(null, 'notifications/initialized');
    const call = await mcp(2, 'tools/call', { name: 'firestore_create_document', arguments: { path: 'rooms/agent', data: { v: 1 } } });
    expect(JSON.stringify(call)).toContain('firestore_create_document from an MCP tool is refused in live mode');

    const method = await fetch(`${url}/__pyric/hosted/method`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: health.instanceId, projectDir: root, key: 'firestore.setDoc', args: { path: 'rooms/cli', data: { v: 1 } } }),
    });
    const result = await method.json() as { ok: boolean; summary: string; data?: { code?: string } };
    expect(result.ok).toBe(false);
    expect(result.data?.code).toBe('PYRIC_LIVE_REFUSED');
    expect(result.summary).toContain('firestore.setDoc from a pyric command is refused in live mode');
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
