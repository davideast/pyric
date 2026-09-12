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

  const identityQuery = chipHost.locator('[data-identity-query]');
  /** Open the panel on Identity, whichever view the opening rule chose. */
  const openIdentityView = async () => {
    const openBar = chipHost.locator('[data-expand]');
    if (await openBar.isVisible()) {
      await openBar.click();
    }
    await chipHost.locator('[data-chip-tab="identity"]').click();
    await expect(identityQuery).toBeVisible();
  };
  const minimize = async () => {
    const collapseBtn = chipHost.locator('[data-collapse]');
    if (await collapseBtn.isVisible()) {
      await collapseBtn.click();
    }
  };

  // 2. Type an address nobody answers to, and take the create row the view offers
  await openIdentityView();
  await identityQuery.fill('alice@example.com');
  await chipHost.locator('[data-create-user]').click();

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

  // The session row names Alice by display name, with her email in the sub-row and her uid as its title
  await openIdentityView();
  await expect(chipHost.locator('[data-identity-row] .c1')).toHaveText('Alice Developer');
  await expect(chipHost.locator('[data-identity-row] .s1')).toContainText('alice@example.com');
  await expect(chipHost.locator('[data-identity-row]')).toHaveAttribute('title', aliceUid!);

  // The collapsed pill is the word alone
  await minimize();
  await expect(chipHost.locator('.chip')).toHaveText('pyric');

  // Create User 2: Bob
  await openIdentityView();
  await identityQuery.fill('bob@example.com');
  await chipHost.locator('[data-create-user]').click();

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

  // 3. Switch back to Alice from the row the typed query selects
  await openIdentityView();
  await identityQuery.fill('Alice');
  const aliceRow = chipHost.locator(`[data-switch-user="${aliceUid}"]`);
  await expect(aliceRow).toBeVisible();
  await expect(aliceRow.locator('.c1')).toHaveText('Alice Developer');
  // The session already showing is never offered as somewhere to switch to.
  await expect(chipHost.locator(`[data-switch-user="${bobUid}"]`)).toHaveCount(0);
  await aliceRow.click();

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

  // The switch clears the query, and the session is never offered as a switch
  await expect(identityQuery).toHaveValue('');
  await expect(chipHost.locator(`[data-switch-user="${aliceUid}"]`)).toHaveCount(0);

  // 4. Sign out from the session row itself
  await chipHost.locator('[data-sign-out]').click();
  await expect(page.locator('#status')).toHaveText('signed-out', { timeout: 10_000 });
  await expect(chipHost.locator('[data-identity-row] .c1')).toHaveText('Signed out');
  await expect(chipHost.locator('[data-sign-out]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __namedAuthLog: (string | null)[] }
  ).__namedAuthLog.at(-1))).toBeNull();

  // 5. Toggle the rules bypass from its own row
  const bypass = chipHost.locator('[data-toggle-bypass]');
  await expect(bypass).toHaveAttribute('aria-pressed', 'false');
  await bypass.click();
  await expect(bypass).toHaveAttribute('aria-pressed', 'true');

  // Minimize: the pill is still the word alone
  await minimize();
  await expect(chipHost.locator('.chip')).toHaveText('pyric');
});
