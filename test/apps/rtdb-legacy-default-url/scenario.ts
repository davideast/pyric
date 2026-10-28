// An app of a project created before about 2020 uses the databaseURL the
// Firebase console gives it, https://<projectId>.firebaseio.com: the
// project's default RTDB instance, named by the project id. firebase.json
// deploys its plain `database.rules` to that instance, with no .firebaserc.
// The page gets those rules, and the data that the <projectId>-default-rtdb
// URL (what getDatabase(app) opens without a databaseURL) reads, in the
// SharedWorker, in-page, and on the Node host. A firebase-admin process on
// the Node host with the same databaseURL shares that instance (#1062).
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario, type App } from '../driver.ts';

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };
interface Legacy {
  write(path: string, value: unknown): Promise<Outcome>;
  read(path: string): Promise<Outcome>;
  readProjectDefault(path: string): Promise<Outcome>;
}
declare const legacy: Legacy;

type Runtime = 'shared-worker' | 'in-page' | 'hosted';

const BANNER = '[pyric sandbox] firebase/* on this page is served by the Pyric sandbox';

/** Opens the page in `runtime` and checks the sandbox banner says so. */
async function openPage(app: App, url: string, runtime: Runtime): Promise<Page> {
  const page = await (await app.browser()).newPage();
  // This page is opened here, not with app.page, so the in-page runtime can
  // be forced before the first script runs; its console goes to the app's log.
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
  await page.waitForFunction(() => 'legacy' in window);
  return page;
}

/** The default rules allow open/ and deny closed/, and the write is the default instance's data. */
async function expectDefaultRules(page: Page, runtime: Runtime): Promise<void> {
  const value = `written ${runtime}`;
  const allowed = await page.evaluate((v) => legacy.write('open/page', v), value);
  assert.deepEqual(allowed, { ok: true, value: null }, `${runtime}: write to open/page: ${JSON.stringify(allowed)}`);
  const denied = await page.evaluate(() => legacy.write('closed/page', 'x'));
  assert.equal(denied.ok, false, `${runtime}: write to closed/page: ${JSON.stringify(denied)}`);
  assert.match(denied.ok ? '' : denied.error, /PERMISSION_DENIED/);
  const projectDefault = await page.evaluate(() => legacy.readProjectDefault('open/page'));
  assert.deepEqual(projectDefault, { ok: true, value }, `${runtime}: the <projectId>-default-rtdb URL reads: ${JSON.stringify(projectDefault)}`);
}

export default scenario(async (app) => {
  const local = await app.step('start the dev server', () => app.devServer());

  await app.step('in a SharedWorker, the legacy databaseURL gets the default rules and data', async () => {
    const page = await openPage(app, local.url, 'shared-worker');
    await expectDefaultRules(page, 'shared-worker');
    await page.close();
  });

  await app.step('in-page, the legacy databaseURL gets the default rules and data', async () => {
    const page = await openPage(app, local.url, 'in-page');
    await expectDefaultRules(page, 'in-page');
    await page.close();
  });

  const hosted = await app.step('restart the dev server as the Node host', async () => {
    await local.process.stop();
    app.writeFile('vite.config.js', 'import { pyric } from "@pyric/cli/vite";\n\nexport default {\n  plugins: [pyric({ hosted: true })],\n};\n');
    return app.devServer();
  });

  const page = await app.step('on the Node host, the legacy databaseURL gets the default rules and data', async () => {
    const page = await openPage(app, hosted.url, 'hosted');
    await expectDefaultRules(page, 'hosted');
    return page;
  });

  await app.step('a firebase-admin process on the legacy databaseURL shares the default instance with the page', async () => {
    const { output } = await app.serverScript('server.mjs', [], { env: { PYRIC_SANDBOX: `remote:${hosted.url}` } });
    assert.match(output, /server read open\/page: "written hosted"/, output);
    assert.match(output, /server read open\/server through the -default-rtdb URL: "from server"/, output);
    const read = await page.evaluate(() => legacy.read('open/server'));
    assert.deepEqual(read, { ok: true, value: 'from server' }, `the page reads the server's write: ${JSON.stringify(read)}`);
  });
});
