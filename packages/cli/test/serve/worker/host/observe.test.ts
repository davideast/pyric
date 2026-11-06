/**
 * A client connection reports a call production answered, and the host
 * writes it to the event stream with the caller it stamps from that
 * connection.
 *
 * Both hosts call `handleMessage`: the SharedWorker for each page port and the
 * Node host for each admitted socket, marked `node` when a server process using
 * the client SDK attached. A malformed record is refused before it reaches the
 * stream, and a frame cannot name its own caller.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, type ObservedCall, type SandboxEvent } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { markPortConnection } from '../../../../src/serve/worker/host/caller.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { requestEnvelopeError } from '../../../../src/bridge/server/request-envelope.js';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';

interface FakePort extends PortLike { messages: OutboundMessage[] }

function fakePort(): FakePort {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage(message) { messages.push(message); } };
}

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return { db: getFirestore(sandbox), sandbox, instanceId: 'observe-test', subs: new Map() };
}

const DENIED_READ: ObservedCall = {
  service: 'firestore',
  method: 'getDoc',
  path: 'rooms/r1',
  at: 1_700_000_000_000,
  durationMs: 31,
  outcome: { status: 'error', code: 'permission-denied' },
  account: { uid: 'alice', claimNames: ['admin'] },
};

let sequence = 0;

/** Subscribe `port` to the event stream, as the chip and Studio do; returns the page id the host named. */
async function subscribe(ctx: HostCtx, port: FakePort): Promise<string | undefined> {
  await handleMessage(ctx, port, { t: 'sub', subId: `events-${++sequence}`, target: 'events' } as InboundMessage);
  const batch = port.messages.find((message) => message.t === 'event');
  return batch?.t === 'event' ? batch.pageId : undefined;
}

/** The events the stream delivered to `port` after its history batch. */
function streamed(port: FakePort): SandboxEvent[] {
  const batches = port.messages.filter((message) => message.t === 'event');
  return batches.slice(1).flatMap((batch) => (batch.t === 'event' ? [...batch.events] : []));
}

async function observe(ctx: HostCtx, port: FakePort, frame: Record<string, unknown>): Promise<OutboundMessage | undefined> {
  const id = `observe-${++sequence}`;
  await handleMessage(ctx, port, { t: 'observe', id, ...frame } as InboundMessage);
  return port.messages.find((message) => message.t === 'res' && message.id === id);
}

describe('host: observed calls', () => {
  it("writes a page's observed call to the event stream with that page's id", async () => {
    const ctx = makeCtx();
    const page = fakePort();
    const pageId = await subscribe(ctx, page);
    expect(pageId).toBeString();
    const reply = await observe(ctx, page, { call: DENIED_READ });
    expect(reply).toMatchObject({ t: 'res', ok: true });
    const [event] = streamed(page);
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'firestore',
      method: 'getDoc',
      path: 'rooms/r1',
      auth: { uid: 'alice' },
      caller: { kind: 'page', pageId },
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: { status: 'error', code: 'permission-denied' }, claimNames: ['admin'] },
      operationContext: { source: { kind: 'app' } },
    });
    expect(ctx.sandbox.history()).toContainEqual(event!);
  });

  it('names a Node host port that a server process attached as node, for every viewer', async () => {
    const ctx = makeCtx();
    const viewer = fakePort();
    await subscribe(ctx, viewer);
    const server = fakePort();
    markPortConnection(ctx, server, 'node');
    const reply = await observe(ctx, server, { call: { service: 'auth', method: 'signInWithEmailAndPassword', at: 1, outcome: { status: 'ok' }, account: { uid: 'bob' } } });
    expect(reply).toMatchObject({ ok: true });
    expect(streamed(viewer)).toEqual([
      expect.objectContaining({ service: 'auth', caller: { kind: 'node' }, production: { outcome: { status: 'ok' } } }),
    ]);
  });

  it('writes an RTDB call with its path, naming a named instance and leaving the default out', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    await subscribe(ctx, page);
    const read = { service: 'rtdb', method: 'get', path: '/items/a', at: 1, outcome: { status: 'ok' }, projectId: 'demo-project' } as const;
    expect(await observe(ctx, page, { call: { ...read, instance: 'demo-project-named' } })).toMatchObject({ ok: true });
    expect(await observe(ctx, page, { call: { ...read, instance: 'demo-project-default-rtdb' } })).toMatchObject({ ok: true });
    const [named, unnamed] = streamed(page);
    expect(named).toMatchObject({
      kind: 'operation',
      service: 'rtdb',
      method: 'get',
      path: '/items/a',
      instance: 'demo-project-named',
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: { status: 'ok' } },
    });
    expect(unnamed).toMatchObject({ service: 'rtdb', method: 'get', path: '/items/a', production: { outcome: { status: 'ok' } } });
    expect(unnamed).not.toHaveProperty('instance');
  });

  it('writes an AI call with its model and token counts, and never a response', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    const pageId = await subscribe(ctx, page);
    const call = {
      service: 'ai',
      method: 'generateContent',
      at: 1,
      durationMs: 80,
      outcome: { status: 'ok' },
      projectId: 'demo-project',
      ai: { model: 'models/gemini-flash-lite-latest', usage: { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 } },
    };
    expect(await observe(ctx, page, { call })).toMatchObject({ ok: true });
    const [event] = streamed(page);
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'ai',
      method: 'generateContent',
      path: 'models/gemini-flash-lite-latest',
      caller: { kind: 'page', pageId },
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: { status: 'ok' } },
      observation: {
        status: 'completed',
        ai: { requestedModel: 'models/gemini-flash-lite-latest', engine: 'gemini', usageSource: 'backend', inputTokens: 9, outputTokens: 2, totalTokens: 11 },
      },
    });
    expect(event?.kind === 'operation' ? event.observation : undefined).not.toHaveProperty('response');
  });

  it('refuses a malformed record with invalid-argument and writes nothing', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    await subscribe(ctx, page);
    const before = ctx.sandbox.history().length;
    const malformed: unknown[] = [
      undefined,
      { ...DENIED_READ, service: 'storage' },
      { ...DENIED_READ, instance: 'demo-project-named' },
      { ...DENIED_READ, service: 'rtdb', instance: 'Not An Instance' },
      { ...DENIED_READ, outcome: { status: 'error' } },
      { ...DENIED_READ, account: { uid: 'alice', token: 'eyJ' } },
      { ...DENIED_READ, caller: { kind: 'admin' } },
      { ...DENIED_READ, ai: { model: 'models/gemini-flash-lite-latest' } },
      { service: 'ai', method: 'generateContent', at: 1, outcome: { status: 'ok' }, ai: { model: 'models/m', text: 'Hello' } },
      { service: 'ai', method: 'generateContent', at: 1, outcome: { status: 'ok' }, ai: { model: 'models/m', usage: { totalTokenCount: '11' } } },
    ];
    for (const call of malformed) {
      const reply = await observe(ctx, page, { call });
      expect(reply).toMatchObject({ t: 'res', ok: false, error: { code: 'invalid-argument' } });
    }
    expect(ctx.sandbox.history().length).toBe(before);
    expect(streamed(page)).toEqual([]);
  });

  it('ignores a caller the frame names for itself', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    const pageId = await subscribe(ctx, page);
    await observe(ctx, page, { call: DENIED_READ, caller: { kind: 'admin' } });
    expect(streamed(page)[0]?.caller).toEqual({ kind: 'page', pageId });
  });

  it('runs no Rules and changes no sandbox state', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    await observe(ctx, page, { call: { ...DENIED_READ, method: 'setDoc', outcome: { status: 'ok' } } });
    // One event: no Rules request, no write, no commit.
    expect(ctx.sandbox.history().map((event) => event.kind)).toEqual(['operation']);
  });

  it('admits an observed call through the bridge socket envelope only with a request id', () => {
    const envelope = (message: Record<string, unknown>) => ({ type: 'worker-message', message }) as unknown as BridgeMessage;
    expect(requestEnvelopeError(envelope({ t: 'observe', id: 'o1', call: DENIED_READ }))).toBeUndefined();
    expect(requestEnvelopeError(envelope({ t: 'observe', call: DENIED_READ }))).toBe('Invalid worker message envelope.');
  });
});
