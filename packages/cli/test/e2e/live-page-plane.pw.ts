/**
 * Live mode's page plane through a real Vite dev server and Chromium: the
 * page imports `firebase/*` as an app does, gets the installed SDK wrapped
 * by `@pyric/live`'s rows, and each Firestore and Auth call's outcome shows
 * in the chip as a production row from this page. The SDK points at a
 * closed loopback port, so nothing reaches a Firebase backend. A served
 * specifier with no live row is refused.
 *
 * The plan's replay-server scenario under `test/apps/` drives the same path
 * through the packed packages and the `pyric-live` command.
 */
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createLogger, createServer, type PluginOption, type ViteDevServer } from 'vite';

const cliDir = fileURLToPath(new URL('../../', import.meta.url));
const liveDir = fileURLToPath(new URL('../../../live/', import.meta.url));
const require = createRequire(import.meta.url);
const firebaseDir = dirname(require.resolve('firebase/package.json'));

async function closedLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  return address.port;
}

function appSource(port: number): string {
  return `
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDocFromCache, getFirestore, onSnapshot } from 'firebase/firestore';
const app = initializeApp({ projectId: 'live-page-plane', apiKey: 'live-page-plane-key', appId: '1:1:web:1' });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:${port}', { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', ${port});
window.run = async () => {
  const codes = {};
  await getDocFromCache(doc(db, 'rooms/lobby')).catch((error) => { codes.firestore = error.code; });
  await signInAnonymously(auth).catch((error) => { codes.auth = error.code; });
  return { codes, oneApp: db.app === app && auth.app === app };
};
// The offline SDK delivers the listener its cached snapshot: one document delivered to the listener.
window.listen = () => new Promise((resolve) => { const stop = onSnapshot(doc(db, 'rooms/listened'), () => { stop(); resolve('delivered'); }, (error) => resolve(error.code)); });
window.importStorage = () => import('firebase/storage').then(() => 'loaded', (error) => error.message);
document.querySelector('#status').textContent = 'Ready';
`;
}

test('a live page reports its Firestore and Auth calls to the Node host as production rows', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-page-')));
  let server: ViteDevServer | undefined;
  // Every line the page and the dev server process report, so a stop report anywhere fails the test.
  const reports: string[] = [];
  const writeStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    reports.push(String(chunk));
    return writeStderr(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
    symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
    symlinkSync(liveDir, join(root, 'node_modules/@pyric/live'));
    symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
    // The Firebase project live mode names, from the app's own Firebase config.
    writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'live-page-plane' } }));
    writeFileSync(join(root, 'index.html'), '<output id="status">Starting</output><script type="module" src="/main.js"></script>');
    writeFileSync(join(root, 'main.js'), appSource(await closedLoopbackPort()));
    // The plugin as the app installs it: @pyric/live, resolved from the app's own root.
    const { pyricLive } = await import(createRequire(join(root, 'package.json')).resolve('@pyric/live/vite')) as typeof import('../../../live/src/vite.js');
    page.on('console', (message) => reports.push(message.text()));
    page.on('pageerror', (error) => reports.push(String(error)));
    // A quiet logger that keeps what the plugin reports, the start line among it.
    const logger = createLogger('silent');
    logger.info = (message) => { reports.push(message); };
    server = await createServer({
      root, configFile: false, customLogger: logger,
      plugins: [pyricLive({ capture: false, ui: false, runtimeChip: { initiallyOpen: true } }) as PluginOption],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, cliDir] } },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (url === undefined) throw new Error('Vite did not expose a URL');
    await page.goto(url);
    await expect(page.locator('#status')).toHaveText('Ready');

    const result = await page.evaluate(() => (Reflect.get(window, 'run') as () => Promise<unknown>)());
    expect(result).toEqual({ codes: { firestore: 'unavailable', auth: 'auth/network-request-failed' }, oneApp: true });

    // The chip names the project for as long as the host runs, and counts billed calls from every client.
    await expect(page.locator('.panel-header [data-chip-live]')).toHaveText('Live: live-page-plane');
    await expect(page.locator('[data-chip-billed]')).toHaveText('Billed calls: 0 reads, 0 writes, 0 documents delivered to listeners');
    expect(await page.evaluate(() => (Reflect.get(window, 'listen') as () => Promise<string>)())).toBe('delivered');
    await expect(page.locator('[data-chip-billed]')).toHaveText('Billed calls: 0 reads, 0 writes, 1 document delivered to listeners');
    expect(reports.some((line) => line.includes('@pyric/live/vite: live mode for the Firebase project live-page-plane.'))).toBe(true);

    await page.locator('[data-chip-tab=traffic]').click();
    await page.locator('[data-traffic-scope=all]').click();
    const rows = page.locator('[data-traffic-rows] [data-request-row]');
    const firestoreRow = rows.filter({ hasText: 'firestore.getDocFromCache' });
    const authRow = rows.filter({ hasText: 'auth.signInAnonymously' });
    for (const row of [firestoreRow, authRow]) {
      await expect(row).toHaveCount(1);
      await expect(row.locator('[data-traffic-row-production]')).toHaveText('Production');
      await expect(row.locator('[data-traffic-row-source]')).toHaveAttribute('data-traffic-row-source', 'page');
      await expect(row.locator('[data-verdict-production]')).toHaveAttribute('title', 'Production failed');
    }

    const refusal = await page.evaluate(() => (Reflect.get(window, 'importStorage') as () => Promise<string>)());
    expect(refusal).toContain('firebase/storage (Cloud Storage) is refused in live mode');
    expect(reports.filter((line) => line.includes('PYRIC_REAL_SDK_STOPPED') || line.includes('stopped loading the real'))).toEqual([]);
  } finally {
    process.stderr.write = writeStderr;
    await page.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
