import { test, expect } from '@playwright/test';

test('verify auth modal matches prototype and push notification button works', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', msg => logs.push(msg.type() + ': ' + msg.text()));
  page.on('pageerror', err => logs.push('PAGE ERROR: ' + err.message));

  await page.goto('http://127.0.0.1:5174');
  await page.waitForTimeout(1000);

  // 1. Verify Auth Modal opens and matches prototype title
  const accountBtn = page.locator('header button', { hasText: 'Alice' });
  await accountBtn.click();
  await page.waitForTimeout(500);

  const modalTitle = page.locator('#signin-modal h2');
  await expect(modalTitle).toHaveText('Account Authentication');

  // Verify prototype tabs exist
  await expect(page.locator('#auth-tab-btn-signin')).toHaveText('Sign In');
  await expect(page.locator('#auth-tab-btn-signup')).toHaveText('Create Account');

  // Verify demo account autofill links exist
  const aliceDemoLink = page.locator('#signin-modal button', { hasText: 'Alice (Owner)' });
  const bobDemoLink = page.locator('#signin-modal button', { hasText: 'Bob (Collaborator)' });
  await expect(aliceDemoLink).toBeVisible();
  await expect(bobDemoLink).toBeVisible();

  // Click Bob demo account link
  await bobDemoLink.click();
  await expect(page.locator('#signin-email')).toHaveValue('bob@example.com');

  // Click Sign In with Email button
  await page.locator('#signin-form button[type="submit"]').click();
  await page.waitForTimeout(1000);

  // Modal should be closed now
  await expect(page.locator('#signin-modal')).toBeHidden();

  // Verify header updated to Bob
  await expect(page.locator('header button', { hasText: 'Bob' })).toBeVisible();

  // 2. Verify FCM Push button works
  const fcmBtn = page.locator('#pill-push');
  await expect(fcmBtn).toHaveAttribute('title', 'FCM Push: Off (Click to enable)');
  await fcmBtn.click();
  await page.waitForTimeout(1500);

  // FCM button should now be active
  await expect(fcmBtn).toHaveAttribute('title', 'FCM Push: Active (Click to revoke)');
  await expect(fcmBtn).toHaveText('FCM');

  // 3. Verify Google OAuth button works without AuthFlowResolver error
  await page.locator('header button', { hasText: 'Bob' }).click();
  await page.waitForTimeout(500);
  await page.locator('#signin-modal button', { hasText: 'Google' }).click();
  await page.waitForTimeout(1000);
  await expect(page.locator('header button', { hasText: 'Google Demo User' })).toBeVisible();

  console.log('--- ALL ASSERTIONS PASSED ---');
});
