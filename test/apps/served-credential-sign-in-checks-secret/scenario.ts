// signInWithCredential with an email credential checks its password or link
// on every plane (#1448). The served client used to send only the OAuth
// fields, so the host signed in as whoever owned the email, and Security Rules
// saw that account. The page creates an account with a password and writes its
// private document; then a wrong password, an empty password, an unknown email
// and a made-up email link are each refused with the in-page codes, nobody is
// signed in after, and the document stays denied. The right password signs in
// with a null providerId and reads it. In-page is the control; the SharedWorker
// page, a `node --import @pyric/cli/register` process and a page on the Node
// host must give the same answers.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario, type App } from '../driver.ts';

type Check = { ok: boolean; code?: string; providerId?: string | null; signedIn: string | null; read: string };
type Checks = Record<string, Check>;
declare function runChecks(): Promise<Checks>;

type Runtime = 'shared-worker' | 'in-page' | 'hosted';

const BANNER = '[pyric sandbox] firebase/* on this page is served by the Pyric sandbox';

const REFUSED = { ok: false, signedIn: null, read: 'permission-denied' };
const EXPECTED: Checks = {
  wrongPassword: { ...REFUSED, code: 'auth/wrong-password' },
  emptyPassword: { ...REFUSED, code: 'auth/missing-password' },
  unknownEmail: { ...REFUSED, code: 'auth/user-not-found' },
  madeUpLink: { ...REFUSED, code: 'auth/invalid-action-code' },
  rightPassword: { ok: true, providerId: null, signedIn: 'owner', read: 'allowed' },
};

/** Opens the page in `runtime` and checks the sandbox banner says so. */
async function openPage(app: App, url: string, runtime: Runtime): Promise<Page> {
  const page = await (await app.browser()).newPage();
  // Opened here, not with app.page, so the in-page runtime can be forced
  // before the first script runs; its console goes to the app's log.
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
  await page.waitForFunction(() => 'runChecks' in window);
  return page;
}

async function pageChecks(app: App, url: string, runtime: Runtime): Promise<Checks> {
  const page = await openPage(app, url, runtime);
  const checks = await page.evaluate(() => runChecks());
  await page.close();
  return checks;
}

export default scenario(async (app) => {
  const local = await app.step('start the dev server', () => app.devServer());

  const control = await app.step('in-page, each wrong secret is refused and the right password signs in', async () => {
    const checks = await pageChecks(app, local.url, 'in-page');
    assert.deepEqual(checks, EXPECTED, `in-page: ${JSON.stringify(checks)}`);
    return checks;
  });

  await app.step('in a SharedWorker, signInWithCredential gives the in-page answers', async () => {
    const checks = await pageChecks(app, local.url, 'shared-worker');
    assert.deepEqual(checks, control, `shared-worker: ${JSON.stringify(checks)}`);
  });

  const hosted = await app.step('restart the dev server as the Node host', async () => {
    await local.process.stop();
    app.writeFile('vite.config.js', 'import { pyric } from "@pyric/cli/vite";\n\nexport default {\n  plugins: [pyric({ hosted: true })],\n};\n');
    return app.devServer();
  });

  await app.step('a registered server process gives the in-page answers', async () => {
    const { output } = await app.serverScript('client.mjs', [], { env: { PYRIC_SANDBOX: `remote:${hosted.url}` }, timeoutMs: 30_000 });
    const line = output.match(/^checks (.*)$/m);
    assert.ok(line, `no checks line in:\n${output}`);
    assert.deepEqual(JSON.parse(line[1]), control, `register process:\n${output}`);
  });

  await app.step('on the Node host, signInWithCredential gives the in-page answers', async () => {
    const checks = await pageChecks(app, hosted.url, 'hosted');
    assert.deepEqual(checks, control, `hosted: ${JSON.stringify(checks)}`);
  });
});
