import { expect, test } from 'bun:test';
import { createBridge } from '../../../src/bridge/server/bridge.js';
import { createSilentLogger } from '../../../src/bridge/server/logger.js';
import { parseBridgeMessage } from '../../../src/bridge/server/request-envelope.js';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../src/bridge/protocol.js';

function fixture(callTimeoutMs = 1_000) {
  const frames: BridgeMessage[] = [];
  const diagnostics: string[] = [];
  const bridge = createBridge({
    version: 'test', callTimeoutMs,
    logger: { ...createSilentLogger(), error(line: string) { diagnostics.push(line); } },
  });
  const disconnect = bridge.registerSandboxPeer(frame => frames.push(frame), ['echo'], 'peer', [WORKER_RELAY_CAPABILITY]);
  function deliver(frame: unknown) {
    const parsed = parseBridgeMessage(JSON.stringify(frame));
    if (parsed.kind === 'invalid') throw new Error(parsed.reason);
    bridge.handleSandboxMessage(parsed.message);
  }
  function worker(owner: string) {
    return bridge.dispatchWorkerOp({ method: 'getVersion' }, owner).then(
      value => ({ value }), error => ({ code: error.code, message: error.message }),
    );
  }
  function tool(owner: string) { return bridge.dispatch('echo', {}, undefined, owner); }
  return { bridge, frames, diagnostics, disconnect, deliver, worker, tool };
}

for (const type of ['tool-result', 'worker-res']) {
  for (const id of [null, 7]) {
    test(`${type} with id ${id} leaves every correlated call intact and reports one diagnostic`, async () => {
      const f = fixture();
      try {
        const workers = [f.worker('alice'), f.worker('bob')];
        const tools = [f.tool('alice'), f.tool('bob')];
        f.deliver({ type, id, ok: true, value: 'private-payload', result: { ok: true, summary: 'private-payload' } });
        for (const frame of f.frames) {
          if (frame.type === 'worker-op') f.deliver({ type: 'worker-res', id: frame.id, ok: true, value: frame.clientSessionId });
          if (frame.type === 'tool-call') f.deliver({ type: 'tool-result', id: frame.id, ok: true, result: { ok: true, summary: frame.callerId } });
        }
        expect(await Promise.all(workers)).toEqual([{ value: 'alice' }, { value: 'bob' }]);
        expect(await Promise.all(tools)).toEqual([{ ok: true, summary: 'alice', data: undefined }, { ok: true, summary: 'bob', data: undefined }]);
        expect(f.diagnostics).toEqual([`Discarded ${type}: no usable request id.`]);
        expect(f.frames).toHaveLength(4);
      } finally { f.disconnect(); }
    });
  }
}

test('an uncorrelatable reply leaves the unanswered calls subject to their original deadlines without replay', async () => {
  const f = fixture(30);
  try {
    const worker = f.worker('alice');
    const tool = f.tool('bob');
    f.deliver({ type: 'worker-res', id: null, ok: true, value: 'private-payload' });
    f.deliver({ type: 'tool-result', id: null, ok: true, result: { ok: true, summary: 'private-payload' } });
    expect(await worker).toMatchObject({ code: 'deadline-exceeded' });
    expect(await tool).toMatchObject({ ok: false, summary: 'sandbox call timed out after 30ms (tool: echo)' });
    expect(f.diagnostics).toEqual([
      'Discarded worker-res: no usable request id.',
      'Discarded tool-result: no usable request id.',
    ]);
    expect(f.frames).toHaveLength(2);
  } finally { f.disconnect(); }
});

test('a malformed known-id result still fails only its own worker or tool call', async () => {
  const f = fixture();
  try {
    const workers = [f.worker('alice'), f.worker('bob')];
    const tools = [f.tool('alice'), f.tool('bob')];
    for (const frame of f.frames) {
      if (frame.type === 'worker-op') {
        const isMalformed = frame.clientSessionId === 'alice';
        f.deliver({ type: 'worker-res', id: frame.id, ok: isMalformed ? 'invalid' : true, value: 'healthy' });
      }
      if (frame.type === 'tool-call') {
        const isMalformed = frame.callerId === 'alice';
        f.deliver({ type: 'tool-result', id: frame.id, ok: true, result: isMalformed ? null : { ok: true, summary: 'healthy' } });
      }
    }
    expect(await workers[0]).toMatchObject({ code: 'unavailable' });
    expect(await workers[1]).toEqual({ value: 'healthy' });
    expect(await tools[0]).toEqual({ ok: false, summary: 'The sandbox sent a malformed tool reply.' });
    expect(await tools[1]).toMatchObject({ ok: true, summary: 'healthy' });
    expect(f.diagnostics).toEqual([]);
  } finally { f.disconnect(); }
});

test('a malformed subscription id leaves two live subscriptions intact and reports one diagnostic', () => {
  const f = fixture();
  const alice: unknown[] = [];
  const bob: unknown[] = [];
  const stopAlice = f.bridge.subscribeWorker({ target: { __ref: 'doc', path: 'notes/alice' } }, value => alice.push(value), 'alice');
  const stopBob = f.bridge.subscribeWorker({ target: { __ref: 'doc', path: 'notes/bob' } }, value => bob.push(value), 'bob');
  try {
    const subscriptions = f.frames.filter(frame => frame.type === 'worker-sub');
    for (const frame of subscriptions) f.deliver({ type: 'worker-snap', subId: frame.subId, value: { owner: frame.clientSessionId, version: 1 } });
    f.deliver({ type: 'worker-snap', subId: null, value: 'private-payload' });
    for (const frame of subscriptions) f.deliver({ type: 'worker-snap', subId: frame.subId, value: { owner: frame.clientSessionId, version: 2 } });
    expect(alice).toEqual([{ owner: 'alice', version: 1 }, { owner: 'alice', version: 2 }]);
    expect(bob).toEqual([{ owner: 'bob', version: 1 }, { owner: 'bob', version: 2 }]);
    expect(f.diagnostics).toEqual(['Discarded worker-snap: no usable subscription id.']);
  } finally { stopAlice(); stopBob(); f.disconnect(); }
});
