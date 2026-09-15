import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const browser = await chromium.launch();
try {
 for (const service of ['firestore', 'rtdb']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const openRates = async () => {
   const opener = page.getByRole('button', { name: 'Open pyric', exact: true });
   await expect(opener.or(page.getByRole('button', { name: 'Minimize pyric', exact: true }))).toBeVisible();
   if (await opener.isVisible()) await opener.click();
   await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
   await page.getByRole('button', { name: 'Rates', exact: true }).click();
   await page.getByRole('button', { name: service === 'firestore' ? 'Firestore' : 'Realtime Database', exact: true }).click();
  };
  await page.goto(`http://localhost:5197/?service=${service}`);
  await page.getByRole('button', { name: 'Minimize pyric', exact: true }).click();
  await page.locator('#rate-burst').click();
  await expect(page.locator('#rate-burst')).toBeEnabled({ timeout: 20000 });
  await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
  await openRates();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const writes = await page.locator('[data-history-total=writes]').textContent();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('button', { name: 'Save capture…', exact: true }).click();
  await expect(page.locator('[data-project-capture]').first()).toBeVisible();
  const id = await page.locator('[data-project-capture]').first().getAttribute('data-project-capture');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.screenshot({ path: `/tmp/project-captures-${service}-${width}.png` });
    expect(await page.locator('.traffic-toolbar').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
  }
  await page.reload(); await openRates();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('button', { name: 'Open capture…', exact: true }).click();
  await page.locator(`[data-project-capture="${id}"]`).click();
  await expect(page.locator('[data-history-total=writes]')).toHaveText(writes);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  const download = await downloading;
  const path = `/tmp/${service}-rate.capture.json`; await download.saveAs(path);
  const capture = JSON.parse(await readFile(path, 'utf8'));
  expect(capture.schema).toBe('pyric.rate-capture.v1');
  expect(capture.operations.length).toBeGreaterThan(0);
  expect(capture.sessionFixture.fixture.format).toBe('pyric.full-state');
  expect(capture.replay.available).toBe(false);
  await page.reload(); await openRates();
  await page.locator('[data-capture-file]').setInputFiles(path);
  await expect(page.locator('.history-help').filter({ hasText: 'Saved capture' })).toBeVisible();
  await expect(page.locator('[data-history-total=writes]')).toHaveText(writes);
  for (const width of [1440, 390]) {
   await page.setViewportSize({ width, height: 1100 });
   await page.locator('.rate-menu').scrollIntoViewIfNeeded();
   await expect(page.locator('[data-capture-file]')).toBeHidden();
   expect(await page.locator('.traffic-toolbar').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
   await page.screenshot({ path: `/tmp/capture-${service}-${width}.png` });
  }
  await page.getByRole('button', { name: 'Return to live', exact: true }).click();
  await expect(page.locator('[data-history-scrubber]')).toBeVisible();
  console.log('PASS project save, reload, project reopen, download, file import and return to live', service);
  await page.close();
 }
} finally { await browser.close(); }
