import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSdkFlowServer } from '../../../../examples/runtime-flow-lab/sdk-server.mts';

let root: string;
let server: Awaited<ReturnType<typeof startSdkFlowServer>>;
test.beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'index-chip-')); server = await startSdkFlowServer(0, root); });
test.afterAll(async () => { await server?.close(); await rm(root, { recursive: true, force: true }); });
test.beforeEach(async () => {
  await writeFile(join(root, 'firebase.json'), JSON.stringify({ firestore: { indexes: 'local.indexes.json' }, database: { rules: 'database.rules.json' } }));
  await writeFile(join(root, 'database.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true, projects: {} } }));
  await writeFile(join(root, 'local.indexes.json'), JSON.stringify({ indexes: [], fieldOverrides: [{ collectionGroup: 'projects', fieldPath: 'privateNotes', indexes: [] }] }));
});

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: query finding previews, applies and rechecks local indexes`, async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1050 });
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await page.locator('[data-index-read]').click();
    await expect(page.locator('[data-index-results]')).toContainText('4 draft projects');
    await expect(page.getByRole('tab', { name: 'Traffic', exact: true })).toHaveClass(/pending/);
    await page.locator('[data-collapse]').click();
    await expect(page.locator('[data-expand]')).toHaveClass(/warning/);
    await page.locator('[data-expand]').click();
    await expect(page.getByRole('tab', { name: 'Traffic', exact: true })).toHaveAttribute('aria-selected', 'true');
    const warning = page.locator('[data-request-row]').filter({ hasText: 'projects' }).first().locator('.index-warning');
    await expect(warning).toHaveAttribute('aria-label', 'Index missing from config');
    expect(await warning.evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    const query = page.locator('[data-listener-row]').filter({ hasText: 'projects' }).first();
    await expect(query).toContainText('Index missing from config');
    await page.locator('[data-index-read]').click();
    await expect(page.locator('[data-listener-row]').filter({ hasText: 'projects' })).toHaveCount(1);
    await query.click();
    const details = page.locator('[data-index-details]');
    await expect(details).toContainText('Missing from config');
    await expect(details).toContainText('budget');
    await expect(details.getByRole('button', { name: 'Preview change' })).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Copy index definition' })).toBeVisible();
    await expect(details.getByLabel('Index addition')).toContainText('DESCENDING');
    expect(JSON.parse(await readFile(join(root, 'local.indexes.json'), 'utf8')).indexes).toHaveLength(0);
    await details.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/index-preview-${runtime}.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await details.scrollIntoViewIfNeeded();
    expect(await details.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Add index', exact: true })).toBeInViewport();
    const bar = page.locator('[data-action-bar]');
    expect(await bar.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/index-preview-narrow-${runtime}.png` });
    const add = page.getByRole('button', { name: 'Add index', exact: true });
    const width = await add.evaluate(el => el.getBoundingClientRect().width);
    await add.click();
    await expect(details).toContainText('Configured');
    expect(await add.evaluate(el => el.getBoundingClientRect().width)).toBe(width);
    await expect(add).toHaveAttribute('data-save-state', 'saved');
    await expect(details).not.toContainText('Index added to config.');
    await expect(page.getByRole('button', { name: 'Add index', exact: true })).toBeDisabled();
    await expect(page.getByRole('tab', { name: 'Traffic', exact: true })).not.toHaveClass(/pending/);
    const file = JSON.parse(await readFile(join(root, 'local.indexes.json'), 'utf8'));
    expect(file.indexes).toHaveLength(1);
    expect(file.fieldOverrides).toHaveLength(1);
    await page.setViewportSize({ width: 1500, height: 1050 });
    await page.locator('[data-sources-back]').click();
    await expect(page.locator('[data-listener-row]').filter({ hasText: 'projects' })).not.toContainText('Index');
    await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
    await page.locator('[data-request-row]').filter({ hasText: 'projects' }).first().click();
    await expect(page.locator('[data-index-details]')).toContainText('Configured');
  });
}

test('local index endpoint requires the session capability and rejects cross-origin edits', async ({ request }) => {
  const init = await (await request.get(`${server.url}/__pyric/init.json`)).json();
  expect((await request.get(`${server.url}/__pyric/indexes`)).status()).toBe(401);
  expect((await request.put(`${server.url}/__pyric/indexes`, { headers: { origin: 'https://untrusted.example', 'x-pyric-session-token': init.sessionToken }, data: {} })).status()).toBe(403);
});

test('traffic badges share dimensions and alignment at narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.url}/?runtime=inpage`);
  await page.getByRole('button', { name: 'Read document', exact: true }).click();
  await page.getByRole('button', { name: 'Read denied path', exact: true }).click();
  await page.locator('[data-index-read]').click();
  await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
  for (const label of ['Succeeded', 'Denied', 'Index missing from config']) {
    const badge = page.locator('.verdict').filter({ has: page.locator('svg') }).and(page.getByLabel(label, { exact: true })).first();
    await expect(badge).toBeVisible();
    expect(await badge.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const icon = el.querySelector('svg')!.getBoundingClientRect();
      const text = el.querySelector('.verdict-label')!.getBoundingClientRect();
      return { width: rect.width, height: rect.height, iconOffset: Math.round(icon.left - rect.left), textRightInset: Math.round(rect.right - text.right), textAlign: getComputedStyle(el.querySelector('.verdict-label')!).textAlign, overflow: el.scrollWidth > el.clientWidth };
    })).toEqual({ width: 80, height: 24, iconOffset: 7, textRightInset: 9, textAlign: 'right', overflow: false });
  }
  await page.screenshot({ path: '/tmp/traffic-badges-narrow.png' });
  await page.setViewportSize({ width: 1500, height: 1050 });
  await page.screenshot({ path: '/tmp/traffic-badges-desktop.png' });
});

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: RTDB failed query uses the same index preview and local action`, async ({ page }) => {
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await page.locator('[data-database-index-read]').click();
    await expect(page.locator('[data-database-index-results]')).toContainText('Index not defined');
    await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
    const row = page.locator('[data-request-row]').filter({ hasText: 'rtdb.get' }).filter({ hasText: '/projects' }).first();
    await expect(row.getByLabel('Index missing from config')).toBeVisible();
    await page.locator('[data-database-index-listen]').click();
    const failedListener = page.locator('[data-request-row]').filter({ hasText: 'rtdb.listen' }).filter({ hasText: '/projects' }).first();
    await expect(failedListener.getByLabel('Index missing from config')).toBeVisible();
    if (await page.locator('[data-database-index-listen]').textContent() === 'Stop database query') await page.locator('[data-database-index-listen]').click();
    await row.click();
    const details = page.locator('[data-index-details]');
    await expect(page.locator('[data-traffic-detail]')).toContainText('Realtime Database');
    await expect(page.locator('[data-traffic-detail]')).toContainText('Failed');
    await expect(details).toContainText('budget');
    await expect(details).toContainText('database.rules.json');
    await details.getByText('JSON definition', { exact: true }).click();
    await expect(details.getByLabel('Index addition')).toContainText('".indexOn"');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await details.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const add = page.getByRole('button', { name: 'Add index', exact: true });
    await expect(add).toBeInViewport();
    const before = await add.boundingBox();
    await add.click();
    await expect(add).toHaveAttribute('data-save-state', 'saved');
    expect((await add.boundingBox())?.width).toBe(before?.width);
    await expect(details).toContainText('Configured');
    const config = JSON.parse(await readFile(join(root, 'database.rules.json'), 'utf8'));
    expect(config.rules.projects['.indexOn']).toBe('budget');
    expect(config.rules['.read']).toBe(true);
    // Saving configuration does not rewrite a recorded failed outcome.
    await expect(page.locator('[data-traffic-detail]')).toContainText('Failed');
    await page.setViewportSize({ width: 1500, height: 1050 });
    await page.locator('[data-database-index-read]').click();
    await expect(page.locator('[data-database-index-results]')).toContainText('large');
    await page.locator('[data-request-back]').click();
    await expect(page.locator('[data-request-row]').filter({ hasText: 'rtdb.get' }).filter({ hasText: '/projects' }).getByLabel('Succeeded', { exact: true }).first()).toBeVisible();
    await page.locator('[data-database-index-listen]').click();
    await expect(page.locator('[data-database-index-listen]')).toHaveText('Stop database query');
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    const source = page.locator('[data-listener-row]').filter({ hasText: '/projects' }).first();
    await expect(source).toContainText('Realtime Database');
    await source.click();
    await expect(page.locator('[data-index-details]')).toContainText('Configured');
    await page.locator('[data-database-index-listen]').click();
    await expect(page.locator('[data-database-index-listen]')).toHaveText('Listen to database projects');
    await page.screenshot({ path: `/tmp/rtdb-index-${runtime}.png` });
  });
}
