// An app whose backend is an onRequest function behind a firebase.json
// Hosting rewrite, run with `pyric sandbox` as a user runs it. The page calls
// /api/messages same-origin; the function writes Firestore through
// firebase-admin; the page reads the document back. The emulator path answers
// too, and both say why they cannot serve before a browser tab connects.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface Added {
  status: number;
  path: string;
  stored: { text: string; cookie: string | null } | null;
}

declare function addMessage(text: string): Promise<Added>;

const PROJECT = 'demo-functions-http';

export default scenario(async (app) => {
  const port = await app.freePort();
  const url = `http://127.0.0.1:${port}`;
  const sandbox = await app.step('start pyric sandbox', async () => {
    const child = app.serverProcess('pyric.mjs', ['sandbox', '--no-open', '--no-capture', '--host', '127.0.0.1', '--port', String(port)]);
    await child.waitForLog(/functions waiting for the browser tab/, { timeoutMs: 60_000 });
    return child;
  });

  await app.step('before a tab connects, the rewrite and the emulator path answer 503 naming the cause', async () => {
    for (const target of [`${url}/api/messages`, `${url}/${PROJECT}/us-central1/api/api/messages`]) {
      const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"early"}' });
      assert.equal(response.status, 503, target);
      assert.match(await response.text(), /no browser tab is connected/);
    }
  });

  const page = await app.step('open the page; the functions start', async () => {
    const opened = await app.page(url);
    await opened.waitForFunction(() => 'addMessage' in window);
    await sandbox.waitForLog(/functions 1 onRequest function:/, { timeoutMs: 60_000 });
    return opened;
  });

  await app.step('the page posts through /api/** and reads what the function wrote', async () => {
    const added = await page.evaluate(() => addMessage('hello from the page'));
    assert.equal(added.status, 201);
    // The rewrite hands the function the full original path.
    assert.equal(added.path, '/api/messages');
    // Hosting forwards only the __session cookie.
    assert.deepEqual(added.stored, { text: 'hello from the page', cookie: '__session=page-session' });
  });

  await app.step('the emulator path reaches the same function with the prefix stripped', async () => {
    const response = await fetch(`${url}/${PROJECT}/us-central1/api/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text":"from curl"}',
    });
    assert.equal(response.status, 201);
    assert.equal(((await response.json()) as { path: string }).path, '/api/messages');
  });

  await app.step('each request lands one execution log line', async () => {
    await sandbox.waitForLog(/✔ function {2}api ← POST \/api\/messages 201/);
    const lines = sandbox.output.split('\n').filter((line) => line.includes('function  api ← POST /api/messages 201'));
    assert.equal(lines.length, 2, lines.join('\n'));
  });
});
