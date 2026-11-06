/**
 * Live mode's page plane through a real Vite dev server and Chromium: the
 * page imports `firebase/*` as an app does, gets the installed SDK wrapped
 * by `@pyric/live`'s rows, and each Firestore and Auth call's outcome shows
 * in the chip as a production row from this page. The SDK points at a
 * closed loopback port, so nothing reaches a Firebase backend. A served
 * specifier with no live row is refused.
 *
 * The chip's header stays one line, "pyric" and the project name, however
 * long the project id and however many imports pass through, so its Studio
 * and Minimize buttons stay where a developer clicks them.
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
import { expect, test, type Page } from '@playwright/test';
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

function appSource(port: number, projectId = 'live-page-plane'): string {
  return `
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDocFromCache, getFirestore, onSnapshot } from 'firebase/firestore';
const app = initializeApp({ projectId: '${projectId}', apiKey: 'live-page-plane-key', appId: '1:1:web:1' });
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
window.importFunctions = () => import('firebase/functions').then(() => 'loaded', (error) => error.message);
document.querySelector('#status').textContent = 'Ready';
`;
}

interface LiveHealth {
  live?: { projectId: string; configProjectId: string; billed: { reads: number; writes: number; deliveries: number }; passThrough?: string[] };
}

async function healthOf(base: string): Promise<LiveHealth | null> {
  const response = await fetch(new URL('/__pyric/health', base));
  return response.ok ? await response.json() as LiveHealth : null;
}

interface Box { x: number; y: number; width: number; height: number }

interface ControlLayout { box: Box; reachedAtCentre: boolean }

interface HeaderLayout { header: Box; brand: Box; name: Box; studio: ControlLayout; minimize: ControlLayout }

/**
 * The open chip header's boxes, measured in one pass: the chip renders its
 * markup again on each status read, so separate reads could each meet a
 * different header. The measuring waits out the panel's enter animation,
 * which scales it. A control is reached at its centre when a click there
 * lands on it, so nothing covers it.
 */
async function headerLayout(page: Page): Promise<HeaderLayout> {
  return page.evaluate(async () => {
    const root = document.querySelector('[data-pyric-runtime-chip-host]')!.shadowRoot!;
    await Promise.all(root.getAnimations().map((animation) => animation.finished));
    const boxOf = (selector: string) => {
      const rect = root.querySelector(selector)!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const controlOf = (selector: string) => {
      const element = root.querySelector(selector)!;
      const box = boxOf(selector);
      const hit = root.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { box, reachedAtCentre: hit !== null && element.contains(hit) };
    };
    return {
      header: boxOf('.panel-header'),
      brand: boxOf('.panel-header .brand'),
      name: boxOf('.panel-header .panel-name'),
      studio: controlOf('.panel-header [data-open-studio]'),
      minimize: controlOf('.panel-header [data-collapse]'),
    };
  });
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

    // The chip names the project for as long as the host runs; the host counts billed calls from every client.
    await expect(page.locator('.panel-header [data-chip-live]')).toHaveCount(1);
    expect((await healthOf(url))?.live?.projectId).toBe('live-page-plane');
    await expect.poll(async () => (await healthOf(url))?.live?.billed).toEqual({ reads: 0, writes: 0, deliveries: 0 });
    expect(await page.evaluate(() => (Reflect.get(window, 'listen') as () => Promise<string>)())).toBe('delivered');
    await expect.poll(async () => (await healthOf(url))?.live?.billed).toEqual({ reads: 0, writes: 0, deliveries: 1 });
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

    const refusal = await page.evaluate(() => (Reflect.get(window, 'importFunctions') as () => Promise<string>)());
    expect(refusal).toContain('firebase/functions (Cloud Functions) is refused in live mode');
    expect(reports.filter((line) => line.includes('PYRIC_REAL_SDK_STOPPED') || line.includes('stopped loading the real'))).toEqual([]);
  } finally {
    process.stderr.write = writeStderr;
    await page.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the chip header stays one line, with a long project id and several imports passing through', async ({ page }, testInfo) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-header-')));
  let server: ViteDevServer | undefined;
  // Firebase's longest project ids are 30 characters; the app's config names another project than .firebaserc.
  const appProject = 'live-header-worst-case-project';
  const configProject = 'live-header-staging-project-01';
  const passThrough = ['firebase/analytics', 'firebase/functions', 'firebase/performance', 'firebase/remote-config'];
  try {
    mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
    symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
    symlinkSync(liveDir, join(root, 'node_modules/@pyric/live'));
    symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
    writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: configProject } }));
    writeFileSync(join(root, 'index.html'), '<output id="status">Starting</output><script type="module" src="/main.js"></script>');
    writeFileSync(join(root, 'main.js'), appSource(await closedLoopbackPort(), appProject));
    const { pyricLive } = await import(createRequire(join(root, 'package.json')).resolve('@pyric/live/vite')) as typeof import('../../../live/src/vite.js');
    server = await createServer({
      root, configFile: false, customLogger: createLogger('silent'),
      plugins: [pyricLive({ capture: false, passThrough, runtimeChip: { initiallyOpen: true } }) as PluginOption],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, cliDir] } },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (url === undefined) throw new Error('Vite did not expose a URL');
    await page.goto(url);
    await expect(page.locator('#status')).toHaveText('Ready');
    await page.evaluate(() => (Reflect.get(window, 'run') as () => Promise<unknown>)());

    // The host knows the mismatch, the pass-through imports and the count; the header shows the project only.
    await expect.poll(async () => (await healthOf(url))?.live?.projectId).toBe(appProject);
    expect((await healthOf(url))?.live).toMatchObject({ configProjectId: configProject, passThrough });
    const header = page.locator('.panel-header');
    await expect(header.locator('[data-chip-live]')).toHaveCount(1);

    const layout = await headerLayout(page);
    expect(layout.header.height).toBe(64);
    // One line: the brand is no taller than "pyric" itself.
    expect.soft(layout.brand.height).toBeLessThanOrEqual(layout.name.height + 1);
    for (const [name, control] of Object.entries({ studio: layout.studio, minimize: layout.minimize })) {
      expect(control.box.height, name).toBeGreaterThan(0);
      expect(control.box.y, name).toBeGreaterThanOrEqual(layout.header.y);
      expect(control.box.y + control.box.height, name).toBeLessThanOrEqual(layout.header.y + layout.header.height);
      expect(control.reachedAtCentre, name).toBe(true);
    }
    await expect(page.locator('.panel-header [data-open-studio]')).toBeVisible();
    await expect(page.locator('.panel-header [data-collapse]')).toBeVisible();
    await page.locator('.panel-header [data-open-studio]').click({ trial: true, timeout: 5_000 });
    const screenshot = testInfo.outputPath('chip-header-worst-case.png');
    await page.screenshot({ path: screenshot, clip: layout.header });
    await testInfo.attach('chip-header-worst-case', { path: screenshot, contentType: 'image/png' });
    await expect(header.locator('.brand > *')).toHaveCount(2);
    await expect(header.locator('[role="status"]')).toHaveCount(0);

    await page.locator('.panel-header [data-collapse]').click({ timeout: 5_000 });
    await expect(page.locator('[data-expand] [data-chip-live]')).toHaveCount(1);
  } finally {
    await page.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
