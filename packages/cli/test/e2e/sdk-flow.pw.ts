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

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: Scanner pass restarts for successive rendered reads`, async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await page.getByRole('tab', { name: 'Listeners' }).click();
    await page.locator('[data-flow-treatment]').selectOption('scan');
    await expect(page.locator('html')).toHaveAttribute('data-pyric-treatment', 'scan');
    await page.addStyleTag({ content: '@keyframes pyric-treatment-child { from { opacity: .9; } to { opacity: 1; } } [data-result] { animation: pyric-treatment-child 60s linear infinite; }' });

    await page.evaluate(() => {
      const state = window as typeof window & { scanStarts: number };
      state.scanStarts = 0;
      document.addEventListener('animationstart', event => {
        if (event.animationName === 'pyric-treatment-scan') state.scanStarts++;
      });
    });
    const panel = page.locator('[data-component=DataPanel]');
    await page.locator('[data-read=document]').click();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { scanStarts: number }).scanStarts)).toBe(1);
    const first = await panel.getAttribute('data-pyric-flow-listener');
    const childStart = await page.locator('[data-result]').evaluate(el => el.getAnimations()[0].startTime);
    await page.waitForTimeout(1600);
    await page.locator('[data-read=document]').click();
    await expect(page.locator('[data-result]')).toContainText('Document read #2');
    await expect.poll(() => panel.getAttribute('data-pyric-flow-listener')).not.toBe(first);
    await expect.poll(() => page.evaluate(() => (window as typeof window & { scanStarts: number }).scanStarts)).toBe(2);
    // Restart an in-flight scan too, without waiting for it to finish.
    await page.locator('[data-read=document]').click();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { scanStarts: number }).scanStarts)).toBe(3);
    expect(await page.locator('[data-result]').evaluate(el => el.getAnimations()[0].startTime)).toBe(childStart);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-read=query]').click();
    await expect.poll(() => panel.evaluate(el => getComputedStyle(el, '::before').animationName)).toBe('none');
    expect(await page.evaluate(() => (window as typeof window & { scanStarts: number }).scanStarts)).toBe(3);

  });
}
