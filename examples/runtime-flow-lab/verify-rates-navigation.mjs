import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch();
try {
 for (const service of ['firestore', 'rtdb']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(`http://localhost:5197/?service=${service}`);
  await page.getByRole('button', { name: 'Minimize pyric', exact: true }).click();
  await page.locator('#rate-burst').click();
  await expect(page.locator('#rate-burst')).toBeEnabled({ timeout: 20000 });
  await page.getByRole('button', { name: 'Open pyric', exact: true }).click();
  await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
  await page.getByRole('button', { name: 'Rates', exact: true }).click();
  await expect(page.locator('.rate-service-list')).toBeVisible();
  await expect(page.locator('[data-rate-incident]')).toHaveCount(0);
  await page.screenshot({ path: `/tmp/rates-list-${service}.png` });
  await page.locator(`[data-rate-incidents=${service}]`).click();
  await expect(page.locator('[data-rate-incident]')).toHaveCount(1);
  await page.locator('[data-rate-incident]').click();
  await expect(page.locator('[data-history-chart]')).toBeVisible();
  await expect(page.locator('[data-rate-incident]')).toHaveCount(0);
  await expect(page.locator('.rate-scope table')).toHaveCount(1);
  await expect(page.locator('[data-rate-method]')).toHaveCount(0);
  await expect(page.locator('[data-capture-export]')).toBeHidden();
  const menu = page.getByRole('button', { name: 'More actions', exact: true });
  await menu.click();
  await expect(page.getByRole('button', { name: 'Save capture…', exact: true })).toBeVisible();
  await page.screenshot({ path: `/tmp/rates-menu-${service}.png` });
  await page.getByRole('button', { name: 'Thresholds…', exact: true }).click();
  await expect(page.locator('[data-threshold-input=sustainedSeconds]')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await menu.click();
  await page.getByRole('button', { name: 'Measurements', exact: true }).click();
  await expect(page.locator('.rate-menu')).not.toHaveAttribute('open', '');
  await expect(page.locator('[data-rate-method]')).not.toHaveCount(0);
  await expect(page.locator('[data-history-chart]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to activity', exact: true }).click();
  await page.getByRole('button', { name: 'Resume live', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  for (const width of [1440, 390]) {
   await page.setViewportSize({ width, height: 1100 });
   await page.locator('[data-history-chart]').scrollIntoViewIfNeeded();
   await page.screenshot({ path: `/tmp/rates-chart-${service}-${width}.png` });
   expect(await page.locator('.traffic-toolbar').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
  }
  console.log('PASS compact service list, separate incidents, focused chart, menu and measurements', service);
  await page.close();
 }
} finally { await browser.close(); }
