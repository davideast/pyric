// An app with v2 onCall, streaming onCall, and v1 https.onCall functions, plus
// a firebase.json Hosting rewrite to saveItem, run with `pyric sandbox --hosted`.
import assert from 'node:assert/strict';
import { scenario, sleep } from '../driver.ts';

const PROJECT = 'demo-functions-callable';

async function postCallable(
  target: string,
  data: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; json: Record<string, unknown> | null }> {
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ data }),
  });
  const body = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, body, json };
}

export default scenario(async (app) => {
  const port = await app.freePort();
  const url = `http://127.0.0.1:${port}`;
  const sandbox = await app.step('start pyric sandbox --hosted with v2 and v1 onCall exports', async () => {
    const child = app.pyricProcess(
      ['sandbox', '--hosted', '--no-open', '--no-run', '--no-capture', '--host', '127.0.0.1', '--port', String(port)],
      { env: { PYRIC_NO_UPDATE_CHECK: '1' } },
    );
    await child.waitForLog(/functions 3 onCall functions:/, { timeoutMs: 60_000 });
    return child;
  });

  const idToken = await app.step('sign in on the Node host and obtain a sandbox ID token', async () => {
    const minted = await app.serverScript('admin-helper.mjs', ['mint-id-token', 'author-1'], {
      env: { PYRIC_SANDBOX: `remote:${url}` },
      timeoutMs: 30_000,
    });
    const match = minted.output.match(/^ID_TOKEN (\S+)$/m);
    assert.ok(match?.[1], minted.output);
    return match[1];
  });

  await app.step('unauthenticated and forged-token calls are refused properly', async () => {
    const unauth = await postCallable(`${url}/saveItem`, { title: 'blocked' });
    assert.equal(unauth.status, 401, unauth.body);

    let replacement = 'A';
    if (idToken.endsWith('A')) replacement = 'B';
    const forged = `${idToken.slice(0, -1)}${replacement}`;
    const rejected = await postCallable(`${url}/saveItem`, { title: 'forged' }, {
      authorization: `Bearer ${forged}`,
    });
    assert.equal(rejected.status, 401, rejected.body);
  });

  const savedRewrite = await app.step('authenticated call via /saveItem Hosting rewrite writes Firestore', async () => {
    const res = await postCallable(`${url}/saveItem`, { title: 'via rewrite' }, {
      authorization: `Bearer ${idToken}`,
    });
    assert.equal(res.status, 200, res.body);
    return res.json?.result as { id: string; ownerUid: string };
  });

  const savedDirect = await app.step('authenticated call via emulator path writes Firestore and v1 onCall answers', async () => {
    const res = await postCallable(`${url}/${PROJECT}/us-central1/saveItem`, { title: 'via emulator path' }, {
      authorization: `Bearer ${idToken}`,
    });
    assert.equal(res.status, 200, res.body);

    const legacy = await postCallable(`${url}/${PROJECT}/us-central1/legacyEcho`, { ping: true }, {
      authorization: `Bearer ${idToken}`,
    });
    assert.equal(legacy.status, 200, legacy.body);
    assert.deepEqual(legacy.json, { result: { data: { ping: true }, uid: 'author-1' } });
    return res.json?.result as { id: string; ownerUid: string };
  });

  await app.step('streaming onCall delivers SSE message frames and final result frame', async () => {
    const res = await postCallable(
      `${url}/${PROJECT}/us-central1/streamItems`,
      { count: 2 },
      { accept: 'text/event-stream' },
    );
    assert.equal(res.status, 200, res.body);
    assert.match(res.body, /data: \{"message":\{"index":1\}\}/);
    assert.match(res.body, /data: \{"message":\{"index":2\}\}/);
    assert.match(res.body, /data: \{"result":\{"sent":2\}\}/);
  });

  await app.step('registered Node process reads both saved items from the host store', async () => {
    assert.equal(savedRewrite.ownerUid, 'author-1');
    assert.equal(savedDirect.ownerUid, 'author-1');
    const read = await app.serverScript('admin-helper.mjs', ['read-items', savedRewrite.id, savedDirect.id], {
      env: { PYRIC_SANDBOX: `remote:${url}` },
      timeoutMs: 30_000,
    });
    assert.ok(
      read.output.includes(`${savedRewrite.id}: {"title":"via rewrite","ownerUid":"author-1"}`),
      read.output,
    );
    assert.ok(
      read.output.includes(`${savedDirect.id}: {"title":"via emulator path","ownerUid":"author-1"}`),
      read.output,
    );
  });

  await app.step('each served call printed one callable execution line', async () => {
    const callableLines = () =>
      sandbox.output.split('\n').filter((line) => line.includes('<- callable '));
    const deadline = Date.now() + 5_000;
    while (callableLines().length < 6 && Date.now() < deadline) await sleep(50);
    assert.equal(callableLines().length, 6, callableLines().join('\n'));
  });
});
