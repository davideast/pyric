// An app that gates on email_verified signs in through the sandbox's Google
// dialog. In production a Google sign-in gives `emailVerified: true` on the
// user and `email_verified: true` in the ID token, with
// `firebase.sign_in_provider: 'google.com'`. The app's rule reads
// `/allowlist/{email}` only when `request.auth.token.email_verified == true`,
// so a user typed into the dialog, and the same user picked from the account
// list on a second sign-in, must both read their entry. The SharedWorker page
// and a page on the Node host must agree.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario, type App } from '../driver.ts';

interface SignInReport {
  emailVerified: boolean;
  tokenEmailVerified: boolean | null;
  signInProvider: string | null;
  allowlistRead: string;
}

declare function signIn(): Promise<SignInReport>;
declare function signOutUser(): Promise<void>;

type Runtime = 'shared-worker' | 'in-page' | 'hosted';

const BANNER = '[pyric sandbox] firebase/* on this page is served by the Pyric sandbox';
const EMAIL = 'ada@example.com';

const EXPECTED: SignInReport = {
  emailVerified: true,
  tokenEmailVerified: true,
  signInProvider: 'google.com',
  allowlistRead: 'allowed',
};

async function openPage(app: App, url: string, runtime: Runtime): Promise<Page> {
  const page = await (await app.browser()).newPage();
  const log = app.browserLog as string[];
  page.on('console', (message) => log.push(`[${runtime} page console.${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => log.push(`[${runtime} page error] ${error.stack ?? error.message}`));
  if (runtime === 'in-page') {
    await page.addInitScript(() => { (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true; });
  }
  const banner = page.waitForEvent('console', { predicate: (message) => message.text().startsWith(BANNER), timeout: 30_000 });
  await page.goto(url);
  const text = (await banner).text();
  if (runtime === 'shared-worker') assert.match(text, /in a SharedWorker/, text);
  if (runtime === 'hosted') assert.match(text, /on the dev server/, text);
  if (runtime === 'in-page') assert.doesNotMatch(text, /SharedWorker|on the dev server/, text);
  await page.waitForFunction(() => 'signIn' in window);
  return page;
}

/** Types a new account into the Google dialog. */
async function signInTyped(page: Page): Promise<SignInReport> {
  const result = page.evaluate(() => signIn());
  const dialog = page.locator('dialog[data-pyric-auth][open]');
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.locator('input[type="email"]').fill(EMAIL);
  await dialog.locator('input[placeholder="Display name (optional)"]').fill('Ada');
  await dialog.locator('button.submit').click();
  return result;
}

/** Picks the account the first sign-in added from the dialog's account list. */
async function signInPicked(page: Page): Promise<SignInReport> {
  const result = page.evaluate(() => signIn());
  const dialog = page.locator('dialog[data-pyric-auth][open]');
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.locator('.ids button', { hasText: EMAIL }).click();
  return result;
}

async function checkRuntime(app: App, url: string, runtime: Runtime): Promise<void> {
  const page = await openPage(app, url, runtime);
  assert.deepEqual(await signInTyped(page), EXPECTED, `${runtime}, typed account`);
  await page.evaluate(() => signOutUser());
  assert.deepEqual(await signInPicked(page), EXPECTED, `${runtime}, picked account`);
  await page.evaluate(() => signOutUser());
  await page.close();
}

export default scenario(async (app) => {
  const local = await app.step('start the dev server', () => app.devServer());

  await app.step('in a SharedWorker, a Google dialog sign-in has a verified email and reads its allowlist entry', () =>
    checkRuntime(app, local.url, 'shared-worker'));

  const hosted = await app.step('restart the dev server as the Node host', async () => {
    await local.process.stop();
    app.writeFile('vite.config.js', 'import { pyric } from "@pyric/cli/vite";\n\nexport default {\n  plugins: [pyric({ hosted: true })],\n};\n');
    return app.devServer();
  });

  await app.step('on the Node host, a Google dialog sign-in has a verified email and reads its allowlist entry', () =>
    checkRuntime(app, hosted.url, 'hosted'));
});
