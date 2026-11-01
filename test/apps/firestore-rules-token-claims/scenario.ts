// Firestore rules read the signed-in user's `request.auth.token.sub`, `iss`,
// `aud`, `iat`, `exp` and `auth_time` (#1341). Production binds the ID
// token's claims, and Firebase's docs say "`sub`: The user's Firebase UID".
// firestore.rules lets a user write users/<uid> only when the token's sub is
// that uid and the other five claims are there. A signed-in user, and the
// same user after reauthentication, write their own document; another user's
// document and a signed-out write stay denied. The in-page sandbox, the
// SharedWorker page, a `node --import @pyric/cli/register` process and a page
// on the Node host must all give these answers.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario, type App } from '../driver.ts';

type Checks = { signedIn: string; otherUser: string; afterReauthentication: string; signedOut: string };
declare function runChecks(): Promise<Checks>;

type Runtime = 'shared-worker' | 'in-page' | 'hosted';

const BANNER = '[pyric sandbox] firebase/* on this page is served by the Pyric sandbox';

const EXPECTED: Checks = {
  signedIn: 'ok',
  otherUser: 'permission-denied',
  afterReauthentication: 'ok',
  signedOut: 'permission-denied',
};

/** Opens the page in `runtime` and checks the sandbox banner says so. */
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

  await app.step('in-page, a user writes their own document under a token.sub rule', async () => {
    assert.deepEqual(await pageChecks(app, local.url, 'in-page'), EXPECTED);
  });

  await app.step('in a SharedWorker, a user writes their own document under a token.sub rule', async () => {
    assert.deepEqual(await pageChecks(app, local.url, 'shared-worker'), EXPECTED);
  });

  const hosted = await app.step('restart the dev server as the Node host', async () => {
    await local.process.stop();
    app.writeFile('vite.config.js', 'import { pyric } from "@pyric/cli/vite";\n\nexport default {\n  plugins: [pyric({ hosted: true })],\n};\n');
    return app.devServer();
  });

  await app.step('a registered server process writes its own document under a token.sub rule', async () => {
    const { output } = await app.serverScript('client.mjs', [], { env: { PYRIC_SANDBOX: `remote:${hosted.url}` }, timeoutMs: 30_000 });
    const line = output.match(/^checks (.*)$/m);
    assert.ok(line, `no checks line in:\n${output}`);
    assert.deepEqual(JSON.parse(line[1]), EXPECTED, `register process:\n${output}`);
  });

  await app.step('on the Node host, a page writes its own document under a token.sub rule', async () => {
    assert.deepEqual(await pageChecks(app, hosted.url, 'hosted'), EXPECTED);
  });
});
