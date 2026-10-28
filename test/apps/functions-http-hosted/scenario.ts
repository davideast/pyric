// An app whose backend is an onRequest function behind a firebase.json
// Hosting rewrite, run with `pyric sandbox --hosted`, the Node host. No
// browser tab is ever opened: the functions start and answer on their own, as
// a deployed function does. The function writes Firestore through
// firebase-admin, and a registered Node process finds each document in the
// host's store.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface Added {
  id: string;
  path: string;
}

const PROJECT = 'demo-functions-http';

async function post(target: string, text: string): Promise<Added> {
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await response.text();
  assert.equal(response.status, 201, `${target}: ${body}`);
  return JSON.parse(body) as Added;
}

export default scenario(async (app) => {
  const port = await app.freePort();
  const url = `http://127.0.0.1:${port}`;
  const sandbox = await app.step('start pyric sandbox --hosted with no browser tab', async () => {
    const child = app.pyricProcess(['sandbox', '--hosted', '--no-open', '--no-run', '--no-capture', '--host', '127.0.0.1', '--port', String(port)], {
      env: { PYRIC_NO_UPDATE_CHECK: '1' },
    });
    await child.waitForLog(/functions 1 onRequest function:/, { timeoutMs: 60_000 });
    return child;
  });

  const rewritten = await app.step('a Node fetch to the /api/** rewrite reaches the function with the full path', async () => {
    const added = await post(`${url}/api/messages`, 'through the rewrite');
    assert.equal(added.path, '/api/messages');
    return added;
  });

  const direct = await app.step('a Node fetch to the emulator path reaches the function with the prefix stripped', async () => {
    const added = await post(`${url}/${PROJECT}/us-central1/api/api/messages`, 'through the emulator path');
    assert.equal(added.path, '/api/messages');
    return added;
  });

  await app.step("a registered Node process reads both documents from the host's store", async () => {
    const result = await app.serverScript('admin-read.mjs', [rewritten.id, direct.id], {
      env: { PYRIC_SANDBOX: `remote:${url}` },
      timeoutMs: 30_000,
    });
    assert.ok(result.output.includes(`${rewritten.id}: {"text":"through the rewrite"}`), result.output);
    assert.ok(result.output.includes(`${direct.id}: {"text":"through the emulator path"}`), result.output);
  });

  await app.step('the sandbox is still running', () => {
    assert.ok(sandbox.running, sandbox.output);
  });
});
