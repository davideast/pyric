import { test, expect } from '@playwright/test';

// Repro: served-mode (SharedWorker) Google popup sign-in. The worker seeds + signs
// in, but the bug report is that the page's onAuthStateChanged never fires.
test('Google popup sign-in fires onAuthStateChanged with the user', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));

  await page.goto('/');

  // The initial onAuthStateChanged must fire (signed-out) — proves the sub works.
  await expect(page.locator('#status')).toHaveText('signed-out', { timeout: 15_000 });

  // Open the helper + add a Google test account.
  await page.locator('#signin').click();
  const dialog = page.locator('dialog[data-pyric-auth]');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="email"]').fill('david@example.com');
  await dialog.locator('input[placeholder="Display name (optional)"]').fill('David');
  await dialog.locator('button.submit').click();

  // THE ASSERTION under test: onAuthStateChanged must now fire with the user.
  // If the bug reproduces, this times out (status stays "signed-out").
  await expect(page.locator('#status')).toHaveText(/^signed-in:/, { timeout: 10_000 });

  const authLog = await page.evaluate(() => (window as unknown as { __authLog: (string | null)[] }).__authLog);
  console.log('onAuthStateChanged fires (uid|null):', JSON.stringify(authLog));
  expect(authLog.some((u) => u !== null)).toBe(true);
});
