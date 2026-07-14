import { test, expect } from '@playwright/test';

// Repro: served-mode (SharedWorker) Google popup sign-in. The worker seeds + signs
// in, but the bug report is that the page's onAuthStateChanged never fires.
test('Google popup sign-in fires onAuthStateChanged with the user', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));

  await page.goto('/');

  // The initial onAuthStateChanged must fire (signed-out) — proves the sub works.
  await expect(page.locator('#status')).toHaveText('signed-out', { timeout: 15_000 });

  // OAuth providers are disabled by default. Enable Google on the authoritative
  // worker backend (the same control operation Studio's provider toggle uses).
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const worker = new SharedWorker('/__pyric/sdk/worker.js', {
      type: 'classic',
      name: 'pyric-shared-worker',
    });
    const id = `enable-google-${Date.now()}`;
    worker.port.onmessage = (event) => {
      if (event.data?.t !== 'res' || event.data.id !== id) return;
      worker.port.close();
      if (event.data.ok) resolve();
      else reject(Object.assign(new Error(event.data.error.message), event.data.error));
    };
    worker.port.start();
    worker.port.postMessage({
      t: 'op',
      id,
      method: 'auth.setProviderConfig',
      providerId: 'google.com',
      enabled: true,
    });
  }));

  // Open the helper + add a Google test account.
  await page.locator('#signin').click();
  const dialog = page.locator('dialog[data-pyric-auth]');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="email"]').fill('david@example.com');
  await dialog.locator('input[placeholder="Display name (optional)"]').fill('David');
  await dialog.locator('button.submit').click();

  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.startsWith('signed-in:')
    || (window as unknown as { __authError: unknown }).__authError !== null,
  );
  const authError = await page.evaluate(() =>
    (window as unknown as { __authError: { code?: string; message?: string } | null }).__authError,
  );
  expect(authError).toBeNull();

  // THE ASSERTION under test: onAuthStateChanged must now fire with the user.
  // If the bug reproduces, this times out (status stays "signed-out").
  await expect(page.locator('#status')).toHaveText(/^signed-in:/, { timeout: 10_000 });

  const authLog = await page.evaluate(() => (window as unknown as { __authLog: (string | null)[] }).__authLog);
  console.log('onAuthStateChanged fires (uid|null):', JSON.stringify(authLog));
  expect(authLog.some((u) => u !== null)).toBe(true);
});
