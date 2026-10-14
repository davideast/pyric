// Editing vite.config.js restarts Vite's dev server. Vite builds the
// replacement, which evaluates the config and calls pyric() again, before it
// closes the old server. The restart must succeed, apply the edit, and keep
// the hosted state.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare const notes: { write(text: string): Promise<void>; read(): Promise<unknown> };

async function hostInstance(url: string): Promise<string> {
  const health = await (await fetch(`${url}/__pyric/health`)).json() as { instanceId?: string };
  assert.ok(health.instanceId, `/__pyric/health has no instanceId: ${JSON.stringify(health)}`);
  return health.instanceId;
}

export default scenario(async (app) => {
  // The restart interrupts the page's connection, and the page posts that to
  // /__pyric/diagnostics. A post made before the new server generation mounts
  // Pyric's routes answers 404, and the page keeps the report in memory.
  app.expectHostError(/^404 POST \/__pyric\/diagnostics$/);

  const host = await app.step('start the hosted dev server', () => app.devServer());

  const page = await app.step('write a note from the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'notes' in window);
    await page.evaluate(() => notes.write('before restart'));
    return page;
  });

  await app.step('the page console says the sandbox runs on the dev server', async () => {
    const tab = await (await app.browser()).newPage();
    const line = tab.waitForEvent('console', { predicate: (message) => message.text().startsWith('[pyric sandbox] firebase/*'), timeout: 15_000 });
    await tab.goto(host.url);
    const text = (await line).text();
    await tab.close();
    assert.match(text, /on the dev server/, text);
    assert.doesNotMatch(text, /SharedWorker/, text);
  });

  const before = await app.step('read the host instance', () => hostInstance(host.url));

  await app.step('edit vite.config.js; Vite restarts the server', async () => {
    const mark = host.process.mark();
    const config = app.readFile('vite.config.js');
    const edited = config.replace(
      'server: { port: 5181, strictPort: true },',
      'server: { port: 5181, strictPort: true, headers: { "x-config-revision": "2" } },',
    );
    assert.notEqual(edited, config, 'the edit did not apply to vite.config.js');
    app.writeFile('vite.config.js', edited);
    const [outcome] = await host.process.waitForLog(/server restarted|server restart failed/, { since: mark, timeoutMs: 60_000 });
    assert.equal(outcome, 'server restarted', `Vite reported: ${host.process.output.slice(mark).trim()}`);
  });

  await app.step('the restarted server runs the edited config on a new host generation', async () => {
    const response = await fetch(`${host.url}/`);
    assert.equal(response.headers.get('x-config-revision'), '2');
    assert.notEqual(await hostInstance(host.url), before);
  });

  await app.step('the note written before the restart reads back after it', async () => {
    const t0 = Date.now();
    const log = (m: string) => console.log(`[diag +${Date.now() - t0}ms] ${m}`);
    const within = <T>(label: string, p: Promise<T>, ms = 20_000) => Promise.race([
      p.then((v) => { log(`${label} done`); return v; }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} hung ${ms}ms`)), ms)),
    ]);
    log(`page1 url ${page.url()}`);
    log(`page1 state ${await within('page1 readyState', page.evaluate(() => `${document.readyState} ${(globalThis as any).__pyricServe ? 'serve' : ''}`), 5_000).catch((e) => String(e))}`);
    await within('page1 close', page.close()).catch((e) => log(String(e)));
    const context = await app.browser();
    const fresh = await within('newPage', context.newPage());
    fresh.on('console', (m) => log(`fresh console ${m.text()}`));
    fresh.on('requestfailed', (r) => log(`fresh requestfailed ${r.url()} ${r.failure()?.errorText}`));
    fresh.on('websocket', (ws) => { log(`fresh ws ${ws.url()}`); ws.on('close', () => log(`fresh ws closed ${ws.url()}`)); ws.on('framereceived', (f) => log(`fresh ws recv ${String(f.payload).slice(0, 160)}`)); ws.on('framesent', (f) => log(`fresh ws sent ${String(f.payload).slice(0, 160)}`)); });
    await within('goto', fresh.goto(host.url));
    await within('waitForFunction', fresh.waitForFunction(() => 'notes' in window));
    const value = await within('read', fresh.evaluate(() => notes.read()), 120_000);
    assert.equal(value, 'before restart');
  });
});
