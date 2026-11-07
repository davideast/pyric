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
import { activeListeners, initializeSandbox, type ObservedCall, type SandboxEvent } from 'pyric/sandbox';
import { incidentsFromEvents } from '../../../../src/serve/runtime/listener-incidents.js';
import { getFirestore } from 'pyric/firestore';
import { cleanupPort, handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import { markPortConnection } from '../../../../src/serve/worker/host/caller.js';
import { heldLiveCallValueCount, liveCallValues, observedPortInterrupted, observedPortResumed } from '../../../../src/serve/worker/host/observe.js';
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
      result: 'deny',
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
      expect.objectContaining({ service: 'auth', caller: { kind: 'node', clientId: expect.any(String) }, production: { outcome: { status: 'ok' } } }),
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

  it('writes a Storage call with its path and its bucket as detail.bucket', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    const pageId = await subscribe(ctx, page);
    const call = {
      service: 'storage',
      method: 'uploadBytes',
      path: 'pyric-live-capture/replay/a.bin',
      bucket: 'demo-project-live-second',
      at: 1,
      durationMs: 12,
      outcome: { status: 'error', code: 'storage/unauthorized' },
      account: { uid: 'alice' },
      projectId: 'demo-project',
    };
    expect(await observe(ctx, page, { call })).toMatchObject({ ok: true });
    const [event] = streamed(page);
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'storage',
      method: 'uploadBytes',
      path: 'pyric-live-capture/replay/a.bin',
      detail: { bucket: 'demo-project-live-second' },
      auth: { uid: 'alice' },
      result: 'deny',
      caller: { kind: 'page', pageId },
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: { status: 'error', code: 'storage/unauthorized' } },
    });
  });

  it('writes a Messaging getToken with the requests it made as detail.requests, and no path', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    const pageId = await subscribe(ctx, page);
    const requests = [
      { api: 'installations', action: 'create', status: 200 },
      { api: 'registrations', action: 'create', status: 403 },
    ];
    const call = {
      service: 'messaging',
      method: 'getToken',
      at: 1,
      durationMs: 140,
      outcome: { status: 'error', code: 'permission_denied' },
      account: { uid: 'alice' },
      projectId: 'demo-project',
      requests,
    };
    expect(await observe(ctx, page, { call })).toMatchObject({ ok: true });
    const [event] = streamed(page);
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'messaging',
      method: 'getToken',
      detail: { requests },
      auth: { uid: 'alice' },
      result: 'deny',
      caller: { kind: 'page', pageId },
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: { status: 'error', code: 'permission_denied' } },
    });
    expect(event).not.toHaveProperty('path');
  });

  it("writes production's usage and billed documents onto the event's production side", async () => {
    const ctx = makeCtx();
    const page = fakePort();
    const pageId = await subscribe(ctx, page);
    const usage = { documentReads: 3, payloadBytes: 640 };
    const call = { service: 'firestore', method: 'onSnapshot', path: 'rooms', at: 1, outcome: { status: 'ok' }, usage, billedDocuments: 3 };
    expect(await observe(ctx, page, { call })).toMatchObject({ ok: true });
    const [event] = streamed(page);
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'firestore',
      method: 'onSnapshot',
      caller: { kind: 'page', pageId },
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
    });
    expect(event?.kind === 'operation' ? event.production : undefined).toEqual({ outcome: { status: 'ok' }, usage, billedDocuments: 3 });
  });

  it("writes a server process's Admin call as bypassing rules under the Admin lens, with production's answer", async () => {
    const ctx = makeCtx();
    const viewer = fakePort();
    await subscribe(ctx, viewer);
    const server = fakePort();
    markPortConnection(ctx, server, 'node');
    const call = {
      service: 'firestore',
      method: 'DocumentReference.update',
      path: 'rooms/missing',
      at: 1,
      durationMs: 9,
      outcome: { status: 'error', code: 'not-found' },
      projectId: 'demo-project',
      writeData: { title: 'x' },
      sdk: 'admin',
    };
    expect(await observe(ctx, server, { call })).toMatchObject({ ok: true });
    const [event] = streamed(viewer);
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'firestore',
      method: 'DocumentReference.update',
      path: 'rooms/missing',
      result: 'error',
      caller: { kind: 'node', clientId: expect.any(String) },
      authLens: { mode: 'admin' },
      detail: { sdk: 'admin' },
      rulesDisposition: { kind: 'bypassed', reason: 'admin' },
      production: { outcome: { status: 'error', code: 'not-found' } },
    });
    // Admin calls bypass Security Rules, so the host records no local verdict.
    expect(event?.kind === 'operation' ? event.production : undefined).toEqual({ outcome: { status: 'error', code: 'not-found' } });
  });

  it("writes a server process's Admin Messaging call as an Admin operation, with production's answer", async () => {
    const ctx = makeCtx();
    const viewer = fakePort();
    await subscribe(ctx, viewer);
    const server = fakePort();
    markPortConnection(ctx, server, 'node');
    const before = ctx.sandbox.history().length;
    const call = { service: 'messaging', method: 'Messaging.send', at: 1, outcome: { status: 'ok' }, projectId: 'demo-project', sdk: 'admin' };
    expect(await observe(ctx, server, { call })).toMatchObject({ ok: true });
    expect(ctx.sandbox.history().length).toBe(before + 1);
    const [event] = streamed(viewer);
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'messaging',
      method: 'Messaging.send',
      caller: { kind: 'node', clientId: expect.any(String) },
      detail: { sdk: 'admin' },
      production: { outcome: { status: 'ok' } },
    });
  });

  it('refuses sdk on an AI call, and any value but admin, and writes nothing', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    await subscribe(ctx, page);
    const before = ctx.sandbox.history().length;
    const malformed: unknown[] = [
      { service: 'ai', method: 'generateContent', at: 1, outcome: { status: 'ok' }, ai: { model: 'models/m' }, sdk: 'admin' },
      { ...DENIED_READ, sdk: 'client' },
      { service: 'messaging', method: 'Messaging.send', at: 1, outcome: { status: 'ok' }, sdk: 'client' },
    ];
    for (const call of malformed) {
      expect(await observe(ctx, page, { call })).toMatchObject({ t: 'res', ok: false, error: { code: 'invalid-argument' } });
    }
    expect(ctx.sandbox.history().length).toBe(before);
  });

  it('refuses a malformed record with invalid-argument and writes nothing', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    await subscribe(ctx, page);
    const before = ctx.sandbox.history().length;
    const malformed: unknown[] = [
      undefined,
      { ...DENIED_READ, service: 'functions' },
      { ...DENIED_READ, bucket: 'demo-project.firebasestorage.app' },
      { service: 'storage', method: 'getBytes', path: 'a.bin', at: 1, outcome: { status: 'ok' } },
      { service: 'storage', method: 'getBytes', path: 'a.bin', bucket: 'gs://demo-project.firebasestorage.app', at: 1, outcome: { status: 'ok' } },
      { ...DENIED_READ, instance: 'demo-project-named' },
      { ...DENIED_READ, service: 'rtdb', instance: 'Not An Instance' },
      { ...DENIED_READ, outcome: { status: 'error' } },
      { ...DENIED_READ, account: { uid: 'alice', token: 'eyJ' } },
      { ...DENIED_READ, caller: { kind: 'admin' } },
      { ...DENIED_READ, ai: { model: 'models/gemini-flash-lite-latest' } },
      { service: 'ai', method: 'generateContent', at: 1, outcome: { status: 'ok' }, ai: { model: 'models/m', text: 'Hello' } },
      { service: 'ai', method: 'generateContent', at: 1, outcome: { status: 'ok' }, ai: { model: 'models/m', usage: { totalTokenCount: '11' } } },
      { ...DENIED_READ, requests: [{ api: 'installations', action: 'create', status: 200 }] },
      { ...DENIED_READ, usage: { documentReads: -1 } },
      { ...DENIED_READ, usage: { documentReads: 1.5 } },
      { ...DENIED_READ, usage: { documentReads: 1, bytes: 9 } },
      { service: 'messaging', method: 'getToken', at: 1, outcome: { status: 'ok' }, requests: [{ api: 'registrations', action: 'subscribe' }] },
      { service: 'messaging', method: 'getToken', at: 1, outcome: { status: 'ok' }, requests: [{ api: 'registrations', action: 'create', token: 'dGVzdEZpZDAxMjM0NTY3:APA91bH7xVb0nU3sKq9Yw2Zr5tLp8mQe4cJd6fGh1iOa' }] },
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

  it("keeps a live call's values only while the history holds its event", async () => {
    const ctx = makeCtx();
    const page = fakePort();
    const withValues = { ...DENIED_READ, account: { uid: 'alice', claims: { admin: true } } };
    for (let round = 0; round < 3; round++) {
      for (let index = 0; index < 300; index++) await observe(ctx, page, { call: withValues });
      ctx.sandbox.reset();
    }
    // Observing alone prunes what earlier resets dropped: the last round's 300 and at most one earlier round's.
    expect(heldLiveCallValueCount(ctx.sandbox)).toBeLessThanOrEqual(600);
    expect(liveCallValues(ctx.sandbox).size).toBe(0);
    await observe(ctx, page, { call: withValues });
    const held = ctx.sandbox.history().filter((event) => event.kind === 'operation').map((event) => event.id);
    expect([...liveCallValues(ctx.sandbox).keys()]).toEqual(held);
  });

  it('admits an observed call through the bridge socket envelope only with a request id', () => {
    const envelope = (message: Record<string, unknown>) => ({ type: 'worker-message', message }) as unknown as BridgeMessage;
    expect(requestEnvelopeError(envelope({ t: 'observe', id: 'o1', call: DENIED_READ }))).toBeUndefined();
    expect(requestEnvelopeError(envelope({ t: 'observe', call: DENIED_READ }))).toBe('Invalid worker message envelope.');
  });
});

/** A live `onSnapshot` on one document, as the row records its attach or detach. */
function roomListener(phase: 'attach' | 'detach', id: string, at = 1_700_000_000_000): ObservedCall {
  return {
    service: 'firestore',
    method: 'onSnapshot',
    path: 'rooms/r1',
    at,
    outcome: { status: 'ok' },
    account: { uid: 'alice' },
    listener: { phase, id, target: 'rooms/r1', key: '0123456789abcdef' },
  };
}

describe('host: observed listener lifecycle', () => {
  it('writes attach and detach as listener events with the caller, and no production answer', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    const pageId = await subscribe(ctx, page);
    expect(await observe(ctx, page, { call: roomListener('attach', 'l-1') })).toMatchObject({ ok: true });
    expect(await observe(ctx, page, { call: roomListener('detach', 'l-1', 1_700_000_000_500) })).toMatchObject({ ok: true });
    const [attach, detach] = streamed(page);
    const shared = {
      kind: 'listener',
      service: 'firestore',
      target: { kind: 'doc', path: 'rooms/r1' },
      auth: { uid: 'alice' },
      caller: { kind: 'page', pageId },
      activity: { listenerId: 'l-1' },
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      operationContext: { source: { kind: 'app' } },
    };
    expect(attach).toMatchObject({ ...shared, phase: 'attach' });
    expect(detach).toMatchObject({ ...shared, phase: 'detach', listenerId: (attach as { listenerId: string }).listenerId });
    expect(attach).not.toHaveProperty('production');
    expect(ctx.sandbox.history().map((event) => event.kind)).toEqual(['listener', 'listener']);
  });

  it("keeps a page's and a Node process's listeners apart when both mint the same id", async () => {
    const ctx = makeCtx();
    const page = fakePort();
    await subscribe(ctx, page);
    const server = fakePort();
    markPortConnection(ctx, server, 'node');
    await observe(ctx, page, { call: roomListener('attach', 'l-1') });
    await observe(ctx, server, { call: roomListener('attach', 'l-1') });
    expect(activeListeners(ctx.sandbox.history())).toEqual([
      expect.objectContaining({ target: 'rooms/r1', clientListenerId: 'l-1' }),
      expect.objectContaining({ target: 'rooms/r1', clientListenerId: 'l-1' }),
    ]);
    await observe(ctx, server, { call: roomListener('detach', 'l-1') });
    const [left] = activeListeners(ctx.sandbox.history());
    expect(activeListeners(ctx.sandbox.history())).toHaveLength(1);
    expect(left?.attachedAt).toBe(1_700_000_000_000);
    const pageAttach = ctx.sandbox.history()[0] as { listenerId: string; caller?: { kind: string } };
    expect(pageAttach.caller?.kind).toBe('page');
    expect(left?.id).toBe(pageAttach.listenerId);
  });

  it('raises the duplicate-listener and churn incidents the activity monitor reads', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    for (const id of ['d-1', 'd-2', 'd-3']) await observe(ctx, page, { call: roomListener('attach', id) });
    for (let cycle = 0; cycle < 4; cycle++) {
      const at = 1_700_000_001_000 + cycle * 100;
      const churn = (phase: 'attach' | 'detach') => ({ ...roomListener(phase, `c-${cycle}`, at), path: 'rooms/r2', listener: { phase, id: `c-${cycle}`, target: 'rooms/r2' } });
      await observe(ctx, page, { call: churn('attach') });
      await observe(ctx, page, { call: churn('detach') });
    }
    const patterns = incidentsFromEvents(ctx.sandbox.history()).map((incident) => incident.pattern);
    expect(patterns).toContain('duplicate-listener');
    expect(patterns).toContain('listener-churn');
  });

  it('refuses a listener record that carries a value, and writes nothing', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    const attach = roomListener('attach', 'l-1');
    const malformed = [
      { ...attach, listener: { ...attach.listener, target: 'a'.repeat(1501) } },
      { ...attach, listener: { ...attach.listener, key: JSON.stringify(['doc', 'rooms/r1']) } },
      { ...attach, listener: { ...attach.listener, phase: 'delivery' } },
      { ...attach, service: 'storage', bucket: 'demo.firebasestorage.app' },
    ];
    for (const call of malformed) {
      expect(await observe(ctx, page, { call })).toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
    }
    expect(ctx.sandbox.history()).toEqual([]);
  });
});

describe('host: listeners a port leaves behind', () => {
  it('scopes the same page-minted id apart on two ports that name no page or client', async () => {
    const ctx = makeCtx();
    const first = fakePort();
    const second = fakePort();
    await observe(ctx, first, { call: roomListener('attach', 'l-1') });
    await observe(ctx, second, { call: roomListener('attach', 'l-1') });
    const [one, two] = ctx.sandbox.history() as Array<{ listenerId: string }>;
    expect(one?.listenerId).not.toBe(two?.listenerId);
    await observe(ctx, second, { call: roomListener('detach', 'l-1') });
    expect(activeListeners(ctx.sandbox.history()).map((listener) => listener.id)).toEqual([one!.listenerId]);
  });

  it('detaches, when the port closes, only the listeners it never detached', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    await subscribe(ctx, page);
    await observe(ctx, page, { call: roomListener('attach', 'l-1') });
    await observe(ctx, page, { call: roomListener('attach', 'l-2') });
    await observe(ctx, page, { call: roomListener('detach', 'l-2') });
    const before = ctx.sandbox.history().length;
    cleanupPort(ctx, page);
    const swept = ctx.sandbox.history().slice(before) as Array<{ kind: string; phase: string; activity?: { listenerId?: string } }>;
    expect(swept.map((event) => [event.kind, event.phase, event.activity?.listenerId])).toEqual([['listener', 'detach', 'l-1']]);
    expect(activeListeners(ctx.sandbox.history())).toEqual([]);
    cleanupPort(ctx, page);
    expect(ctx.sandbox.history()).toHaveLength(before + 1);
  });

  it('raises no duplicate-listener incident when a reloaded page attaches its listeners again', async () => {
    const ctx = makeCtx();
    for (let load = 0; load < 3; load++) {
      const page = fakePort();
      for (const id of ['l-1', 'l-2']) {
        await observe(ctx, page, { call: roomListener('attach', id, 1_700_000_000_000 + load * 10_000) });
      }
      cleanupPort(ctx, page);
    }
    expect(activeListeners(ctx.sandbox.history())).toEqual([]);
    const patterns = incidentsFromEvents(ctx.sandbox.history()).map((incident) => incident.pattern);
    expect(patterns).not.toContain('duplicate-listener');
  });
});

/** A Node host socket, as the hosted runtime admits a server process's connection. */
function nodePort(ctx: HostCtx): FakePort {
  const port = fakePort();
  markPortConnection(ctx, port, 'node');
  return port;
}

/** The label the live rows' sender sends for one project root and entry script. */
const ENTRY = '5f1d2c3b4a5968778695a4b3c2d1e0f1';

describe('host: listeners a restarted Node process leaves behind', () => {
  it('detaches the old connection\'s listeners when the same entry script connects again', async () => {
    const ctx = makeCtx();
    for (let run = 0; run < 3; run++) {
      const job = nodePort(ctx);
      await observe(ctx, job, { call: roomListener('attach', 'l-1', 1_700_000_000_000 + run * 1_000), nodeClient: ENTRY });
      observedPortInterrupted(ctx, job);
    }
    expect(activeListeners(ctx.sandbox.history())).toHaveLength(1);
    const patterns = incidentsFromEvents(ctx.sandbox.history()).map((incident) => incident.pattern);
    expect(patterns).not.toContain('duplicate-listener');
  });

  it('detaches them when the old connection closes after the new one attached', async () => {
    const ctx = makeCtx();
    const before = nodePort(ctx);
    const after = nodePort(ctx);
    await observe(ctx, before, { call: roomListener('attach', 'l-1'), nodeClient: ENTRY });
    await observe(ctx, after, { call: roomListener('attach', 'l-1'), nodeClient: ENTRY });
    expect(activeListeners(ctx.sandbox.history())).toHaveLength(2);
    observedPortInterrupted(ctx, before);
    expect(activeListeners(ctx.sandbox.history())).toHaveLength(1);
  });

  it('leaves two running processes of one entry script their own listeners', async () => {
    const ctx = makeCtx();
    for (const worker of [nodePort(ctx), nodePort(ctx)]) {
      await observe(ctx, worker, { call: roomListener('attach', 'l-1'), nodeClient: ENTRY });
    }
    expect(activeListeners(ctx.sandbox.history())).toHaveLength(2);
  });

  it('keeps the listeners of a connection that resumed before the next one attached', async () => {
    const ctx = makeCtx();
    const job = nodePort(ctx);
    await observe(ctx, job, { call: roomListener('attach', 'l-1'), nodeClient: ENTRY });
    observedPortInterrupted(ctx, job);
    observedPortResumed(ctx, job);
    await observe(ctx, nodePort(ctx), { call: roomListener('attach', 'l-2'), nodeClient: ENTRY });
    expect(activeListeners(ctx.sandbox.history())).toHaveLength(2);
  });

  it('leaves another entry script\'s listeners and a page\'s alone', async () => {
    const ctx = makeCtx();
    const other = nodePort(ctx);
    const page = fakePort();
    await observe(ctx, other, { call: roomListener('attach', 'l-1'), nodeClient: 'another-entry' });
    await observe(ctx, page, { call: roomListener('attach', 'l-1'), nodeClient: ENTRY });
    observedPortInterrupted(ctx, other);
    observedPortInterrupted(ctx, page);
    await observe(ctx, nodePort(ctx), { call: roomListener('attach', 'l-1'), nodeClient: ENTRY });
    expect(activeListeners(ctx.sandbox.history())).toHaveLength(3);
  });

  it('refuses a node client label that is not a short string, and writes nothing', async () => {
    const ctx = makeCtx();
    for (const nodeClient of [7, '', 'x'.repeat(65)]) {
      const reply = await observe(ctx, nodePort(ctx), { call: roomListener('attach', 'l-1'), nodeClient });
      expect(reply).toMatchObject({ t: 'res', ok: false, error: { code: 'invalid-argument' } });
    }
    expect(ctx.sandbox.history()).toEqual([]);
  });
});
