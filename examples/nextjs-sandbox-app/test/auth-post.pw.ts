import { test, expect } from '@playwright/test';

test('handles authentication and adding a post without errors from pyric', async ({ page }) => {
  const consoleMessages: string[] = [];
  const consoleErrors: string[] = [];

  page.on('console', (msg) => {
    const text = msg.text();
    console.log('[Browser Console]:', text);
    consoleMessages.push(text);
    if (msg.type() === 'error') {
      consoleErrors.push(text);
    }
  });

  const pageErrors: Error[] = [];
  page.on('pageerror', (err) => {
    console.log('[Browser PageError]:', err.message, err.stack);
    pageErrors.push(err);
  });

  await page.goto('/');

  await expect(page.locator('#auth-status')).toHaveText('Signed out', { timeout: 15_000 });
  await expect(page.locator('#api-status')).toContainText('Server-Side Admin API Runtime: pyric-sandbox (0 database records)', { timeout: 15_000 });

  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const workerGeneration = localStorage.getItem('pyric:worker-generation');
    const workerName = workerGeneration !== null ? `pyric-shared-worker:${workerGeneration}` : 'pyric-shared-worker';
    const worker = new SharedWorker('/__pyric/sdk/worker.js', {
      type: 'classic',
      name: workerName,
    });
    const operationId = `enable-google-${Date.now()}`;
    worker.port.onmessage = (event) => {
      const payload = event.data as { t?: string; id?: string; ok?: boolean; error?: { message?: string } };
      if (payload.t !== 'res' || payload.id !== operationId) {
        return;
      }
      worker.port.close();
      if (payload.ok === true) {
        resolve();
      } else {
        const errMessage = payload.error?.message !== undefined ? payload.error.message : 'Worker operation failed';
        reject(new Error(errMessage));
      }
    };
    worker.port.start();
    worker.port.postMessage({
      t: 'op',
      id: operationId,
      method: 'auth.setProviderConfig',
      providerId: 'google.com',
      enabled: true,
    });
  }));

  await page.locator('#sign-in-button').click();
  const pyricAuthDialog = page.locator('dialog[data-pyric-auth]');
  await expect(pyricAuthDialog).toBeVisible({ timeout: 10_000 });

  await pyricAuthDialog.locator('input[type="email"]').fill('ada@example.com');
  await pyricAuthDialog.locator('input[placeholder="Display name (optional)"]').fill('Ada Lovelace');
  await pyricAuthDialog.locator('button.submit').click();

  await expect(page.locator('#auth-status')).toHaveText('Signed in as Ada Lovelace', { timeout: 15_000 });
  await expect(pyricAuthDialog).toBeHidden();

  await page.locator('#post-title-input').fill('Hello Pyric Sandbox!');
  await page.locator('#submit-post-button').click();

  const postsListLocator = page.locator('#posts-list');
  await expect(postsListLocator).toBeVisible({ timeout: 10_000 });
  await expect(postsListLocator).toContainText('Hello Pyric Sandbox!');
  await expect(postsListLocator).toContainText('(by ');

  await expect(page.locator('#api-status')).toContainText('Server-Side Admin API Runtime: pyric-sandbox (1 database records)', { timeout: 15_000 });

  for (const errText of consoleErrors) {
    expect(errText).not.toContain('pyric');
    expect(errText).not.toContain('operation-not-allowed');
    expect(errText).not.toContain('permission-denied');
    expect(errText).not.toContain('500');
  }

  expect(pageErrors, `Unexpected page errors occurred: ${pageErrors.map((e) => e.message).join(', ')}`).toHaveLength(0);
});
