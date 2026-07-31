import { test, expect } from '@playwright/test';

test('verify rule denials show exact line number and rule expression in ErrorBanner and Developer Console', async ({ page }) => {
  await page.goto('http://127.0.0.1:5174');
  await page.waitForTimeout(1000);

  // Sign out if signed in so we are unauthenticated (uid: null)
  const signOutBtn = page.locator('header button', { hasText: 'Sign Out' });
  if (await signOutBtn.isVisible()) {
    await signOutBtn.click();
    await page.waitForTimeout(500);
  }

  // Attempt to add a task while unauthenticated -> should trigger security rule denial
  await page.locator('input[placeholder="What needs to be done?"]').fill('Test unauthenticated denial');
  await page.locator('button', { hasText: 'Add Task' }).click();
  await page.waitForTimeout(1000);

  // Verify ErrorBanner shows Line number and rule expression (no longer 'Unknown Line' or 'N/A')
  const errorBanner = page.locator('#error-banner');
  await expect(errorBanner).toBeVisible();

  const bannerText = await errorBanner.textContent();
  console.log('ERROR BANNER TEXT:', bannerText);
  expect(bannerText).toContain('Line ');
  expect(bannerText).not.toContain('Unknown Line');
  expect(bannerText).not.toContain('N/A');

  // Open Developer Console modal and verify Recent Rule Denials shows Line number and expression
  await page.locator('header button', { hasText: 'Sandbox' }).click();
  await page.waitForTimeout(500);

  const consoleModal = page.locator('#inspector-modal');
  await expect(consoleModal).toBeVisible();

  const denialsSectionText = await consoleModal.locator('#inspector-denials-list').textContent();
  console.log('CONSOLE DENIALS TEXT:', denialsSectionText);
  expect(denialsSectionText).toContain('Line ');
  expect(denialsSectionText).not.toContain('Line ?:');

  console.log('--- ALL DENIAL LINE NUMBER ASSERTIONS PASSED ---');
});
