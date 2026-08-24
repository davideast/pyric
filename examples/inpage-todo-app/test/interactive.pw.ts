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

  // 3. Verify Google OAuth button opens Pluggable OAuth modal matching prototype UI
  await page.locator('header button', { hasText: 'Bob' }).click();
  await page.waitForTimeout(500);
  await page.locator('#signin-modal button', { hasText: 'Google' }).click();
  await page.waitForTimeout(1000);

  // Verify OAuth popup modal is visible
  const oauthModal = page.locator('#oauth-popup-modal');
  await expect(oauthModal).toBeVisible();
  await expect(oauthModal.locator('h3')).toHaveText('Sign in with Google');
  await expect(oauthModal.locator('p', { hasText: 'Sandbox OAuth Provider Console' })).toBeVisible();

  // Verify existing accounts (Alice and Bob) are listed in OAuth modal
  await expect(oauthModal.locator('#oauth-users-list')).toContainText('Alice');
  await expect(oauthModal.locator('#oauth-users-list')).toContainText('Bob');

  // Click "Select" on Alice in the OAuth modal
  const selectAliceBtn = oauthModal.locator('#oauth-users-list div', { hasText: 'alice@example.com' }).locator('button', { hasText: 'Select' });
  await selectAliceBtn.click();
  await page.waitForTimeout(1000);

  // Both modals should now be closed and header updated to Alice (Owner)
  await expect(oauthModal).toBeHidden();
  await expect(page.locator('#signin-modal')).toBeHidden();
  await expect(page.locator('header button', { hasText: 'Alice' })).toBeVisible();

  console.log('--- ALL ASSERTIONS PASSED ---');
});
