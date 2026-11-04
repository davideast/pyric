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
import { createServer, type PluginOption, type ViteDevServer } from 'vite';
import { pyricLive } from '../../../live/src/vite.js';

const cliDir = fileURLToPath(new URL('../../', import.meta.url));
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
import { connectFirestoreEmulator, doc, getDocFromCache, getFirestore } from 'firebase/firestore';
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
window.importStorage = () => import('firebase/storage').then(() => 'loaded', (error) => error.message);
document.querySelector('#status').textContent = 'Ready';
`;
}

test('a live page reports its Firestore and Auth calls to the Node host as production rows', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-page-')));
  let server: ViteDevServer | undefined;
  try {
    mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
    symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
    symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
    writeFileSync(join(root, 'index.html'), '<output id="status">Starting</output><script type="module" src="/main.js"></script>');
    writeFileSync(join(root, 'main.js'), appSource(await closedLoopbackPort()));
    server = await createServer({
      root, configFile: false, logLevel: 'silent',
      plugins: pyricLive({ capture: false, ui: false, runtimeChip: { initiallyOpen: true } }) as PluginOption[],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, cliDir] } },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (url === undefined) throw new Error('Vite did not expose a URL');
    await page.goto(url);
    await expect(page.locator('#status')).toHaveText('Ready');

    const result = await page.evaluate(() => (Reflect.get(window, 'run') as () => Promise<unknown>)());
    expect(result).toEqual({ codes: { firestore: 'unavailable', auth: 'auth/network-request-failed' }, oneApp: true });

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
  } finally {
    await page.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
