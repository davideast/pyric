// A server script finds the running dev server without a hardcoded port.
// Bare PYRIC_SANDBOX=remote finds it through the project's .pyric/serve.json.
// A remote:<url> left in a .env file after the host moved ports is stale: the
// script warns once and uses this project's running host instead. With the
// host stopped and a pointer naming a port whose connects never complete, a
// script still exits promptly once discovery gives up (#1162). A script that
// closes its handle with an onDisconnect the host has not answered exits 0,
// with no unhandled rejection (#1723).
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare function readStatus(): Promise<unknown>;

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const page = await app.step('open the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'readStatus' in window);
    return page;
  });

  await app.step('PYRIC_SANDBOX=remote finds the running host', async () => {
    await app.serverScript('server.mjs', ['found by discovery'], { env: { PYRIC_SANDBOX: 'remote' } });
    assert.equal(await page.evaluate(() => readStatus()), 'found by discovery');
  });

  await app.step('a stale PYRIC_SANDBOX=remote:<url> falls back to the running host', async () => {
    const stale = `http://127.0.0.1:${await app.freePort()}`;
    const result = await app.serverScript('server.mjs', ['found after a stale url'], { env: { PYRIC_SANDBOX: `remote:${stale}` } });
    assert.match(result.output, new RegExp(`PYRIC_SANDBOX=remote:${stale.replaceAll('.', '\\.')} is stale`));
    assert.equal(await page.evaluate(() => readStatus()), 'found after a stale url');
  });

  // `pyric sandbox save` is not a sandbox method (`checkpoint` is), so the CLI
  // runs `save` as a child command on a second server in this project. That
  // server used to replace .pyric/serve.json and then delete it on exit,
  // leaving the running host undiscoverable.
  await app.step('a mistyped pyric sandbox method leaves the running host discoverable', async () => {
    const before = JSON.parse(app.readFile('.pyric/serve.json')) as { url: string; instanceId: string };
    const typo = await app.pyric(['sandbox', 'save', '--name', 'cp1', '--json']);
    const after = JSON.parse(app.readFile('.pyric/serve.json')) as { url: string; instanceId: string };
    assert.deepEqual({ url: after.url, instanceId: after.instanceId }, { url: before.url, instanceId: before.instanceId });
    assert.equal(typo.code, 1, typo.output);
    assert.match(typo.output, /'save' is neither a command on PATH nor a `pyric sandbox` method/);
    await app.serverScript('server.mjs', ['found after a mistyped method'], { env: { PYRIC_SANDBOX: 'remote' } });
    assert.equal(await page.evaluate(() => readStatus()), 'found after a mistyped method');
  });

  // @firebase/database ends a closed connection through repoInterrupt, which
  // clears its request callbacks, so a sent onDisconnect never settles. The
  // Node client rejected it on close, and the presence sample's bare call
  // ended the process on an unhandled rejection (#1723).
  await app.step('a script that closes with an onDisconnect unanswered exits 0', async () => {
    const result = await app.serverScript('close-with-ondisconnect.mjs', [host.url], { env: { PYRIC_SANDBOX: 'remote' } });
    assert.match(result.output, /closed with an onDisconnect unanswered/);
    assert.match(result.output, /exiting with code 0/);
    assert.doesNotMatch(result.output, /closed by the client/);
  });

  await app.step('a script exits promptly when the pointer names a port that never answers', async () => {
    await host.process.stop();
    const hole = await app.blackholedPort();
    app.writeFile('.pyric/serve.json', JSON.stringify({ port: hole, url: `http://localhost:${hole}`, instanceId: 'blackholed-host' }));
    const stale = `http://127.0.0.1:${await app.freePort()}`;
    const result = await app.serverScript('stale-exit.mjs', [], { env: { PYRIC_SANDBOX: `remote:${stale}` } });
    assert.match(result.output, /write refused: .*is stale/);
    const refusedAt = Number(/refused at (\d+)/.exec(result.output)?.[1]);
    const drainedAt = Number(/loop drained at (\d+)/.exec(result.output)?.[1]);
    const printedBothTimes = Number.isFinite(refusedAt) && Number.isFinite(drainedAt);
    assert.ok(printedBothTimes, `stale-exit.mjs printed no refusal or drain time:\n${result.output}`);
    // Both times come from the script: from its refusal to its event loop
    // draining. Node and register startup do not count, and neither does the
    // runner noticing the exit late while another app's work holds its own
    // loop. A probe connect left pending kept the loop alive about 10 s past
    // the refusal (undici's connect timeout); 2 s is well under that.
    const lingerMs = drainedAt - refusedAt;
    assert.ok(lingerMs < 2_000, `stale-exit.mjs stayed alive ${lingerMs} ms after the refusal:\n${result.output}`);
  });
});
