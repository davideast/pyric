import { test, expect } from '@playwright/test';

test('capture full-page screenshot of site-docs root page', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Wait for critical UI components to be fully rendered
  await page.waitForSelector('h1');
  await expect(page.locator('h1')).toBeVisible();
  await page.waitForSelector('main.sheet');
  await expect(page.locator('main.sheet')).toBeVisible();

  // Capture full-page screenshot
  await page.screenshot({
    path: 'screenshots/site-docs-root.png',
    fullPage: true,
  });
});
