import { test, expect } from '@playwright/test';

test('Pyric runtime chip authentic identity switching, creation, and forced onAuthStateChanged', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));

  await page.goto('/');

  // 1. Initial State: page's onAuthStateChanged must fire with signed-out
  await expect(page.locator('#status')).toHaveText('signed-out', { timeout: 15_000 });

  const initialLog = await page.evaluate(() => (window as unknown as { __authLog: (string | null)[] }).__authLog);
  expect(initialLog).toEqual([null]);
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __namedAuthLog: (string | null)[] }
  ).__namedAuthLog)).toEqual([null]);

  // Verify exactly 1 runtime chip is mounted on the page
  const chipHost = page.locator('[data-pyric-runtime-chip-host]');
  await expect(chipHost).toBeAttached();
  const chipCount = await page.locator('[data-pyric-runtime-chip-host]').count();
  expect(chipCount).toBe(1);

  // A deleted named app must release its Auth handle before chip fan-out.
  await page.evaluate(() => (
    window as unknown as { __registerThenDeleteNamedAuth: () => Promise<void> }
  ).__registerThenDeleteNamedAuth());

  // Verify no unauthorized button-primary styling exists
  await expect(chipHost.locator('.button-primary')).toHaveCount(0);

  const openImpersonateDialog = async () => {
    const openBar = chipHost.locator('[data-expand]');
    if (await openBar.isVisible()) {
      await openBar.click();
    }
    await chipHost.locator('[data-open-impersonate]').click();
  };

  // 2. Open Chip and click [+ Create New User] to verify existing Auth Helper opens
  await openImpersonateDialog();

  const chipDialog = chipHost.locator('dialog[data-impersonate-dialog]');
  await expect(chipDialog).toBeVisible();

  await chipDialog.locator('[data-action-create-user]').click();
  await expect(chipDialog).not.toBeVisible();

  // The existing Auth Helper dialog opens
  const authHelperDialog = page.locator('dialog[data-pyric-auth]');
  await expect(authHelperDialog).toBeVisible();

  // Verify dialog is centered in the viewport (immune to CSS resets)
  const dialogBox = await authHelperDialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(dialogBox).not.toBeNull();
  const centerX = dialogBox!.x + dialogBox!.width / 2;
  const centerY = dialogBox!.y + dialogBox!.height / 2;
  expect(Math.abs(centerX - viewport.width / 2)).toBeLessThan(25);
  expect(Math.abs(centerY - viewport.height / 2)).toBeLessThan(50);

  // Create User 1: Alice
  await authHelperDialog.locator('input[type="email"]').fill('alice@example.com');
  await authHelperDialog.locator('input[placeholder="Display name (optional)"]').fill('Alice Developer');
  await authHelperDialog.locator('button.submit').click();

  // Client onAuthStateChanged MUST fire with Alice without reload
  await expect(page.locator('#status')).toHaveText(/^signed-in:/, { timeout: 10_000 });
  const aliceStatus = await page.locator('#status').textContent();
  const aliceUid = aliceStatus?.replace('signed-in:', '');
  expect(aliceUid).toBeTruthy();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __namedAuthLog: (string | null)[] }
  ).__namedAuthLog.at(-1))).toBe(aliceUid);

  // Collapsed bar badge displays Alice's identity
  const collapseBtn = chipHost.locator('[data-collapse]');
  if (await collapseBtn.isVisible()) {
    await collapseBtn.click();
  }
  await expect(chipHost.locator('[data-identity-badge]')).toHaveText(`as: ${aliceUid}`);

  // Create User 2: Bob
  await openImpersonateDialog();
  await chipHost.locator('dialog[data-impersonate-dialog] [data-action-create-user]').click();

  await expect(authHelperDialog).toBeVisible();
  await authHelperDialog.locator('input[type="email"]').fill('bob@example.com');
  await authHelperDialog.locator('input[placeholder="Display name (optional)"]').fill('Bob Hacker');
  await authHelperDialog.locator('button.submit').click();

  // Wait for status to switch to Bob
  await expect(page.locator('#status')).not.toHaveText(`signed-in:${aliceUid}`, { timeout: 10_000 });
  await expect(page.locator('#status')).toHaveText(/^signed-in:/);
  const bobStatus = await page.locator('#status').textContent();
  const bobUid = bobStatus?.replace('signed-in:', '');
  expect(bobUid).not.toEqual(aliceUid);
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __namedAuthLog: (string | null)[] }
  ).__namedAuthLog.at(-1))).toBe(bobUid);

  // 3. Switch back to Alice via User Search Combobox
  await openImpersonateDialog();
  await expect(chipDialog).toBeVisible();

  // Verify listbox is visible and both users are listed by default under "All" without typing
  const listbox = chipDialog.locator('[data-user-search-listbox]');
  await expect(listbox).toBeVisible();
  await expect(chipDialog.locator('.user-search-item:has-text("Alice Developer")')).toBeVisible();
  await expect(chipDialog.locator('.user-search-item:has-text("Bob Hacker")')).toBeVisible();

  // Loading a directory with many provider categories must not grow the
  // permanently mounted filter row or shift the fixed-height dialog.
  const filterRow = chipDialog.locator('.filter-chips');
  const filterHeightBefore = await filterRow.evaluate((element) => element.getBoundingClientRect().height);
  await chipDialog.locator('[data-close-impersonate]').click();
  await page.evaluate(async (providerIds) => {
    const generation = localStorage.getItem('pyric:worker-generation');
    const worker = new SharedWorker('/__pyric/sdk/worker.js', {
      type: 'classic',
      name: generation ? `pyric-shared-worker:${generation}` : 'pyric-shared-worker',
    });
    worker.port.start();
    for (const [index, providerId] of providerIds.entries()) {
      await new Promise<void>((resolve, reject) => {
        const id = `seed-provider-${index}-${Date.now()}`;
        const onMessage = (event: MessageEvent) => {
          if (event.data?.t !== 'res' || event.data.id !== id) return;
          worker.port.removeEventListener('message', onMessage);
          if (event.data.ok) resolve();
          else reject(new Error(event.data.error.message));
        };
        worker.port.addEventListener('message', onMessage);
        worker.port.postMessage({
          t: 'op',
          id,
          method: 'auth.adminCreateUser',
          request: {
            email: `provider-${index}@example.com`,
            providerUserInfo: [{ providerId }],
          },
        });
      });
    }
    worker.port.close();
  }, ['google.com', 'github.com', 'facebook.com', 'apple.com', 'microsoft.com', 'twitter.com']);
  await openImpersonateDialog();
  await expect(chipDialog.locator('.filter-chip:has-text("twitter.com")')).toBeVisible();
  const filterGeometryAfter = await filterRow.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(filterGeometryAfter.height).toBe(filterHeightBefore);
  expect(filterGeometryAfter.scrollWidth).toBeGreaterThan(filterGeometryAfter.clientWidth);

  const searchInput = chipDialog.locator('[data-user-search-input]');
  await searchInput.fill('Alice');

  const aliceCandidate = chipDialog.locator('.user-search-item:has-text("Alice Developer")');
  await expect(aliceCandidate).toBeVisible();
  await aliceCandidate.click();

  // Client onAuthStateChanged MUST fire directly with Alice (A -> B direct transition)
  await expect(page.locator('#status')).toHaveText(`signed-in:${aliceUid}`, { timeout: 10_000 });

  const authLogAfterSwitch = await page.evaluate(() => (window as unknown as { __authLog: (string | null)[] }).__authLog);
  // Verify direct switch from Bob -> Alice: no intermediate null between bobUid and aliceUid!
  const lastTwo = authLogAfterSwitch.slice(-2);
  expect(lastTwo).toEqual([bobUid, aliceUid]);
  const namedLogAfterSwitch = await page.evaluate(() => (
    window as unknown as { __namedAuthLog: (string | null)[] }
  ).__namedAuthLog);
  const namedBobIndex = namedLogAfterSwitch.lastIndexOf(bobUid!);
  expect(namedBobIndex).toBeGreaterThanOrEqual(0);
  expect(namedLogAfterSwitch.slice(namedBobIndex + 1)).not.toContain(null);
  expect(namedLogAfterSwitch.at(-1)).toBe(aliceUid);

  // 4. Sign Out via chip modal
  await openImpersonateDialog();
  await expect(chipDialog).toBeVisible();

  await chipDialog.locator('[data-action-signout]').click();
  await expect(page.locator('#status')).toHaveText('signed-out', { timeout: 10_000 });
  await expect(chipHost.locator('[data-identity-badge]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __namedAuthLog: (string | null)[] }
  ).__namedAuthLog.at(-1))).toBeNull();

  // 5. Toggle Rules Bypass (Admin)
  await openImpersonateDialog();
  await expect(chipDialog).toBeVisible();

  await chipDialog.locator('[data-action-toggle-admin]').click();
  await chipDialog.locator('[data-close-impersonate]').click();

  // Minimize panel to check collapsed bar
  const closeBtn = chipHost.locator('[data-collapse]');
  if (await closeBtn.isVisible()) {
    await closeBtn.click();
  }
  await expect(chipHost.locator('[data-identity-badge]')).toHaveText('bypass rules');
});
