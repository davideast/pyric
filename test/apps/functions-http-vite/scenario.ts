// The same app as functions-http-hosting-rewrite, run with the `pyric()` Vite
// plugin instead of `pyric sandbox`: unchanged page and functions source, the
// /api/** rewrite served by the dev server, and the emulator path beside it.
import assert from 'node:assert/strict';
import { scenario, sleep } from '../driver.ts';

interface Added {
  status: number;
  path: string;
  stored: { text: string; cookie: string | null } | null;
}

declare function addMessage(text: string): Promise<Added>;

const PROJECT = 'demo-functions-http';

export default scenario(async (app) => {
  const host = await app.step('start the Vite dev server', () => app.devServer());

  await app.step('before a tab connects, /api/** answers 503 naming the cause', async () => {
    const response = await fetch(`${host.url}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"early"}' });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /no browser tab is connected/);
  });

  const page = await app.step('open the page; the functions start', async () => {
    const opened = await app.page(host.url);
    await opened.waitForFunction(() => 'addMessage' in window);
    await host.process.waitForLog(/functions 1 onRequest function:/, { timeoutMs: 60_000 });
    return opened;
  });

  await app.step('the page posts through /api/** and reads what the function wrote', async () => {
    const added = await page.evaluate(() => addMessage('hello from vite'));
    assert.equal(added.status, 201);
    assert.equal(added.path, '/api/messages');
    assert.deepEqual(added.stored, { text: 'hello from vite', cookie: '__session=page-session' });
  });

  await app.step('the emulator path reaches the same function', async () => {
    const response = await fetch(`${host.url}/${PROJECT}/us-central1/api/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text":"from curl"}',
    });
    assert.equal(response.status, 201);
  });

  await app.step('each request lands one execution log line', async () => {
    // A line is written when the response closes, which can trail the response the client read.
    const executionLines = () => host.process.output.split('\n').filter((line) => line.includes('function  api ← POST /api/messages 201'));
    const deadline = Date.now() + 10_000;
    while (executionLines().length < 2 && Date.now() < deadline) await sleep(50);
    assert.equal(executionLines().length, 2, executionLines().join('\n'));
  });
});
