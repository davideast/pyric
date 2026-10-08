import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { replayRepro } from '../../../src/serve/repro/index.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

const OPEN = JSON.stringify({ rules: { '.read': true, '.write': true } });
const SIGNED_IN = JSON.stringify({ rules: { '.read': 'auth != null', '.write': 'auth != null' } });
type Res = Extract<OutboundMessage, { t: 'res' }>;

async function host(directory: string, reproWindow?: number) {
  const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
    bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory };
  const waiting = new Map<string, (response: Res) => void>();
  const runtime = await createHostedRuntime(payload, 'http://127.0.0.1:1', (frame: BridgeMessage) => {
    const isReply = frame.type === 'worker-message-result' && frame.message.t === 'res';
    if (isReply) waiting.get(`${frame.clientSessionId}:${(frame.message as Res).id}`)?.(frame.message as Res);
  }, directory, { reproWindow });
  let sequence = 0;
  return {
    runtime,
    request(session: string, message: Record<string, unknown>): Promise<Res> {
      const id = `op-${++sequence}`;
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Hosted request timed out')), 3000);
        waiting.set(`${session}:${id}`, response => { clearTimeout(deadline); resolve(response); });
        runtime.receive({ type: 'worker-message', clientSessionId: session, message: { t: 'op', id, ...message } as InboundMessage });
      });
    },
    subscribe(session: string, subId: string, target: Record<string, unknown>): void {
      runtime.receive({ type: 'worker-message', clientSessionId: session, message: { t: 'sub', subId, target } as InboundMessage });
    },
  };
}
const value = (response: Res): unknown => {
  assert.ok(response.ok, JSON.stringify(response));
  return response.value;
};

/** Record a two-instance session on a host that restarted over seeded data. */
async function record(directory: string, reproWindow?: number) {
  mkdirSync(directory, { recursive: true });
  const seeding = await host(directory);
  try {
    await seeding.runtime.deployRules('database', OPEN, 'first');
    value(await seeding.request('setup', { method: 'rtdb.set', instance: 'first', path: 'items/seeded', value: { by: 'seed' }, actAs: { mode: 'admin' } }));
  } finally { await seeding.runtime.close(); }

  const { runtime, request, subscribe } = await host(directory, reproWindow);
  try {
    await runtime.deployRules('database', OPEN, 'first');
    await runtime.deployRules('database', SIGNED_IN, 'second');
    subscribe('tab-a', 'items', { service: 'rtdb', instance: 'first', path: 'items' });
    value(await request('tab-a', { method: 'rtdb.set', instance: 'first', path: 'probe', value: 'first' }));
    const denied = await request('tab-b', { method: 'rtdb.set', instance: 'second', path: 'probe', value: 'second' });
    assert.equal(denied.ok, false);
    const uid = (value(await request('tab-b', { method: 'auth.signInAnonymously' })) as { user: { uid: string } }).user.uid;
    subscribe('tab-b', 'mine', { service: 'rtdb', instance: 'second', path: `users/${uid}` });
    value(await request('tab-b', { method: 'rtdb.set', instance: 'second', path: `users/${uid}`, value: { name: 'b' } }));
    value(await request('tab-a', { method: 'rtdb.push', instance: 'first', path: 'items', value: { by: 'a' } }));
    value(await request('tab-a', { method: 'rtdb.set', instance: 'first', path: 'probe', value: 'again' }));
    assert.deepEqual((value(await request('tab-b', { method: 'rtdb.get', instance: 'second', path: `users/${uid}` })) as { value: unknown }).value, { name: 'b' });
    value(await request('tab-b', { method: 'auth.getIdToken' }));
    // A signed custom token: the repro keeps its claims and drops its signature.
    const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
    const token = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ uid: 'carol', claims: { role: 'editor' } })}.${Buffer.from('not-a-real-signature-0123456789').toString('base64url')}`;
    const carol = value(await request('tab-c', { method: 'auth.signInWithCustomToken', customToken: token })) as { user: { uid: string } };
    assert.equal(carol.user.uid, 'carol');
    value(await request('tab-c', { method: 'rtdb.set', instance: 'second', path: 'users/carol', value: { role: 'editor' } }));
    // The default instance stays empty: the two named instances hold the data.
    assert.equal((value(await request('tab-a', { method: 'rtdb.get', path: 'probe', actAs: { mode: 'admin' } })) as { value: unknown }).value, null);
    await new Promise(resolve => setTimeout(resolve, 20));
    return { repro: await runtime.captureRepro() as unknown as Record<string, unknown>, token };
  } finally { await runtime.close(); }
}

const root = process.argv[2];
const { repro, token } = await record(join(root, 'whole'));

// Secrets: the token keeps its claims and loses its signature.
const text = JSON.stringify(repro);
assert.equal(text.includes(token), false, 'the raw custom token is in the repro');
assert.equal(text.includes(token.split('.')[2]), false, 'the token signature is in the repro');
assert.ok(text.includes('"__redactedJwt":{"header":{"alg":"RS256","typ":"JWT"},"claims":{"uid":"carol","claims":{"role":"editor"}}}'));
const base = repro.base as { rules: { database: Record<string, unknown> }; databaseInstances: Record<string, unknown> };
assert.equal(repro.truncated, false);
assert.deepEqual(base.rules.database.first, JSON.parse(OPEN));
assert.deepEqual(base.databaseInstances.first, { items: { seeded: { by: 'seed' } } });

// Both planes reproduce the recording and agree with each other.
const report = await replayRepro(repro);
assert.equal(report.ok, true, JSON.stringify(report, null, 2));
assert.ok((report.planes.node?.checked ?? 0) >= 10, JSON.stringify(report.planes.node));
assert.equal(report.planes.worker?.checked, report.planes.node?.checked);

// A recorded result that differs from what the host returns is the first divergence.
const corrupted = JSON.parse(text) as { entries: Array<{ kind: string; session: string; frame: Record<string, unknown> }> };
const reads = corrupted.entries.filter(entry => entry.kind === 'in' && entry.frame.method === 'rtdb.get' && entry.frame.instance === 'second');
assert.equal(reads.length, 1);
const readId = reads[0].frame.id;
const index = corrupted.entries.findIndex(entry => entry.kind === 'out' && entry.session === 'tab-b' && entry.frame.id === readId);
corrupted.entries[index].frame.value = { value: { name: 'corrupted' } };
const diverged = await replayRepro(corrupted);
assert.equal(diverged.ok, false);
for (const plane of ['node', 'worker'] as const) {
  const first = diverged.planes[plane]?.firstDivergence;
  assert.equal(first?.entry, index, JSON.stringify(diverged.planes[plane]));
  assert.equal(first?.operation.method, 'rtdb.get');
  assert.equal(first?.operation.instance, 'second');
  assert.deepEqual(first?.expected, { t: 'res', id: readId, ok: true, value: { value: { name: 'corrupted' } } });
  assert.equal(diverged.planes[plane]?.divergences.length, 1);
}
assert.deepEqual(diverged.planeDifferences, []);

// A bounded log drops old windows and still replays from the starting state it
// keeps, with the signed-in port and the open listeners restored.
const bounded = await record(join(root, 'bounded'), 6);
assert.equal(bounded.repro.truncated, true);
const boundedReport = await replayRepro(bounded.repro);
assert.equal(boundedReport.ok, true, JSON.stringify(boundedReport, null, 2));
console.log('Repro passed');
