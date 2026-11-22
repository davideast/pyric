// On a served page forced onto the in-page runtime (`__PYRIC_FORCE_INPAGE__`),
// `signInWithPopup(getAuth(app), new GoogleAuthProvider())` must open the
// Pyric sign-in dialog and sign in the typed or picked account, while still
// honoring one-shot `sandbox.mockSignInResult` ahead of the dialog and
// resolving `linkWithPopup` through the same dialog (#1802).
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario, type App } from '../driver.ts';

interface PopupSignInReport {
  uid: string;
  currentUid: string | null;
  sameUserRef: boolean;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
  photoURL: string | null;
  signInProvider: string | null;
}

interface StagedPopupReport {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

interface LinkedPopupReport {
  uid: string;
  providers: string[];
}

declare function signInGooglePopup(): Promise<PopupSignInReport>;
declare function signInStagedMockPopup(): Promise<StagedPopupReport>;
declare function startAnonymousForLink(): Promise<string>;
declare function linkGithubPopup(): Promise<LinkedPopupReport>;
declare function signOutUser(): Promise<void>;

const BANNER = '[pyric sandbox] firebase/* on this page is served by the Pyric sandbox';
const EMAIL = 'ada@example.com';

async function openForcedInPage(app: App, url: string): Promise<Page> {
  const browser = await app.browser();
  const page = await browser.newPage();
  const log = app.browserLog as string[];
  page.on('console', (message) => log.push(`[in-page console.${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => log.push(`[in-page error] ${error.stack ?? error.message}`));
  await page.addInitScript(() => {
    (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true;
  });
  const banner = page.waitForEvent('console', {
    predicate: (message) => message.text().startsWith(BANNER),
    timeout: 30_000,
  });
  await page.goto(url);
  const bannerText = (await banner).text();
  assert.doesNotMatch(bannerText, /SharedWorker|on the dev server/, bannerText);
  await page.waitForFunction(() => 'signInGooglePopup' in window);
  return page;
}

export default scenario(async (app) => {
  const server = await app.step('start the dev server', () => app.devServer());
  const origin = new URL(server.url).origin;
  const avatarPrefix = `${origin}/__pyric/assets/avatar/`;

  const page = await app.step('open served page forced onto the in-page runtime', () =>
    openForcedInPage(app, server.url));

  const typed = await app.step('signInWithPopup opens the Google dialog and signs in a typed account', async () => {
    const pending = page.evaluate(() => signInGooglePopup());
    const dialog = page.locator('dialog[data-pyric-auth][open]');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.locator('input[type="email"]').fill(EMAIL);
    await dialog.locator('input[placeholder="Display name (optional)"]').fill('Ada');
    await dialog.locator('button.submit').click();
    return pending;
  });

  await app.step('typed Google account is signed in on getAuth(app) with verified email and served avatar URL', () => {
    assert.equal(typed.currentUid, typed.uid);
    assert.equal(typed.sameUserRef, true);
    assert.equal(typed.email, EMAIL);
    assert.equal(typed.displayName, 'Ada');
    assert.equal(typed.emailVerified, true);
    assert.equal(typed.signInProvider, 'google.com');
    assert.ok(typed.photoURL !== null && typed.photoURL.startsWith(avatarPrefix), `expected served avatar photoURL, got ${String(typed.photoURL)}`);
  });

  await app.step('signing out and picking the existing account from the dialog signs in the same uid', async () => {
    await page.evaluate(() => signOutUser());
    const pending = page.evaluate(() => signInGooglePopup());
    const dialog = page.locator('dialog[data-pyric-auth][open]');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.locator('.ids button', { hasText: EMAIL }).click();
    const picked = await pending;
    assert.equal(picked.uid, typed.uid);
    assert.equal(picked.currentUid, typed.uid);
    assert.equal(picked.signInProvider, 'google.com');
    await page.evaluate(() => signOutUser());
  });

  await app.step('sandbox.mockSignInResult still takes precedence over the dialog on the forced-in-page page', async () => {
    const staged = await page.evaluate(() => signInStagedMockPopup());
    assert.deepEqual(staged, {
      uid: 'staged-popup-user',
      email: 'staged@example.com',
      emailVerified: false,
    });
    await page.evaluate(() => signOutUser());
  });

  await app.step('linkWithPopup opens the dialog and links onto the signed-in user in-page', async () => {
    const anonUid = await page.evaluate(() => startAnonymousForLink());
    const pending = page.evaluate(() => linkGithubPopup());
    const dialog = page.locator('dialog[data-pyric-auth][open]');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.locator('input[type="email"]').fill('gh@example.com');
    await dialog.locator('button.submit').click();
    const linked = await pending;
    assert.equal(linked.uid, anonUid);
    assert.deepEqual(linked.providers, ['github.com']);
    await page.close();
  });
});
