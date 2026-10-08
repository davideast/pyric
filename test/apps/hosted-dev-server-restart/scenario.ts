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
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const page = await app.step('write a note from the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'notes' in window);
    await page.evaluate(() => notes.write('before restart'));
    return page;
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
    // Vite's client reloads the open tab on its own after a restart; read
    // from a new tab so that reload cannot interrupt the read.
    await page.close();
    const fresh = await app.page(host.url);
    await fresh.waitForFunction(() => 'notes' in window);
    assert.equal(await fresh.evaluate(() => notes.read()), 'before restart');
  });
});
