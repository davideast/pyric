/**
 * Live mode's Node plane through real entry points: `pyric sandbox --hosted`
 * serves a page, and a Node process started with
 * `node --import @pyric/live/register` imports `firebase/*` as a server does.
 * It gets the installed SDK wrapped by `@pyric/live`'s rows, finds the host
 * from the project's `.pyric/serve.json`, and each Firestore and Auth call's
 * outcome shows in the page's chip as a production row from a server
 * process. The SDK points at a closed loopback port, so nothing reaches a
 * Firebase backend. Every other Firebase import, and `firebase-admin`, is
 * refused.
 *
 * Both processes run under the `node` on PATH. The plan's replay-server
 * scenario under `test/apps/` drives the same path through the packed
 * packages and the `pyric-live` command.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const cliDir = fileURLToPath(new URL('../../', import.meta.url));
const liveDir = fileURLToPath(new URL('../../../live/', import.meta.url));
const require = createRequire(import.meta.url);
const firebaseDir = realpathSync(dirname(require.resolve('firebase/package.json')));

async function freeLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  return address.port;
}

/** The server code, as an app writes it: the client SDK pointed at a closed port, then two refused imports. */
const SERVER_SOURCE = `
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDocFromCache, getFirestore } from 'firebase/firestore';
const port = Number(process.env.CLOSED_PORT);
const app = initializeApp({ projectId: 'live-node-plane', apiKey: 'live-node-plane-key', appId: '1:1:web:1' });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:' + port, { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', port);
const codes = {};
await getDocFromCache(doc(db, 'rooms/lobby')).catch((error) => { codes.firestore = error.code; });
await signInAnonymously(auth).catch((error) => { codes.auth = error.code; });
const refused = {};
for (const specifier of ['firebase/functions', 'firebase-admin/app']) {
  refused[specifier] = await import(specifier).then(() => 'loaded', (error) => error.message);
}
console.log('RESULT ' + JSON.stringify({ codes, oneApp: db.app === app && auth.app === app, refused }));
`;

interface Exited {
  code: number | null;
  output: string;
}

function started(command: string, args: string[], cwd: string, env: Record<string, string>): { child: ChildProcess; output: () => string; exited: Promise<Exited> } {
  const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? '', ...env } });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<Exited>((resolve) => child.once('exit', (code) => resolve({ code, output })));
  return { child, output: () => output, exited };
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

test('a Node process under @pyric/live/register reports its Firestore and Auth calls to the Node host as production rows', async ({ page }) => {
  test.setTimeout(120_000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-node-')));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-node-home-')));
  let host: ReturnType<typeof started> | undefined;
  try {
    mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
    symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
    symlinkSync(liveDir, join(root, 'node_modules/@pyric/live'));
    symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'live-node-plane', private: true, type: 'module' }));
    // The Firebase project live mode names, from the app's own Firebase config.
    writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'live-node-plane' } }));
    writeFileSync(join(root, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, hosting: { public: 'public' } }));
    writeFileSync(join(root, 'firestore.rules'), "rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if false; } } }\n");
    writeFileSync(join(root, 'public/index.html'), '<!doctype html><html><body><p id="status">ready</p></body></html>');
    writeFileSync(join(root, 'server.mjs'), SERVER_SOURCE);

    const port = await freeLoopbackPort();
    const url = `http://127.0.0.1:${port}`;
    host = started('node', [join(cliDir, 'dist/cli/index.js'), 'sandbox', '--hosted', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)], root, { HOME: home });
    const deadline = Date.now() + 90_000;
    while (!(await answers(`${url}/__pyric/init.json`))) {
      if (host.child.exitCode !== null) throw new Error(`pyric sandbox --hosted exited:\n${host.output()}`);
      if (Date.now() > deadline) throw new Error(`pyric sandbox --hosted did not serve ${url}:\n${host.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // The server process, as a developer starts it: no PYRIC_SANDBOX, the host found from the project.
    const server = started('node', ['--import', '@pyric/live/register', 'server.mjs'], root, { HOME: home, CLOSED_PORT: String(await freeLoopbackPort()) });
    const finished = await server.exited;
    expect(finished.code, finished.output).toBe(0);
    const line = finished.output.split('\n').find((entry) => entry.startsWith('RESULT '));
    expect(line, finished.output).toBeDefined();
    const result = JSON.parse(line?.slice('RESULT '.length) ?? '{}') as { codes: unknown; oneApp: boolean; refused: Record<string, string> };
    expect(result.codes).toEqual({ firestore: 'unavailable', auth: 'auth/network-request-failed' });
    expect(result.oneApp).toBe(true);
    expect(result.refused['firebase/functions']).toContain('firebase/functions (Cloud Functions) is refused in live mode');
    expect(result.refused['firebase-admin/app']).toContain('firebase-admin/app (the Admin SDK) is refused in live mode');
    expect(finished.output).not.toContain('PYRIC_REAL_SDK_STOPPED');

    await page.goto(`${url}/`);
    await expect(page.locator('#status')).toHaveText('ready');
    const chip = page.locator('[data-pyric-runtime-chip-host]');
    await chip.waitFor({ state: 'attached', timeout: 30_000 });
    const expand = chip.locator('[data-expand]');
    if (await expand.isVisible()) await expand.click();
    await chip.locator('[data-chip-tab=traffic]').click();
    // A hosted sandbox host keeps the All traffic switch: only a live host has the From select.
    await chip.locator('[data-traffic-scope=all]').click();
    const rows = chip.locator('[data-traffic-rows] [data-request-row]');
    const firestoreRow = rows.filter({ hasText: 'firestore.getDocFromCache' });
    const authRow = rows.filter({ hasText: 'auth.signInAnonymously' });
    for (const row of [firestoreRow, authRow]) {
      await expect(row).toHaveCount(1);
      await expect(row.locator('[data-traffic-row-production]')).toHaveText('Production');
      await expect(row.locator('[data-traffic-row-source]')).toHaveAttribute('data-traffic-row-source', 'node');
      await expect(row.locator('[data-verdict-production]')).toHaveAttribute('title', 'Production failed');
    }
  } finally {
    await page.close();
    host?.child.kill('SIGTERM');
    await host?.exited;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
