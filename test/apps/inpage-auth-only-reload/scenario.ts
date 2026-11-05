// A page on the in-page sandbox, with persisted state, that imports only
// firebase/auth. A user signs up, Chromium reloads the page, and the user is
// still signed in, and can sign out and back in with the same password (#2039).
//
// The in-page backend setup that loads and saves sandbox state ran only from
// the Firestore, Storage and Database entries, so an auth-only page sent no
// request to /__pyric/state and lost every account on reload.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface Account {
  restored(): Promise<string | null>;
  signUp(email: string, password: string): Promise<string>;
  signOutAndBackIn(email: string, password: string): Promise<string>;
}
declare const account: Account;

const EMAIL = 'auth-only@example.com';
const PASSWORD = 'secret-pw';

export default scenario(async (app) => {
  const host = await app.step('start the dev server with persisted state', () => app.devServer());

  const page = await app.step('open the auth-only page on the in-page sandbox', async () => {
    const page = await (await app.browser()).newPage();
    const log = app.browserLog as string[];
    page.on('console', (message) => log.push(`[page console.${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => log.push(`[page error] ${error.stack ?? error.message}`));
    await page.addInitScript(() => { (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true; });
    await page.goto(host.url);
    await page.waitForFunction(() => 'account' in window, undefined, { timeout: 30_000 });
    return page;
  });

  const uid = await app.step('a user signs up, and the accounts and the session are saved', async () => {
    const isStateSave = (section: string) => (response: { url(): string; request(): { method(): string } }) =>
      response.url().includes(`/__pyric/state?section=${section}`) && response.request().method() === 'POST';
    const accountsSaved = page.waitForResponse(isStateSave('auth'), { timeout: 15_000 });
    const sessionSaved = page.waitForResponse(isStateSave('firestore'), { timeout: 15_000 });
    const uid = await page.evaluate(([email, password]) => account.signUp(email, password), [EMAIL, PASSWORD]);
    assert.ok((await accountsSaved).ok(), 'the accounts save failed');
    assert.ok((await sessionSaved).ok(), 'the session save failed');
    return uid;
  });

  await app.step('after a reload, the user is still signed in', async () => {
    await page.reload();
    await page.waitForFunction(() => 'account' in window, undefined, { timeout: 30_000 });
    assert.equal(await page.evaluate(() => account.restored()), uid);
  });

  await app.step('the user signs out and back in with the same password', async () => {
    assert.equal(await page.evaluate(([email, password]) => account.signOutAndBackIn(email, password), [EMAIL, PASSWORD]), uid);
  });
});
