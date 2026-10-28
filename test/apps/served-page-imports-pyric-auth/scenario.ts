// A Vite page served in-page that imports pyric/auth next to the served
// firebase/auth (#1506). Vite's dependency optimizer used to pre-bundle the
// page's pyric/auth into its own copy of pyric, with its own app registry, and
// the served entry resolved to that copy too. initializeApp registered the app
// in the other copy, so getAuth threw "pyric/auth is a sandbox-only mirror".
// The page and the served entries must share one pyric: getAuth returns the
// handle pyric/auth returns, sandbox.mockSignInResult stages a result on it,
// signInWithPopup signs in as the staged user, and Security Rules see that user.
// The page also imports pyric/firestore, pyric/database and pyric/storage, and
// the served getFirestore, getDatabase and getStorage keep working.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

type Checks = Record<string, unknown>;
declare function runChecks(): Promise<Checks>;

const BANNER = '[pyric sandbox] firebase/* on this page is served by the Pyric sandbox';

const EXPECTED: Checks = {
  getAuth: 'ok',
  oneAuthHandle: true,
  staged: 'ok',
  signedIn: 'staged-user',
  rulesSeeStagedUser: 'hello',
  getDatabase: 'notes',
  getStorage: 'notes/a.txt',
  subpathsLoaded: true,
};

export default scenario(async (app) => {
  const local = await app.step('start the dev server', () => app.devServer());

  await app.step('in-page, getAuth works and sandbox.mockSignInResult stages a sign-in next to pyric/auth', async () => {
    const page = await (await app.browser()).newPage();
    // Opened here, not with app.page, so the in-page runtime can be forced
    // before the first script runs; its console goes to the app's log.
    const log = app.browserLog as string[];
    page.on('console', (message) => log.push(`[in-page console.${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => log.push(`[in-page page error] ${error.stack ?? error.message}`));
    await page.addInitScript(() => { (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true; });
    const banner = page.waitForEvent('console', { predicate: (message) => message.text().startsWith(BANNER), timeout: 30_000 });
    await page.goto(local.url);
    const text = (await banner).text();
    assert.doesNotMatch(text, /SharedWorker|on the dev server/, text);
    await page.waitForFunction(() => 'runChecks' in window);
    const checks = await page.evaluate(() => runChecks());
    await page.close();
    assert.deepEqual(checks, EXPECTED, `in-page: ${JSON.stringify(checks)}`);
  });
});
