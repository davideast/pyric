import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  for (const service of ['firestore', 'rtdb']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.goto(`http://localhost:5197/?service=${service}`);
    await page.getByRole('button', { name: 'Minimize pyric', exact: true }).click();
    for (const scenario of ['firestore-denial', 'rtdb-denial', 'firestore-index', 'rtdb-index']) {
      await page.locator(`[data-scenario=${scenario}]`).click();
      await expect(page.locator('#scenario-status')).toContainText(scenario.endsWith('denial') ? 'write denied' : 'missing');
      console.log(service, scenario, await page.locator('#scenario-status').textContent());
    }
    await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
    await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
    await expect(page.locator('[data-traffic-rows]')).toContainText('scenario-denials/negative-budget');
    await expect(page.locator('[data-traffic-rows]')).toContainText('scenarioDenials/negative-budget');
    await expect(page.locator('[data-traffic-rows]')).not.toContainText('signed out');
    await expect(page.locator('[data-traffic-rows]')).toContainText('Index');
    await page.screenshot({ path: `/tmp/scenarios-${service}.png` });
    await page.setViewportSize({ width: 390, height: 1100 });
    await page.getByRole('button', { name: 'Minimize pyric', exact: true }).click();
    await page.locator('.scenario-buttons').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/scenarios-${service}-mobile.png` });
    expect(await page.locator('.scenario-buttons').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
    await page.close();
    const ratePage = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await ratePage.goto(`http://localhost:5197/?service=${service}`);
    await ratePage.getByRole('button', { name: 'Minimize pyric', exact: true }).click();
    await ratePage.getByRole('button', { name: 'Test rate warning', exact: true }).click();
    await expect(ratePage.locator('.chip.warning')).toBeVisible({ timeout: 20000 });
    await ratePage.getByRole('button', { name: 'Open pyric', exact: true }).click();
    await expect(ratePage.locator('[data-rate-incident]')).toContainText(service === 'firestore' ? 'Document writes' : 'Writes');
    await expect(ratePage.locator('#rate-burst')).toBeEnabled({ timeout: 15000 });
    await ratePage.close();
  }
} finally { await browser.close(); }
