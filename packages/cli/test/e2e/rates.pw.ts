import { test, expect, type Page } from '@playwright/test';
import { startSdkFlowServer } from '../../../../examples/runtime-flow-lab/sdk-server.mts';
import type { SdkRateSnapshot } from 'pyric/sandbox/internal';

let server: Awaited<ReturnType<typeof startSdkFlowServer>>;
test.beforeAll(async () => { server = await startSdkFlowServer(0); });
test.afterAll(async () => { await server.close(); });

async function measurements(page: Page): Promise<SdkRateSnapshot> {
  return page.evaluate(() => {
    const key = Symbol.for('pyric.sdk-rates');
    const monitor = (globalThis as unknown as Record<symbol, { snapshot(): SdkRateSnapshot }>)[key];
    return monitor.snapshot();
  });
}

async function calls(page: Page, service: string, method: string): Promise<number> {
  const snapshot = await measurements(page);
  const row = snapshot.services.find(entry => entry.service === service)?.methods.find(entry => entry.method === method);
  if (!row) throw new Error(`Missing instrumentation: ${service}.${method}`);
  return row.buckets.reduce((total, bucket) => total + bucket.calls, 0);
}

// Opening a service after 2s idle pauses on its latest activity (#643). Counting needs the live
// window, so pause if needed and then resume, whatever state the open chose.
async function resumeLive(page: Page): Promise<void> {
  const toggle = page.locator('[data-history-toggle]');
  if (await toggle.textContent() === 'Pause') await toggle.click();
  await expect(toggle).toHaveText('Resume live');
  await toggle.click();
  await expect(toggle).toHaveText('Pause');
}

// Since #643 a service opens on its activity chart; the method table lives under More actions.
async function openMeasurements(page: Page, service: string): Promise<void> {
  await page.locator(`[data-inspect-rates=${service}]`).click();
  await resumeLive(page);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.locator('[data-rate-measurements]').click();
  await expect(page.locator(`[data-rate-detail=${service}]`)).toBeVisible();
}

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: rates survive history clearing and Flow changes, and listener activity stops`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1500, height: 1050 });
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await expect(page.locator('[data-read=document]')).toBeVisible();
    // The example writes before mounting the chip. Collection must start earlier.
    expect(await calls(page, 'firestore', 'setDoc')).toBe(1);
    expect(await calls(page, 'rtdb', 'set')).toBe(1);
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.locator('[data-read=database]').click();
    await expect.poll(() => calls(page, 'rtdb', 'get')).toBe(1);
    await page.locator('[data-listener-row]').filter({ hasText: 'Realtime Database' }).first().click();
    await page.locator('[data-clear-activity-history]').click();
    expect(await calls(page, 'rtdb', 'get')).toBe(1);
    await page.locator('[data-listen]').click();
    await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
    await page.getByRole('button', { name: 'Rates', exact: true }).click();
    await page.screenshot({ path: `/tmp/service-rates-${runtime}-overview.png` });
    await openMeasurements(page, 'rtdb');
    const method = page.locator('[data-rate-method=onValue]');
    await expect(page.locator('[data-rate-listeners]')).toHaveText('1');
    await page.locator('[data-write]').click();
    await expect.poll(async () => Number(await method.locator('[data-period-results]').textContent())).toBeGreaterThan(0);
    await page.locator('[data-listen]').click();
    await expect(page.locator('[data-rate-listeners]')).toHaveText('0');
    const delivered = await method.locator('[data-period-results]').textContent();
    await page.locator('[data-write]').click();
    await expect(method.locator('[data-period-results]')).toHaveText(delivered!);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-rate-detail]')).toBeVisible();
    expect(await page.locator('[data-rate-detail]').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.locator('[data-action-bar]').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/service-rates-${runtime}-narrow.png` });
    await page.setViewportSize({ width: 1500, height: 1050 });
    await page.screenshot({ path: `/tmp/service-rates-${runtime}.png` });
  });

  test(`${runtime}: burst and denied attempts count once beyond the history limit`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1500, height: 1050 });
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await expect(page.locator('[data-read=document]')).toBeVisible();
    await page.locator('[data-read=document]').evaluate(button => {
      for (let index = 0; index < 150; index++) (button as HTMLButtonElement).click();
    });
    await expect.poll(() => calls(page, 'firestore', 'getDoc')).toBe(150);
    await expect(page.locator('[data-result]')).toContainText('#150');
    await page.locator('[data-denied]').click();
    await expect.poll(() => calls(page, 'firestore', 'getDoc')).toBe(151);
    await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
    await page.getByRole('button', { name: 'Rates', exact: true }).click();
    // Storage is measured since #644, so its row summarizes activity instead of saying Not measured.
    await expect(page.locator('[data-service-summary=storage]')).toContainText('0 reads / 0 writes / 0 deletes');
    await openMeasurements(page, 'firestore');
    await page.setViewportSize({ width: 390, height: 844 });
    const longMethod = page.locator('[data-rate-method=getAggregateFromServer] code');
    await longMethod.scrollIntoViewIfNeeded();
    await longMethod.focus();
    await longMethod.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await page.screenshot({ path: `/tmp/service-rates-${runtime}-long-method.png` });
    const row = page.locator('[data-rate-method=getDoc]');
    await expect(row.locator('[data-period-calls]')).toHaveText('151');
    expect(await calls(page, 'firestore', 'getDoc')).toBe(151);
  });
}
