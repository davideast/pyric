// A page on the in-page sandbox, with persisted state, holds two sessions of
// one account in two Firebase apps, standing in for a laptop and a phone. The
// phone changes the password, which in production revokes the laptop's
// refresh token: the account's revocation time (`validSince`) moves past the
// laptop's sign-in, and a reload does not undo it. After the page reloads, the
// laptop's forced refresh fails with auth/user-token-expired and signs it
// out, while the phone, which made the change, keeps refreshing (#2018).
//
// The in-page sandbox used to persist the accounts but not their revocation
// times or the sessions' sign-in times, so the reloaded laptop refreshed again.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface Refreshed { code: string | null; currentUid: string | null }
interface Devices {
  restored(): Promise<{ laptop: string | null; phone: string | null }>;
  signInBoth(email: string, password: string): Promise<string>;
  changePasswordOnPhone(newPassword: string): Promise<void>;
  refreshLaptop(): Promise<Refreshed>;
  refreshPhone(): Promise<Refreshed>;
}
declare const devices: Devices;

/** Production stores a revocation on a whole second, so a session signed in during that second stays valid. */
const PAST_THE_SIGN_IN_SECOND_MS = 1100;

export default scenario(async (app) => {
  const host = await app.step('start the dev server with persisted state', () => app.devServer());

  const page = await app.step('open the page on the in-page sandbox', async () => {
    const page = await (await app.browser()).newPage();
    const log = app.browserLog as string[];
    page.on('console', (message) => log.push(`[page console.${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => log.push(`[page error] ${error.stack ?? error.message}`));
    await page.addInitScript(() => { (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true; });
    await page.goto(host.url);
    await page.waitForFunction(() => 'devices' in window, undefined, { timeout: 30_000 });
    return page;
  });

  const uid = await app.step('the laptop and the phone sign in to one account', async () => {
    return page.evaluate(() => devices.signInBoth('two-devices@example.com', 'secret-pw'));
  });

  await app.step('the phone changes the password, and the state is saved', async () => {
    await page.waitForTimeout(PAST_THE_SIGN_IN_SECOND_MS);
    const saved = page.waitForResponse((response) => response.url().includes('/__pyric/state') && response.request().method() === 'POST');
    await page.evaluate(() => devices.changePasswordOnPhone('changed-secret-pw'));
    assert.equal((await saved).status(), 200);
  });

  await app.step('after a reload, both apps restore their sessions', async () => {
    await page.reload();
    await page.waitForFunction(() => 'devices' in window, undefined, { timeout: 30_000 });
    assert.deepEqual(await page.evaluate(() => devices.restored()), { laptop: uid, phone: uid });
  });

  await app.step("the laptop's forced refresh fails with auth/user-token-expired and signs it out", async () => {
    assert.deepEqual(await page.evaluate(() => devices.refreshLaptop()), { code: 'auth/user-token-expired', currentUid: null });
  });

  await app.step('the phone, which changed the password, keeps refreshing', async () => {
    assert.deepEqual(await page.evaluate(() => devices.refreshPhone()), { code: null, currentUid: uid });
  });
});
