import { test, expect } from '@playwright/test';
import { startSdkFlowServer } from '../../../../examples/runtime-flow-lab/sdk-server.mts';

let server: Awaited<ReturnType<typeof startSdkFlowServer>>;
test.beforeAll(async () => { server = await startSdkFlowServer(); });
test.afterAll(async () => { await server.close(); });

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: real SDK reads and listeners render into the same component and unmapped activity stays visible`, async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await page.getByRole('tab', { name: 'Listeners' }).click();
    const panel = page.locator('[data-component=DataPanel]');
    const rows = page.locator('[data-listener-row]');
    for (const read of ['document', 'query', 'database']) {
      const previousId = await panel.getAttribute('data-pyric-flow-listener');
      await page.locator(`[data-read=${read}]`).click();
      await expect(panel).toHaveAttribute('data-pyric-flow');
      await expect.poll(() => panel.getAttribute('data-pyric-flow-listener')).not.toBe(previousId);
      const id = await panel.getAttribute('data-pyric-flow-listener');
      await expect(page.locator(`[data-listener-row="${id}"]`)).toContainText('completed / Rendered after delivery');
    }
    await expect(rows).toHaveCount(3);
    await page.locator('[data-listen]').click();
    await expect(rows).toHaveCount(5);
    await page.locator('[data-write]').click();
    await expect(page.locator('[data-result]')).toContainText('version":2');
    const id = await panel.getAttribute('data-pyric-flow-listener');
    await expect(page.locator(`[data-listener-row="${id}"]`)).toContainText('active / Rendered after delivery');
    // Stop both registrations, then wait beyond the existing correlation window.
    await page.locator('[data-listen]').click();
    await expect(rows.filter({ hasText: '/ closed' })).toHaveCount(2);
    await page.waitForTimeout(300);
    const before = await page.locator('[data-result]').textContent();
    await page.locator('[data-unmapped]').click();
    await expect(rows).toHaveCount(6);
    await expect(rows.filter({ hasText: 'completed / No associated visual update' })).toHaveCount(1);
    await expect(page.locator('[data-result]')).toHaveText(before!);
    await page.locator('[data-denied]').click();
    await expect(rows).toHaveCount(7);
    await expect(rows.filter({ hasText: 'failed / No associated visual update' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'failed' }).locator('.listener-fact strong')).toHaveText('0');
    await page.locator('[data-flow-treatment]').selectOption('corners');
    await expect(page.locator('html')).toHaveAttribute('data-pyric-treatment', 'corners');
    await expect(panel).toHaveCSS('outline-width', '0px');
    await page.locator('[data-flow-treatment]').selectOption('outline');
    await expect(panel).toHaveCSS('outline-width', '2px');
    await page.screenshot({ path: `/tmp/sdk-flow-final-${runtime}.png`, fullPage: true });
    // Verify actual runtime retention, not just the journal's unit-test clock.
    await expect(rows).toHaveCount(0, { timeout: 35_000 });
    await expect(panel).not.toHaveAttribute('data-pyric-flow');
    expect(errors).toEqual([]);
  });
}
