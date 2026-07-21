import { test, expect, type Page } from '@playwright/test';

/**
 * Blocking smoke check for the composed static site (`dist/site/`, built by
 * `scripts/build-site.sh`) served by a PLAIN static file server (see
 * `playwright.config.ts` — python3's `http.server`, no `pyric dev` behind it).
 *
 * Verifies the spike's core claim: everything degrades cleanly with ZERO
 * server routes behind the site.
 */

/** Every request URL seen on the page, collected via CDP-level request
 *  interception (not just fetch/XHR — also covers EventSource, which Chromium
 *  surfaces as a normal network request). */
function trackRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));
  return urls;
}

test('Studio loads at / with no console errors', async ({ page }) => {
  const urls = trackRequests(page);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  const res = await page.goto('/');
  expect(res?.ok()).toBeTruthy();
  await expect(page).toHaveTitle(/./); // some non-empty title rendered
  await expect(page.getByLabel('Studio tabs')).toBeVisible();
  await expect(page.getByText('Starting Pyric Studio…', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await page.locator('link[rel="icon"]').getAttribute('href')).toBe('/pyric-logo.svg');

  await expect.poll(() => urls.find((url) => url.includes('/__pyric/sdk/worker.js'))).not.toBeUndefined();
  const workerUrl = urls.find((url) => url.includes('/__pyric/sdk/worker.js'));
  if (!workerUrl) throw new Error(`Studio did not request its SharedWorker bundle:\n${urls.join('\n')}`);
  expect(await page.evaluate(async (url) => (await fetch(url)).status, workerUrl)).toBe(200);

  const retiredServerRoutes = /\/__pyric\/(state|projects|workspace|capture)(\?|$|\/)/;
  expect(urls.filter((url) => retiredServerRoutes.test(url))).toEqual([]);
  expect(errors, `uncaught page errors: ${errors.join('\n')}`).toEqual([]);
});

test('a documentation page stays static and does not start the Studio SharedWorker', async ({ page }) => {
  const urls = trackRequests(page);
  const res = await page.goto('/docs/build/cloud-firestore/');
  expect(res?.ok()).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'Run Cloud Firestore locally' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(urls.filter((url) => url.includes('/__pyric/sdk/worker.js'))).toEqual([]);
});

test('the unified build preserves the Firestore seed, theme utilities, and pane borders', async ({ page }) => {
  await page.goto('/firestore/');
  await page.getByText('notes', { exact: true }).click();
  await page.getByText('welcome', { exact: true }).click();
  await expect(page.getByText('Welcome to Pyric Studio', { exact: true })).toBeVisible();

  const theme = await page.locator('.studio').evaluate((root) => {
    const styles = getComputedStyle(root);
    return {
      border: styles.getPropertyValue('--color-border').trim(),
      contentBackground: styles.getPropertyValue('--color-content-bg').trim(),
    };
  });
  expect(theme).toEqual({ border: '#2a2a35', contentBackground: '#16161a' });

  const utilities = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'border border-border bg-content-bg px-3 py-1.5 text-soft-white';
    document.body.append(probe);
    const styles = getComputedStyle(probe);
    return {
      borderWidth: styles.borderTopWidth,
      borderColor: styles.borderTopColor,
      background: styles.backgroundColor,
      color: styles.color,
      padding: `${styles.paddingTop} ${styles.paddingRight}`,
    };
  });
  expect(utilities).toEqual({
    borderWidth: '1px',
    borderColor: 'rgb(42, 42, 53)',
    background: 'rgb(22, 22, 26)',
    color: 'rgb(251, 251, 254)',
    padding: '6px 12px',
  });

  const separators = await page.locator('.fs-pane').evaluateAll((panes) =>
    panes.slice(0, -1).map((pane) => {
      const styles = getComputedStyle(pane);
      return { width: styles.borderRightWidth, color: styles.borderRightColor };
    }),
  );
  expect(separators).toEqual([
    { width: '1px', color: 'rgb(42, 42, 53)' },
    { width: '1px', color: 'rgb(42, 42, 53)' },
  ]);
});

test('the checked-in Firestore example runs in its isolated iframe and resets', async ({ page }) => {
  await page.goto('/docs/build/cloud-firestore/');
  const frame = page.frameLocator('iframe[title="Write to an isolated Firestore sandbox"]');
  await expect(frame.getByText('The sandbox is local')).toBeVisible();
  await frame.getByRole('button', { name: 'Reset sandbox' }).click();
  await expect(frame.getByText('The sandbox is local')).toBeVisible();
  await expect(page.getByText("import { doc, getDoc, getFirestore, setDoc } from 'pyric/firestore';", {
    exact: false,
  })).toBeVisible();
});

test('public Studio exposes and completes an explicit stale-worker update', async ({ page }) => {
  const servedGeneration = 'fedcba9876543210';
  // Simulate successor HTML while the old worker bundle remains alive, which
  // is the state an already-open Studio sees immediately after a deployment.
  await page.route('http://127.0.0.1:5199/', async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /(<meta name="pyric-worker-v" content=")[a-f0-9]{16}("\s*\/?>)/,
      `$1${servedGeneration}$2`,
    );
    await route.fulfill({ response, body });
  });
  await page.goto('/');

  expect(await page.locator('meta[name="pyric-worker-v"]').getAttribute('content')).toBe(servedGeneration);
  await expect(page.getByRole('button', { name: 'update worker' })).toBeVisible();

  const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
  await page.getByRole('button', { name: 'update worker' }).click();
  await reloaded;
  expect(await page.evaluate(() => localStorage.getItem('pyric:worker-generation'))).toBe(servedGeneration);
});

test('Studio presence chip reports two logical clients then converges to one (#227)', async ({
  browser,
}) => {
  // Two real Studio pages against one SharedWorker: the shell chip must show
  // "2 pages connected", then converge to one after the second page closes.
  // Asserts externally visible behavior only (count label), not protocol internals.
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();

  await pageA.goto('/');
  await pageB.goto('/');

  const chipA = pageA.getByRole('button', { name: /page(?:s)? connected/i });
  const chipB = pageB.getByRole('button', { name: /page(?:s)? connected/i });

  await expect(chipA).toBeVisible({ timeout: 10_000 });
  await expect(chipB).toBeVisible({ timeout: 10_000 });

  // Wait until both pages see each other (count may start at 1 while the peer
  // registers).
  await expect
    .poll(async () => (await chipA.textContent())?.trim(), { timeout: 10_000 })
    .toBe('2 pages connected');
  await expect
    .poll(async () => (await chipB.textContent())?.trim(), { timeout: 10_000 })
    .toBe('2 pages connected');

  await pageB.close();

  await expect
    .poll(async () => (await chipA.textContent())?.trim(), { timeout: 10_000 })
    .toBe('1 page connected');

  // Expand details: This page + honest visibility boundary.
  await chipA.click();
  await expect(pageA.getByText('This page', { exact: true })).toBeVisible();
  await expect(pageA.getByText(/browser profile/i)).toBeVisible();

  await context.close();
});
