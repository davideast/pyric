/**
 * Live mode's rows in a service worker through a real Vite dev server and
 * Chromium: a module service worker the page registers is served by the
 * live Vite plugin, imports `firebase/*` and so the observer module the live
 * rows share, and makes one Firestore read, which the rows send as one
 * observed call. A service worker never runs the page runtime, so the sender
 * opens its own connection to the Node host from `init.json`. The host
 * writes the call to its event stream, and the page's chip shows it as a
 * production row. The SDK points at a closed loopback port, so nothing
 * reaches a Firebase backend.
 *
 * The connection says at attach that it comes from a service worker, so the
 * row reads "Service worker". The Messaging plan's scenario under
 * `test/apps/` drives a service worker row through the packed packages.
 */
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createLogger, createServer, type PluginOption, type ViteDevServer } from 'vite';

const cliDir = fileURLToPath(new URL('../../', import.meta.url));
const liveDir = fileURLToPath(new URL('../../../live/', import.meta.url));
const serviceWorkerFixture = fileURLToPath(new URL('./fixture/live-service-worker.js', import.meta.url));
const require = createRequire(import.meta.url);
const firebaseDir = dirname(require.resolve('firebase/package.json'));

/** The page registers the fixture as a module service worker, then asks it to make its read. */
const PAGE_HTML = `<!doctype html>
<output id="status">Starting</output>
<script type="module">
// A service worker that fails to evaluate puts its error in the status line.
const registration = await navigator.serviceWorker.register('/sw.js', { type: 'module' })
  .catch((error) => { document.querySelector('#status').textContent = String(error); throw error; });
await navigator.serviceWorker.ready;
const worker = registration.active;
window.readInWorker = () => new Promise((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => resolve(event.data);
  worker.postMessage({ type: 'read-from-cache' }, [channel.port2]);
});
document.querySelector('#status').textContent = 'Ready';
</script>
`;

test('a module service worker under live mode reports its Firestore read to the Node host as the service worker', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-sw-')));
  let server: ViteDevServer | undefined;
  const reports: string[] = [];
  try {
    mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
    symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
    symlinkSync(liveDir, join(root, 'node_modules/@pyric/live'));
    symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
    // The Firebase project live mode names, from the app's own Firebase config.
    writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'live-service-worker' } }));
    writeFileSync(join(root, 'index.html'), PAGE_HTML);
    copyFileSync(serviceWorkerFixture, join(root, 'sw.js'));
    // The plugin as the app installs it: @pyric/live, resolved from the app's own root.
    const { pyricLive } = await import(createRequire(join(root, 'package.json')).resolve('@pyric/live/vite')) as typeof import('../../../live/src/vite.js');
    // The service worker's console too: a send the rows could not make is logged there, never thrown to the app.
    page.context().on('console', (message) => reports.push(message.text()));
    page.on('pageerror', (error) => reports.push(String(error)));
    const logger = createLogger('silent');
    logger.info = (message) => { reports.push(message); };
    logger.error = (message) => { reports.push(message); };
    server = await createServer({
      root, configFile: false, customLogger: logger,
      plugins: [pyricLive({ capture: false, ui: false, runtimeChip: { initiallyOpen: true } }) as PluginOption],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, cliDir] } },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (url === undefined) throw new Error('Vite did not expose a URL');
    await page.goto(url);
    await expect(page.locator('#status'), reports.join('\n')).toHaveText('Ready');

    const code = await page.evaluate(() => (Reflect.get(window, 'readInWorker') as () => Promise<unknown>)());
    expect(code).toBe('unavailable');

    await expect(page.locator('.panel-header [data-chip-live]')).toHaveCount(1);
    await page.locator('[data-chip-tab=traffic]').click();
    await page.locator('[data-traffic-scope=all]').click();
    const row = page.locator('[data-traffic-rows] [data-request-row]').filter({ hasText: 'firestore.getDocFromCache' });
    await expect(row, reports.join('\n')).toHaveCount(1);
    await expect(row.locator('[data-traffic-row-production]')).toHaveText('Production');
    await expect(row.locator('[data-traffic-row-source]')).toHaveText('Service worker');
    await expect(row.locator('[data-verdict-production]')).toHaveAttribute('title', 'Production failed');
  } finally {
    await page.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
