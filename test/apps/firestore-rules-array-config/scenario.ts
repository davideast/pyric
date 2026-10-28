// firebase.json declares `firestore` as an array (#1315): `(default)` deploys
// firestore.default.rules, which denies writes to locked/, and a named
// database `reports` deploys an allow-all file. A permissive firestore.rules
// sits in the project directory as a decoy the array does not name. Before the
// fix every plane read `config.firestore.rules`, undefined on an array, and
// fell back to the decoy, so locked/x was writable everywhere.
//
// Every plane must enforce firestore.default.rules on (default): the
// SharedWorker page, the Node host page, a `node --import @pyric/cli/register`
// process, and `pyric rules simulate` with no host. The dev server warns that
// `reports` is not served, and `pyric verify` finds firestore.default.rules
// without `--rules`.
import assert from 'node:assert/strict';
import { scenario, sleep, type App } from '../driver.ts';

declare function tryWrite(path: string): Promise<string>;

const WARNING = 'firebase.json deploys reports.rules to Firestore database "reports". Pyric serves only (default) for now';

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

async function pageEnforcesDefaultRules(app: App, url: string): Promise<void> {
  const page = await app.page(url);
  await page.waitForFunction(() => 'tryWrite' in window, undefined, { timeout: 30_000 });
  assert.equal(await page.evaluate(() => tryWrite('open/a')), 'allowed');
  assert.match(await page.evaluate(() => tryWrite('locked/x')), /^denied: permission-denied/);
}

export default scenario(async (app) => {
  await app.step('pyric rules simulate with no host denies a write to locked/x', async () => {
    const args = ['rules', 'simulate', '--in-process', '--json', '--service', 'firestore', '--operation', 'create', '--path', 'locked/x', '--data', '{"from":"cli"}'];
    const { output } = await pyric(app, args);
    assert.match(output, /"decision": "DENY"/, output);
    assert.doesNotMatch(output, /"decision": "ALLOW"/, output);
  });

  await app.step('a node --import @pyric/cli/register process is denied locked/x', async () => {
    const { output } = await app.serverScript('write.mjs', [], { env: { PYRIC_SANDBOX: 'local' }, timeoutMs: 60_000 });
    assert.match(output, /^open\/a allowed$/m, output);
    assert.match(output, /^locked\/x denied: permission-denied$/m, output);
    assert.ok(output.includes(WARNING), output);
  });

  await app.step('the SharedWorker page is denied locked/x, and the dev server warns about reports', async () => {
    const host = await app.devServer({ name: 'SharedWorker dev server' });
    await pageEnforcesDefaultRules(app, host.url);
    assert.ok(host.process.output.includes(WARNING), host.process.output);
    await host.process.stop();
  });

  await app.step('the Node host page is denied locked/x, and the dev server warns about reports', async () => {
    const host = await app.devServer({ name: 'Node host dev server', env: { SCENARIO_HOSTED: '1' } });
    await pageEnforcesDefaultRules(app, host.url);
    assert.ok(host.process.output.includes(WARNING), host.process.output);
    await waitForCapture(app);
  });

  await app.step('pyric verify resolves firestore.default.rules without --rules', async () => {
    const clean = await pyric(app, ['verify', '--service', 'firestore']);
    assert.equal(clean.code, 0, clean.output);
    assert.match(clean.output, /all selected services replay cleanly/, clean.output);

    // Opening locked/ in firestore.default.rules turns the denied write into
    // a divergence, so verify read that file and not the decoy.
    app.writeFile('firestore.default.rules', app.readFile('firestore.default.rules').replace('allow write: if false;', 'allow write: if true;'));
    const opened = await pyric(app, ['verify', '--service', 'firestore']);
    assert.equal(opened.code, 1, opened.output);
    assert.match(opened.output, /now-allowed/, opened.output);
  });
});
