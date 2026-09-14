import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.FLOW_LAB_URL ?? 'http://localhost:5197');
  await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
  await page.getByRole('button', { name: 'Rates', exact: true }).click();
  await page.getByRole('button', { name: 'Run a burst', exact: true }).click();
  const firestore = page.locator('[data-rate-service=firestore]');
  const rtdb = page.locator('[data-rate-service=rtdb]');
  await expect.poll(async () => Number(await firestore.locator('[data-usage=documentReads]').textContent())).toBeGreaterThan(0);
  await expect.poll(async () => Number(await firestore.locator('[data-usage=documentWrites]').textContent())).toBeGreaterThan(0);
  await expect.poll(async () => parseFloat(await rtdb.locator('[data-usage=payloadBytes]').textContent())).toBeGreaterThan(0);
  for (const key of ['reads', 'writes', 'deliveries']) {
    await expect.poll(async () => Number(await rtdb.locator(`[data-usage=${key}]`).textContent())).toBeGreaterThan(0);
  }
  await expect(rtdb.locator('[data-usage=excluded]')).toHaveText('Not measured');
  await expect(page.locator('#burst')).toBeEnabled();
  await expect(page.locator('[data-component=MessageList]')).toContainText('This update belongs to the conversation only.');
  await expect(page.locator('[data-component=ReadReceipt]')).toContainText('receipt 1');
  const writes = await page.evaluate(() => {
    const rates = globalThis[Symbol.for('pyric.sdk-rates')].snapshot();
    return Object.fromEntries(rates.services.map(service => [service.service,
      service.methods.filter(method => method.category === 'write')
        .reduce((total, method) => total + method.buckets.reduce((sum, bucket) => sum + bucket.calls, 0), 0),
    ]));
  });
  expect(writes.firestore).toBe(3);
  expect(writes.rtdb).toBe(2);
  await expect(firestore.locator('[data-usage=documentReads]')).toHaveText('0', { timeout: 8000 });
  await expect(firestore.locator('[data-usage=documentWrites]')).toHaveText('0', { timeout: 8000 });
  await expect(rtdb.locator('[data-usage=payloadBytes]')).toHaveText('0 B/s', { timeout: 8000 });
  for (const key of ['reads', 'writes', 'deliveries']) await expect(rtdb.locator(`[data-usage=${key}]`)).toHaveText('0');
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(page.locator('#delivery-status')).toContainText('Read 5 messages.');
  await expect(firestore.locator('[data-usage=documentReads]')).toHaveText('1');
  await expect(firestore.locator('[data-usage=documentWrites]')).toHaveText('0');
  await expect.poll(async () => parseFloat(await rtdb.locator('[data-usage=payloadBytes]').textContent())).toBeGreaterThan(0);
  await page.screenshot({ path: '/tmp/usage-overview.png' });
  await page.getByRole('button', { name: 'Firestore', exact: true }).click();
  await expect(page.getByRole('table', { name: 'SDK activity by method' })).toBeVisible();
  await expect(page.locator('.usage-coverage')).toContainText('Index scans');
  await expect(page.locator('.usage-coverage')).toContainText('transactions');
  await page.screenshot({ path: '/tmp/usage-detail.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('[data-rate-detail]').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/usage-mobile.png' });
  expect(errors).toEqual([]);
  console.log('PASS: document and payload usage, idle decay, five-document fetch, billing gaps and SDK drill-down.');
} finally {
  await browser.close();
}
