// A hosted page signs in with the default LOCAL persistence and reloads (#1837).
// Production's first onAuthStateChanged callback waits for initialization,
// which loads the persisted user, so the first value after the reload is that
// user. The hosted page used to report null first and the user second, so an
// app showed its sign-in screen for a moment on every reload.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare const authState: {
  observed(): Array<string | null>;
  signIn(): Promise<string>;
};

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const page = await app.step('open the page', () => app.page(host.url));

  const uid = await app.step('sign in anonymously', async () => {
    await page.waitForFunction(() => 'authState' in window, undefined, { timeout: 30_000 });
    const signedIn = await page.evaluate(() => authState.signIn());
    await page.waitForFunction((expected) => authState.observed().includes(expected), signedIn);
    return signedIn;
  });

  await app.step('after a reload, the first onAuthStateChanged value is the restored user', async () => {
    await page.reload();
    await page.waitForFunction(() => 'authState' in window && authState.observed().length > 0, undefined, { timeout: 30_000 });
    // Wait for the restored user too, so a null-then-user sequence shows in full.
    await page.waitForFunction((expected) => authState.observed().includes(expected), uid, { timeout: 10_000 }).catch(() => undefined);
    const observed = await page.evaluate(() => authState.observed());
    assert.deepEqual(observed, [uid], `onAuthStateChanged values after the reload: ${JSON.stringify(observed)}`);
  });
});
