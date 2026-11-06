// An app whose backend is an onRequest function behind a firebase.json
// Hosting rewrite, run with `pyric sandbox --hosted`, the Node host. No
// browser tab is ever opened: the functions start and answer on their own, as
// a deployed function does. The function writes Firestore through
// firebase-admin, and a registered Node process finds each document in the
// host's store. A page on another site, or one that rebinds its hostname to
// 127.0.0.1, reaches none of the functions, and no other site reaches the two
// that production limits to IAM callers: invoker 'private', and invoker set
// to a service account.
import assert from 'node:assert/strict';
import { request } from 'node:http';
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

/** A raw POST, so the step can send any Host header, as a rebinding page's browser would. */
function rawPost(target: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const { hostname, port, pathname } = new URL(target);
  return new Promise((resolvePost, rejectPost) => {
    const outgoing = request({ host: hostname, port, path: pathname, method: 'POST', headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolvePost({ status: response.statusCode ?? 0, body }));
    });
    outgoing.on('error', rejectPost);
    outgoing.end(JSON.stringify({ text: 'forged' }));
  });
}

export default scenario(async (app) => {
  const port = await app.freePort();
  const url = `http://127.0.0.1:${port}`;
  const sandbox = await app.step('start pyric sandbox --hosted with no browser tab', async () => {
    const child = app.pyricProcess(['sandbox', '--hosted', '--no-open', '--no-run', '--no-capture', '--host', '127.0.0.1', '--port', String(port)], {
      env: { PYRIC_NO_UPDATE_CHECK: '1' },
    });
    await child.waitForLog(/functions 3 onRequest functions:/, { timeoutMs: 60_000 });
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

  await app.step('a foreign Host gets 403 on the emulator path and on the rewrite', async () => {
    const headers = { host: 'attacker.example', 'content-type': 'application/json' };
    for (const target of [`${url}/${PROJECT}/us-central1/api/api/messages`, `${url}/api/messages`]) {
      const refused = await rawPost(target, headers);
      assert.equal(refused.status, 403, `${target}: ${refused.body}`);
    }
  });

  await app.step("the private function refuses another site's Origin and answers a caller with none", async () => {
    const target = `${url}/${PROJECT}/us-central1/reset`;
    const foreign = await fetch(target, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(foreign.status, 403, await foreign.text());
    const server = await fetch(target, { method: 'POST' });
    assert.equal(server.status, 200, await server.text());
    // A cross-site GET carries no Origin; Sec-Fetch-Site still names another site.
    const linked = await fetch(target, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(linked.status, 403, await linked.text());
  });

  await app.step("the service-account function refuses another site's Origin and answers a caller with none", async () => {
    const target = `${url}/${PROJECT}/us-central1/nightly`;
    const foreign = await fetch(target, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'text/plain' }, body: 'x' });
    const refusal = await foreign.text();
    assert.equal(foreign.status, 403, refusal);
    assert.ok(refusal.includes("nightly, which sets an invoker other than 'public'"), refusal);
    const server = await fetch(target, { method: 'POST' });
    assert.equal(server.status, 200, await server.text());
  });

  await app.step('the startup log warns about both functions production limits to IAM callers', async () => {
    await sandbox.waitForLog(/functions export reset sets an invoker other than 'public'/, { timeoutMs: 5_000 });
    await sandbox.waitForLog(/functions export nightly sets an invoker other than 'public'/, { timeoutMs: 5_000 });
  });

  await app.step('a POST to an unknown function name gets 404 naming the functions that exist', async () => {
    const typo = await fetch(`${url}/${PROJECT}/us-central1/apii`, { method: 'POST' });
    const body = await typo.text();
    assert.equal(typo.status, 404, body);
    assert.equal(body, 'Function us-central1-apii does not exist, valid functions are: us-central1-api, us-central1-reset, us-central1-nightly');
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
