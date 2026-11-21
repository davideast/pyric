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
import { copyFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createLogger, createServer, type PluginOption, type ViteDevServer } from 'vite';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.js';

const cliDir = fileURLToPath(new URL('../../', import.meta.url));
const liveDir = fileURLToPath(new URL('../../../live/', import.meta.url));
const serviceWorkerFixture = fileURLToPath(new URL('./fixture/live-service-worker.js', import.meta.url));
const require = createRequire(import.meta.url);
const firebaseDir = realpathSync(dirname(require.resolve('firebase/package.json')));

/**
 * The page registers the fixture as a module service worker, waits until the
 * worker has finished activating (`state === 'activated'`) and claimed this
 * client (`navigator.serviceWorker.controller`), and exposes `readInWorker`.
 */
const PAGE_HTML = `<!doctype html>
<output id="status">Starting</output>
<script type="module">
try {
  await navigator.serviceWorker.register('/sw.js', { type: 'module' });
  const readyRegistration = await navigator.serviceWorker.ready;
  const worker = readyRegistration.active;
  if (!worker) {
    throw new Error('Service worker registration resolved without an active worker');
  }
  if (worker.state !== 'activated') {
    await new Promise((resolve, reject) => {
      const onStateChange = () => {
        if (worker.state === 'activated') {
          worker.removeEventListener('statechange', onStateChange);
          resolve();
        } else if (worker.state === 'redundant') {
          worker.removeEventListener('statechange', onStateChange);
          reject(new Error('Service worker became redundant before activating'));
        }
      };
      worker.addEventListener('statechange', onStateChange);
      onStateChange();
    });
  }
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      const onControllerChange = () => {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        resolve();
      };
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        resolve();
      }
    });
  }
  window.readInWorker = () => new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for service worker read-from-cache reply'));
    }, 15000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.postMessage({ type: 'read-from-cache' }, [channel.port2]);
  });
  document.querySelector('#status').textContent = 'Ready';
} catch (error) {
  document.querySelector('#status').textContent = String(error);
  throw error;
}
</script>
`;

const SW_COLD_STARTUP_TIMEOUT_MS = 45_000;
const OBSERVED_ROW_TIMEOUT_MS = 15_000;

test('a module service worker under live mode reports its Firestore read to the Node host as the service worker', async ({ page }) => {
  test.setTimeout(90_000);
  const rawRoot = createPrivateJobTmpDir('live-sw');
  const root = realpathSync(rawRoot);
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
    // Capture page and service-worker console output plus uncaught realm errors.
    page.context().on('console', (message) => reports.push(message.text()));
    page.context().on('weberror', (webError) => reports.push(String(webError.error())));
    page.on('pageerror', (error) => reports.push(String(error)));
    const logger = createLogger('silent');
    logger.info = (message) => { reports.push(message); };
    logger.error = (message) => { reports.push(message); };
    server = await createServer({
      root, configFile: false, customLogger: logger,
      plugins: [pyricLive({ capture: false, ui: false, runtimeChip: { initiallyOpen: true } }) as PluginOption],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, cliDir, liveDir, firebaseDir] } },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (url === undefined) throw new Error('Vite did not expose a URL');
    await page.goto(url);

    // `page.goto` resolves at `load` as soon as `<script type="module">` reaches
    // `await navigator.serviceWorker.register(...)`, before Vite cold-transforms
    // `/sw.js`'s unbundled `@firebase/firestore` and observer module graph. Poll
    // until `#status` leaves `Starting` so real registration errors fail immediately
    // while cold CI module transforms get a full startup budget.
    await expect
      .poll(async () => await page.locator('#status').textContent(), {
        timeout: SW_COLD_STARTUP_TIMEOUT_MS,
      })
      .not.toBe('Starting');
    expect(await page.locator('#status').textContent(), reports.join('\n')).toBe('Ready');

    const code = await page.evaluate(() => (Reflect.get(window, 'readInWorker') as () => Promise<unknown>)());
    expect(code).toBe('unavailable');

    await expect(page.locator('.panel-header [data-chip-live]')).toHaveCount(1, {
      timeout: OBSERVED_ROW_TIMEOUT_MS,
    });
    await page.locator('[data-chip-tab=traffic]').click();
    await page.locator('[data-traffic-from]').selectOption('all');
    const row = page.locator('[data-traffic-rows] [data-request-row]').filter({ hasText: 'firestore.getDocFromCache' });
    try {
      await expect(row).toHaveCount(1, { timeout: OBSERVED_ROW_TIMEOUT_MS });
    } catch (error) {
      throw new Error(`${String(error)}\n${reports.join('\n')}`, { cause: error });
    }
    await expect(row.locator('[data-traffic-row-production]')).toHaveCount(1);
    await expect(row.locator('[data-traffic-row-source]')).toHaveAttribute('data-traffic-row-source', 'service-worker');
    await expect(row.locator('[data-verdict-production]')).toHaveAttribute('data-verdict-production', 'failed');
  } finally {
    await page.close();
    await server?.close();
    removePrivateJobTmpDir(rawRoot);
  }
});
