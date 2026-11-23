// firebase.json declares `firestore` as an array (#1315, #1319): `(default)`
// deploys firestore.default.rules, which denies writes to locked/, and a named
// database `reports` deploys reports.rules, which allows all writes. A
// permissive firestore.rules sits in the project directory as a decoy the
// array does not name.
//
// Every plane must enforce each database's own rules without warning that
// named databases are unserved: the SharedWorker page, the Node host page
// (including hot-reload of reports.rules), a `node --import @pyric/cli/register`
// process, and `pyric rules simulate` with no host, while `pyric verify`
// resolves firestore.default.rules without `--rules`.
import assert from 'node:assert/strict';
import { scenario, sleep, type App } from '../driver.ts';

declare function tryWrite(path: string, databaseId?: string): Promise<string>;
declare function tryRead(path: string, databaseId?: string): Promise<string>;
declare function verifyNamedDbAndCacheParity(): Promise<{
  initialListenerEvents: number;
  cursorIds: string[];
  cachedData: Record<string, unknown> | undefined;
}>;

const RETIRED_WARNING = 'Pyric serves only (default) for now';

/** Run the installed `pyric` command from the app directory; returns its exit code and output. */
async function pyric(app: App, args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { output } = await app.serverScript('pyric.mjs', args, { timeoutMs: 90_000 });
    return { code: 0, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = Number(message.match(/exited with code (\d+)/)?.[1] ?? NaN);
    if (Number.isNaN(code)) throw error;
    return { code, output: message };
  }
}

/** Wait until the host's capture holds the page's write to locked/x, which `pyric verify` replays. */
async function waitForCapture(app: App): Promise<void> {
  const deadline = Date.now() + 15_000;
  let capture = '';
  for (;;) {
    try {
      capture = app.readFile('.pyric/last-session.json');
    } catch {
      // The host has not written the capture yet.
    }
    if (capture.includes('locked/x')) return;
    if (Date.now() > deadline) throw new Error(`.pyric/last-session.json does not name locked/x after 15s: ${capture.slice(0, 2000)}`);
    await sleep(250);
  }
}

async function waitForPageRuleEffect(
  check: () => Promise<string>,
  expectedPrefix: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last = '';
  for (;;) {
    last = await check();
    if (last.startsWith(expectedPrefix)) return;
    if (Date.now() > deadline) {
      throw new Error(`Expected "${expectedPrefix}" after hot-reload, got "${last}"`);
    }
    await sleep(150);
  }
}

export default scenario(async (app) => {
  await app.step('pyric rules simulate with no host denies a write to locked/x', async () => {
    const args = ['rules', 'simulate', '--in-process', '--json', '--service', 'firestore', '--operation', 'create', '--path', 'locked/x', '--data', '{"from":"cli"}'];
    const { output } = await pyric(app, args);
    assert.match(output, /"decision": "DENY"/, output);
    assert.doesNotMatch(output, /"decision": "ALLOW"/, output);
  });

  await app.step('a node --import @pyric/cli/register process enforces per-database rules with no warning', async () => {
    const { output } = await app.serverScript('write.mjs', [], { env: { PYRIC_SANDBOX: 'local' }, timeoutMs: 60_000 });
    assert.match(output, /^open\/a allowed$/m, output);
    assert.match(output, /^locked\/x denied: permission-denied$/m, output);
    assert.match(output, /^reports:locked\/x allowed$/m, output);
    assert.match(output, /^undeclared:open\/a denied: unavailable$/m, output);
    assert.ok(!output.includes(RETIRED_WARNING), output);
  });

  await app.step('the SharedWorker page enforces per-database rules and hot-reloads reports.rules', async () => {
    const originalReportsRules = app.readFile('reports.rules');
    const host = await app.devServer({ name: 'SharedWorker dev server' });
    try {
      const page = await app.page(host.url);
      await page.waitForFunction(() => 'tryWrite' in window, undefined, { timeout: 30_000 });
      assert.equal(await page.evaluate(() => tryWrite('open/a')), 'allowed');
      assert.match(await page.evaluate(() => tryWrite('locked/x')), /^denied: permission-denied/);
      assert.equal(await page.evaluate(() => tryWrite('locked/x', 'reports')), 'allowed');
      assert.match(await page.evaluate(() => tryRead('open/a', 'undeclared')), /^denied: unavailable/);
      assert.deepEqual(await page.evaluate(() => verifyNamedDbAndCacheParity()), {
        initialListenerEvents: 1,
        cursorIds: ['c2'],
        cachedData: { tags: ['keep'], count: 5 },
      });
      assert.ok(!host.process.output.includes(RETIRED_WARNING), host.process.output);

      app.writeFile('reports.rules', app.readFile('firestore.default.rules'));
      await waitForPageRuleEffect(
        () => page.evaluate(() => tryWrite('locked/x', 'reports')),
        'denied: permission-denied',
      );
    } finally {
      app.writeFile('reports.rules', originalReportsRules);
      await host.process.stop();
    }
  });

  await app.step('the Node host page enforces (default) and captures for pyric verify', async () => {
    const host = await app.devServer({ name: 'Node host dev server', env: { SCENARIO_HOSTED: '1' } });
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'tryWrite' in window, undefined, { timeout: 30_000 });
    assert.equal(await page.evaluate(() => tryWrite('open/a')), 'allowed');
    assert.match(await page.evaluate(() => tryWrite('locked/x')), /^denied: permission-denied/);
    assert.ok(!host.process.output.includes(RETIRED_WARNING), host.process.output);
    await waitForCapture(app);

    const clean = await pyric(app, ['verify', '--service', 'firestore']);
    assert.equal(clean.code, 0, clean.output);
    assert.match(clean.output, /all selected services replay cleanly/, clean.output);

    const originalDefaultRules = app.readFile('firestore.default.rules');
    try {
      app.writeFile('firestore.default.rules', originalDefaultRules.replace('allow write: if false;', 'allow write: if true;'));
      const opened = await pyric(app, ['verify', '--service', 'firestore']);
      assert.equal(opened.code, 1, opened.output);
      assert.match(opened.output, /now-allowed/, opened.output);
    } finally {
      app.writeFile('firestore.default.rules', originalDefaultRules);
    }

    const originalReportsRules = app.readFile('reports.rules');
    try {
      assert.equal(await page.evaluate(() => tryWrite('locked/x', 'reports')), 'allowed');
      assert.match(await page.evaluate(() => tryRead('open/a', 'undeclared')), /^denied: unavailable/);
      assert.deepEqual(await page.evaluate(() => verifyNamedDbAndCacheParity()), {
        initialListenerEvents: 1,
        cursorIds: ['c2'],
        cachedData: { tags: ['keep'], count: 5 },
      });
      app.writeFile('reports.rules', originalDefaultRules);
      await waitForPageRuleEffect(
        () => page.evaluate(() => tryWrite('locked/x', 'reports')),
        'denied: permission-denied',
      );
    } finally {
      app.writeFile('reports.rules', originalReportsRules);
      await host.process.stop();
    }
  });
});
