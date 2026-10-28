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

/** Settles `pending` within `ms`, or fails naming the browser call that never settled. */
function within<T>(call: string, ms: number, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${call} did not settle within ${ms / 1000}s`)), ms);
  });
  return Promise.race([pending, stuck]).finally(() => clearTimeout(timer));
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

  // Vite's client reloads the open page once the restarted server answers.
  // Playwright's page.close() can hang for good when it lands while a page
  // reloads, so the scenario waits for that reload and reads from the
  // reloaded page instead of closing it.
  let reloaded: Promise<unknown> = Promise.resolve();
  await app.step('edit vite.config.js; Vite restarts the server', async () => {
    const mark = host.process.mark();
    reloaded = page.waitForEvent('load', { timeout: 90_000 });
    // The last step awaits the reload; this keeps a failure before then from going unhandled.
    reloaded.catch(() => {});
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
    await reloaded;
    await page.waitForFunction(() => 'notes' in window, undefined, { timeout: 30_000 });
    const note = await within('page.evaluate(() => notes.read())', 30_000, page.evaluate(() => notes.read()));
    assert.equal(note, 'before restart');
  });
});
