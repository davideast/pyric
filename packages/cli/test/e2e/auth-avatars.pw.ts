import { test, expect } from '@playwright/test';

// Coverage for docs/auth-avatars-design.md: served-mode default profile
// photos for sandbox provider users. Runs against the shared fixture serve
// (avatars enabled, zero-config — the default `pyric sandbox` resolves).
//
// Provider enable is the same worker call auth-popup.pw.ts uses (Studio's
// provider toggle, driven directly so this file doesn't depend on Studio UI).
async function enableGoogleProvider(page: import('@playwright/test').Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const generation = localStorage.getItem('pyric:worker-generation');
    const worker = new SharedWorker('/__pyric/sdk/worker.js', {
      type: 'classic',
      name: generation ? `pyric-shared-worker:${generation}` : 'pyric-shared-worker',
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
}

test('Google popup sign-in mints a served avatar URL that renders and survives reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('signed-out', { timeout: 15_000 });

  await enableGoogleProvider(page);

  await page.locator('#signin').click();
  const dialog = page.locator('dialog[data-pyric-auth]');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="email"]').fill('erin@example.com');
  await dialog.locator('input[placeholder="Display name (optional)"]').fill('Erin');
  await dialog.locator('button.submit').click();

  await expect(page.locator('#status')).toHaveText(/^signed-in:/, { timeout: 10_000 });
  const status = await page.locator('#status').textContent();
  const uid = status?.replace('signed-in:', '');
  expect(uid).toBeTruthy();

  // THE ASSERTION under test: photoURL is the served avatar route, keyed to
  // this uid, carrying the resolution seed as `d`.
  const photoURL = await page.evaluate(() => (window as unknown as { __photoURL: string | null }).__photoURL);
  expect(photoURL).toMatch(/^\/__pyric\/assets\/avatar\/[^/?]+\?/);
  const url = new URL(photoURL!, 'http://localhost');
  expect(decodeURIComponent(url.pathname)).toBe(`/__pyric/assets/avatar/${uid}`);
  expect(url.searchParams.get('d')).toBeTruthy();

  // The <img> bound to it in fixture/main.js actually decodes pixels.
  const avatar = page.locator('#avatar');
  await expect(avatar).toHaveJSProperty('src', new URL(photoURL!, page.url()).href);
  await page.waitForFunction(() => {
    const img = document.getElementById('avatar') as HTMLImageElement | null;
    return !!img && img.complete && img.naturalWidth > 0;
  });

  // A direct fetch (no cookies, no capability token — img elements can't
  // attach either) returns the generated SVG.
  const response = await page.request.get(photoURL!);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/svg+xml');
  const body = await response.text();
  expect(body).toContain('<svg');

  // Reload: the sandbox session persists across reload (IndexedDB), and the
  // restored user carries the identical photoURL — never a transient null.
  await page.reload();
  await expect(page.locator('#status')).toHaveText(`signed-in:${uid}`, { timeout: 15_000 });
  const photoURLAfterReload = await page.evaluate(() => (
    window as unknown as { __photoURL: string | null }
  ).__photoURL);
  expect(photoURLAfterReload).toBe(photoURL);
  await page.waitForFunction(() => {
    const img = document.getElementById('avatar') as HTMLImageElement | null;
    return !!img && img.complete && img.naturalWidth > 0;
  });
});

test('email/password creation leaves photoURL null (Firebase-null fidelity)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('signed-out', { timeout: 15_000 });

  // The Identity view's create row mints a `password`-provider identity
  // (ServeAuthHelper.promptCreateUser's default), the same non-federated path
  // createUserWithEmailAndPassword takes in production — it must NOT get a
  // default avatar (see mintsDefaultPhoto in sandbox-backend.ts: only a
  // provider id containing "." qualifies).
  const chipHost = page.locator('[data-pyric-runtime-chip-host]');
  await expect(chipHost).toBeAttached();
  const openBar = chipHost.locator('[data-expand]');
  if (await openBar.isVisible()) {
    await openBar.click();
  }
  await chipHost.locator('[data-chip-tab="identity"]').click();
  await chipHost.locator('[data-identity-query]').fill('frank@example.com');
  await chipHost.locator('[data-create-user]').click();

  const authHelperDialog = page.locator('dialog[data-pyric-auth]');
  await expect(authHelperDialog).toBeVisible();
  await authHelperDialog.locator('input[type="email"]').fill('frank@example.com');
  await authHelperDialog.locator('input[placeholder="Display name (optional)"]').fill('Frank');
  await authHelperDialog.locator('button.submit').click();

  await expect(page.locator('#status')).toHaveText(/^signed-in:/, { timeout: 10_000 });

  const photoURL = await page.evaluate(() => (window as unknown as { __photoURL: string | null }).__photoURL);
  expect(photoURL).toBeNull();

  const avatarSrc = await page.locator('#avatar').evaluate((el) => (el as HTMLImageElement).getAttribute('src'));
  expect(avatarSrc).toBe('');
});
