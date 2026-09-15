import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch();
try {
  await Promise.all(['firestore', 'rtdb'].map(async service => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.goto(`http://localhost:5197/?service=${service}`);
    await page.getByRole('button', { name: 'Minimize pyric', exact: true }).click();
    await page.locator('#rate-burst').click();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Open pyric', exact: true }).click({ delay: 200 });
    await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
    await page.getByRole('button', { name: 'Rates', exact: true }).click();
    await page.getByRole('button', { name: service === 'firestore' ? 'Firestore' : 'Realtime Database', exact: true }).click();
    await expect(page.locator('#rate-burst')).toBeEnabled({ timeout: 20000 });
    await page.waitForTimeout(Number(process.env.TIMELINE_AGE_MS ?? 5000));
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(page.locator('[data-timeline-window]')).toHaveText('10s view');
    const scrubber = page.getByRole('slider', { name: 'Timeline position', exact: true });
    await scrubber.focus(); await scrubber.press('Home');
    const early = await page.locator('[data-history-summary]').textContent();
    await expect(page.locator('[data-history-total=writes]')).not.toHaveText('0');
    await page.getByRole('button', { name: 'Resume live', exact: true }).click();
    await scrubber.focus(); await scrubber.press('Home');
    await expect(page.locator('[data-history-summary]')).toHaveText(early);
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await expect(page.locator('[data-timeline-window]')).toHaveText('20s view');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.locator('.history-timeline').scrollIntoViewIfNeeded();
      expect(await page.locator('.history-timeline').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
      await page.screenshot({ path: `/tmp/timeline-${service}-${width}.png` });
    }
    console.log('PASS timeline scrubbing, zoom and Live return', service);
    await page.close();
  }));
} finally { await browser.close(); }
