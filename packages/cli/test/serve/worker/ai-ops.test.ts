/**
 * Tests for the SharedWorker host's AI ops (host-ai.ts) — pyric/ai under
 * `pyric dev` (cdd-deltas #98.3).
 *
 * Strategy mirrors host.test.ts: a REAL pyric sandbox, fake MessagePorts,
 * `handleMessage()` called directly. The broker runs the scripted engine
 * (zero-I/O, deterministic) — no network anywhere.
 *
 * Coverage:
 *   - ai.generateContent round trip (zero-config default + scripted script)
 *   - engine config precedence: host config (ctx.aiEngine) wins over op field
 *   - ai.countTokens round trip (deterministic envelope)
 *   - broker validation + scripted error entries → res error with the wire
 *     envelope riding whole (`aiEnvelope`, code `ai/<STATUS>`)
 *   - ai.streamGenerateContent: `{ chunk }` snaps in order, terminal
 *     `{ done: true }`, sub auto-removed from ctx.subs
 *   - stream error → terminal `{ __error }` snap carrying the envelope
 *   - broker ops land `service: 'ai'` events on the sandbox's unified stream
 */

import { describe, it, expect } from 'bun:test';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  SnapMessage,
} from '../../../src/serve/worker/protocol.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

// ─── Helpers ──────────────────────────────────────────────────────────────

function fakePort(): PortLike & { messages: OutboundMessage[]; snaps: SnapMessage[] } {
  const messages: OutboundMessage[] = [];
  const snaps: SnapMessage[] = [];
  return {
    messages,
    snaps,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
      if (msg.t === 'snap') snaps.push(msg);
    },
  };
}

type FakePort = ReturnType<typeof fakePort>;

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return { db: getFirestore(sandbox), sandbox, instanceId: 'test-ai', subs: new Map() };
}

async function sendOp(ctx: HostCtx, port: FakePort, msg: InboundMessage): Promise<ResMessage> {
  await handleMessage(ctx, port, msg);
  const id = (msg as { id: string }).id;
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
  if (!res) throw new Error(`No res message for ${id}`);
  return res;
}

/** Poll until `predicate` holds (the stream pump is detached). */
async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const MODEL = 'models/gemini-flash-lite-latest';

function genRequest(text: string): Record<string, unknown> {
  return { contents: [{ role: 'user', parts: [{ text }] }] };
}

function candidateText(value: unknown): string {
  const envelope = value as {
    candidates?: Array<{ content: { parts: Array<{ text?: string }> } }>;
  };
  return (envelope.candidates ?? [])
    .flatMap((c) => c.content.parts)
    .map((p) => p.text ?? '')
    .join('');
}

// ─── ai.generateContent ───────────────────────────────────────────────────

describe('ai.generateContent', () => {
  it('zero-config default answers a deterministic wire-true envelope', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'ai-1', method: 'ai.generateContent',
      model: MODEL, request: genRequest('hello worker'),
    });
    expect(res.ok).toBe(true);
    const value = (res as ResMessage & { ok: true }).value as Record<string, unknown>;
    expect(candidateText(value)).toContain('pyric scripted response');
    expect(candidateText(value)).toContain('hello worker');
    // Wire-true envelope facts ride through the port untouched.
    expect(value.responseId).toBeDefined();
    expect((value.usageMetadata as { totalTokenCount: number }).totalTokenCount).toBeGreaterThan(0);
  });

  it('op-field engine config creates the broker (first op wins)', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'ai-2', method: 'ai.generateContent',
      model: MODEL, request: genRequest('anything'),
      engine: { kind: 'scripted', script: [{ respond: { text: 'scripted hi' } }] },
    });
    expect(res.ok).toBe(true);
    expect(candidateText((res as ResMessage & { ok: true }).value)).toBe('scripted hi');

    // A LATER op's engine field is ignored — the broker already exists.
    const res2 = await sendOp(ctx, port, {
      t: 'op', id: 'ai-3', method: 'ai.generateContent',
      model: MODEL, request: genRequest('again'),
      engine: { kind: 'scripted', script: [{ respond: { text: 'should not apply' } }] },
    });
    expect(res2.ok).toBe(true);
    // Script exhausted on the FIRST broker → zero-config default, not the
    // second op's script.
    expect(candidateText((res2 as ResMessage & { ok: true }).value)).toContain('pyric scripted response');
  });

  it('host config (ctx.aiEngine) wins over the op engine field', async () => {
    const ctx = makeCtx();
    ctx.aiEngine = { kind: 'scripted', script: [{ respond: { text: 'host wins' } }] };
    const port = fakePort();
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'ai-4', method: 'ai.generateContent',
      model: MODEL, request: genRequest('x'),
      engine: { kind: 'scripted', script: [{ respond: { text: 'op loses' } }] },
    });
    expect(res.ok).toBe(true);
    expect(candidateText((res as ResMessage & { ok: true }).value)).toBe('host wins');
  });

  it('broker validation rejects with the captured wire envelope (aiEnvelope rides whole)', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'ai-5', method: 'ai.generateContent',
      model: MODEL, request: { contents: [] },
    });
    expect(res.ok).toBe(false);
    const error = (res as ResMessage & { ok: false }).error;
    expect(error.code.startsWith('ai/')).toBe(true);
    expect(error.aiEnvelope).toBeDefined();
    expect(typeof error.aiEnvelope!.error.code).toBe('number');
    expect(typeof error.aiEnvelope!.error.status).toBe('string');
    expect(error.code).toBe(`ai/${error.aiEnvelope!.error.status}`);
  });

  it('a scripted error entry answers as a wire error envelope', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'ai-6', method: 'ai.generateContent',
      model: MODEL, request: genRequest('quota please'),
      engine: {
        kind: 'scripted',
        script: [{ respond: { error: { code: 429, message: 'quota exhausted', status: 'RESOURCE_EXHAUSTED' } } }],
      },
    });
    expect(res.ok).toBe(false);
    const error = (res as ResMessage & { ok: false }).error;
    expect(error.code).toBe('ai/RESOURCE_EXHAUSTED');
    expect(error.message).toBe('quota exhausted');
    expect(error.aiEnvelope).toEqual({
      error: { code: 429, message: 'quota exhausted', status: 'RESOURCE_EXHAUSTED' },
    });
  });
});

// ─── ai.countTokens ───────────────────────────────────────────────────────

describe('ai.countTokens', () => {
  it('answers the deterministic countTokens envelope', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'ct-1', method: 'ai.countTokens',
      model: MODEL, request: genRequest('count these tokens'),
    });
    expect(res.ok).toBe(true);
    const value = (res as ResMessage & { ok: true }).value as {
      totalTokens: number;
      promptTokensDetails: Array<{ modality: string; tokenCount: number }>;
    };
    expect(value.totalTokens).toBeGreaterThan(0);
    expect(Array.isArray(value.promptTokensDetails)).toBe(true);

    // Deterministic: the same request counts the same.
    const res2 = await sendOp(ctx, port, {
      t: 'op', id: 'ct-2', method: 'ai.countTokens',
      model: MODEL, request: genRequest('count these tokens'),
    });
    expect(((res2 as ResMessage & { ok: true }).value as { totalTokens: number }).totalTokens)
      .toBe(value.totalTokens);
  });
});

// ─── ai.streamGenerateContent (subscription) ─────────────────────────────

describe('ai.streamGenerateContent', () => {
  it('delivers { chunk } snaps in order, then a terminal { done: true }, and auto-unsubs', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    await handleMessage(ctx, port, {
      t: 'sub', subId: 's-1',
      target: { service: 'ai', op: 'streamGenerateContent' },
      model: MODEL, request: genRequest('stream me'),
      engine: { kind: 'scripted', script: [{ respond: { chunks: ['alpha', 'beta', 'gamma'] } }] },
    });

    await waitFor(() =>
      port.snaps.some((s) => (s.value as { done?: boolean }).done === true),
    );

    const values = port.snaps.filter((s) => s.subId === 's-1').map((s) => s.value as Record<string, unknown>);
    const done = values.at(-1)!;
    expect(done).toEqual({ done: true });

    const chunks = values.slice(0, -1);
    expect(chunks.length).toBe(3);
    const texts = chunks.map((v) => candidateText(v.chunk));
    expect(texts).toEqual(['alpha', 'beta', 'gamma']);
    // finishReason only on the LAST chunk (the captured framing semantics).
    const finishReasons = chunks.map(
      (v) => ((v.chunk as { candidates?: Array<{ finishReason?: string }> }).candidates ?? [])[0]?.finishReason,
    );
    expect(finishReasons[0]).toBeUndefined();
    expect(finishReasons[1]).toBeUndefined();
    expect(finishReasons[2]).toBeDefined();

    // Finite sub: auto-removed after the terminal done.
    expect(ctx.subs.get(port)?.has('s-1') ?? false).toBe(false);
  });

  it('a stream error lands as the terminal { __error } snap with the envelope', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    await handleMessage(ctx, port, {
      t: 'sub', subId: 's-2',
      target: { service: 'ai', op: 'streamGenerateContent' },
      model: MODEL, request: genRequest('fail me'),
      engine: {
        kind: 'scripted',
        script: [{ respond: { error: { code: 400, message: 'bad stream', status: 'INVALID_ARGUMENT' } } }],
      },
    });

    await waitFor(() =>
      port.snaps.some((s) => (s.value as { __error?: unknown }).__error !== undefined),
    );
    const errSnap = port.snaps.find((s) => (s.value as { __error?: unknown }).__error) !;
    const err = (errSnap.value as { __error: { code: string; message: string; aiEnvelope?: unknown } }).__error;
    expect(err.code).toBe('ai/INVALID_ARGUMENT');
    expect(err.message).toBe('bad stream');
    expect(err.aiEnvelope).toEqual({
      error: { code: 400, message: 'bad stream', status: 'INVALID_ARGUMENT' },
    });
    expect(ctx.subs.get(port)?.has('s-2') ?? false).toBe(false);
    const failure = ctx.sandbox.history().find(event => event.kind === 'operation' && event.service === 'ai');
    expect(failure).toMatchObject({ observation: { status: 'failed', error: { code: 'ai/INVALID_ARGUMENT' } }, rulesDisposition: { kind: 'not-evaluated' } });
  });

  it('an unsub mid-stream cancels delivery (no done snap after cancel)', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    // No script → zero-config default stream. Cancel IMMEDIATELY after
    // registering, before the detached pump gets a microtask.
    await handleMessage(ctx, port, {
      t: 'sub', subId: 's-3',
      target: { service: 'ai', op: 'streamGenerateContent' },
      model: MODEL, request: genRequest('cancel me'),
    });
    expect(ctx.subs.get(port)?.has('s-3')).toBe(true);
    await handleMessage(ctx, port, { t: 'unsub', subId: 's-3' });
    expect(ctx.subs.get(port)?.has('s-3') ?? false).toBe(false);

    // Give the pump time to (not) deliver.
    await new Promise((r) => setTimeout(r, 50));
    expect(port.snaps.filter((s) => s.subId === 's-3')).toEqual([]);
    const cancelled = ctx.sandbox.history().filter(event => event.kind === 'operation' && event.service === 'ai');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ observation: { status: 'cancelled' } });
  });
});

// ─── REAL client ↔ host round trip (the entries/ai.ts port-engine path) ───

describe('client round trip (worker client fns over a fake port pair)', () => {
  /** Bidirectional fake MessagePort pair (integration.test.ts pattern). */
  function portPair() {
    interface FakeMsgPort {
      postMessage(msg: unknown): void;
      onmessage: ((ev: { data: unknown }) => void) | null;
      start(): void;
    }
    const a: FakeMsgPort = { onmessage: null, postMessage() {}, start() {} };
    const b: FakeMsgPort = { onmessage: null, postMessage() {}, start() {} };
    a.postMessage = (msg) => setTimeout(() => b.onmessage?.({ data: msg }), 0);
    b.postMessage = (msg) => setTimeout(() => a.onmessage?.({ data: msg }), 0);
    return { a, b };
  }

  async function wire(engine?: HostCtx['aiEngine']) {
    const ctx = makeCtx();
    if (engine) ctx.aiEngine = engine;
    const { a: clientPort, b: hostPort } = portPair();
    const hostPortLike: PortLike = { postMessage: (m) => hostPort.postMessage(m) };
    hostPort.onmessage = (ev) => {
      void handleMessage(ctx, hostPortLike, ev.data as InboundMessage);
    };
    const client = await import('../../../src/serve/worker/client.js');
    const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port = clientPort;
      constructor(_url: unknown, _opts: unknown) {}
    };
    try {
      return { ctx, client, db: client.getFirestore('worker://ai-test') };
    } finally {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
    }
  }

  it('aiGenerateContent + aiCountTokens resolve with the wire envelopes', async () => {
    const { client, db } = await wire({
      kind: 'scripted',
      script: [{ respond: { text: 'round trip' } }],
    });
    const envelope = await client.aiGenerateContent(db, { model: MODEL, request: genRequest('rt') });
    expect(candidateText(envelope)).toBe('round trip');
    const counted = await client.aiCountTokens(db, { model: MODEL, request: genRequest('rt') });
    expect((counted as { totalTokens: number }).totalTokens).toBeGreaterThan(0);
  });

  it('aiStreamGenerateContent iterates chunks in order and completes', async () => {
    const { ctx, client, db } = await wire({
      kind: 'scripted',
      script: [{ respond: { chunks: ['one', 'two'] } }],
    });
    const texts: string[] = [];
    for await (const chunk of client.aiStreamGenerateContent(db, { model: MODEL, request: genRequest('s') })) {
      texts.push(candidateText(chunk));
    }
    expect(texts).toEqual(['one', 'two']);
    // The finite sub left nothing registered host-side.
    await waitFor(() => [...ctx.subs.values()].every((m) => m.size === 0));
  });

  it('a broker error rejects with .code ai/<STATUS> and the envelope attached', async () => {
    const { client, db } = await wire({
      kind: 'scripted',
      script: [{ respond: { error: { code: 404, message: 'no such model', status: 'NOT_FOUND' } } }],
    });
    let caught: (Error & { code?: string; aiEnvelope?: unknown }) | undefined;
    try {
      await client.aiGenerateContent(db, { model: MODEL, request: genRequest('e') });
    } catch (e) {
      caught = e as Error & { code?: string; aiEnvelope?: unknown };
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe('ai/NOT_FOUND');
    expect(caught!.aiEnvelope).toEqual({
      error: { code: 404, message: 'no such model', status: 'NOT_FOUND' },
    });
  });

  // App Check in sandbox AI mode (rows ai#sandbox-app-check-*): the claim an
  // app-backed handle attaches crosses the port, and the worker broker plays
  // AI Logic's gate with production's 403 envelope.
  const APP_CHECK_REFUSAL = {
    error: {
      code: 403,
      message: 'Firebase AI Logic has been deactivated in this project. To resume using Firebase AI Logic, you must enforce Firebase App Check. Learn more: https://firebase.google.com/docs/ai-logic/app-check',
      status: 'PERMISSION_DENIED',
    },
  };

  async function sandboxToken(): Promise<string> {
    const { mintAppCheckToken } = await import('pyric/sandbox/internal');
    return (await mintAppCheckToken({ appId: '1:123456789012:web:abc', projectId: 'demo' }, 3600)).token;
  }

  async function refusalOf(run: () => Promise<unknown>): Promise<Error & { code?: string; aiEnvelope?: unknown }> {
    try {
      await run();
    } catch (e) {
      return e as Error & { code?: string; aiEnvelope?: unknown };
    }
    throw new Error('expected the worker broker to refuse');
  }

  it('a sandbox App Check token crosses the port and the worker broker answers', async () => {
    const { client, db } = await wire();
    const appCheck = { token: await sandboxToken() };
    const envelope = await client.aiGenerateContent(db, { model: MODEL, request: genRequest('token'), appCheck });
    expect((envelope as { candidates?: unknown[] }).candidates?.length).toBeGreaterThan(0);
    const counted = await client.aiCountTokens(db, { model: MODEL, request: genRequest('token'), appCheck });
    expect((counted as { totalTokens: number }).totalTokens).toBeGreaterThan(0);
  });

  it('the worker broker refuses a request whose claim has a null token, with production\'s envelope', async () => {
    const { client, db } = await wire();
    const appCheck = { token: null };
    const unary = await refusalOf(() => client.aiGenerateContent(db, { model: MODEL, request: genRequest('no token'), appCheck }));
    expect(unary.code).toBe('ai/PERMISSION_DENIED');
    expect(unary.aiEnvelope).toEqual(APP_CHECK_REFUSAL);
    const counted = await refusalOf(() => client.aiCountTokens(db, { model: MODEL, request: genRequest('no token'), appCheck }));
    expect(counted.aiEnvelope).toEqual(APP_CHECK_REFUSAL);
    const streamed = await refusalOf(async () => {
      for await (const _chunk of client.aiStreamGenerateContent(db, { model: MODEL, request: genRequest('no token'), appCheck })) { /* none */ }
    });
    expect(streamed.aiEnvelope).toEqual(APP_CHECK_REFUSAL);
  });

  it('the worker broker refuses a tampered token', async () => {
    const { client, db } = await wire();
    const valid = await sandboxToken();
    const tampered = `${valid.slice(0, -1)}${valid.at(-1) === 'A' ? 'B' : 'A'}`;
    const refused = await refusalOf(() => client.aiGenerateContent(db, { model: MODEL, request: genRequest('tampered'), appCheck: { token: tampered } }));
    expect(refused.aiEnvelope).toEqual(APP_CHECK_REFUSAL);
  });
});

describe('ai op App Check claim validation', () => {
  it('rejects a claim whose token is neither a string nor null', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'claim-shape', method: 'ai.generateContent',
      model: MODEL, request: genRequest('bad claim'), appCheck: { token: 5 },
    } as unknown as InboundMessage);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid-argument');
  });

  it('an op with no claim (a handle with no app) is not gated', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const res = await sendOp(ctx, port, {
      t: 'op', id: 'no-claim', method: 'ai.generateContent',
      model: MODEL, request: genRequest('host tooling'),
    });
    expect(res.ok).toBe(true);
  });
});

// ─── Unified event stream ─────────────────────────────────────────────────

describe('ai events', () => {
  it('broker ops land service:ai events on the sandbox unified stream', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const events: Array<Record<string, unknown>> = [];
    ctx.sandbox.onEvent?.((e: unknown) => events.push(e as Record<string, unknown>));

    await sendOp(ctx, port, {
      t: 'op', id: 'ev-1', method: 'ai.generateContent',
      model: MODEL, request: genRequest('emit an event'),
    });

    const aiEvents = events.filter((e) => (e as { service?: string }).service === 'ai');
    expect(aiEvents.length).toBeGreaterThan(0);
  });
});

describe('AI observation identity on worker errors', () => {
  it('carries the actual host routing on unary and pre-first-chunk failures', async () => {
    const { AiBroker } = await import('../../../../pyric/src/ai/broker/broker.js');
    const ctx = makeCtx();
    // Real broker, injected network failure; host config is authoritative.
    ctx.aiBroker = new AiBroker({ engine: { kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', fetch: async () => { throw new Error('offline'); } } }) as unknown as HostCtx['aiBroker'];
    const port = fakePort();
    const response = await sendOp(ctx, port, { t: 'op', id: 'identity-fail', method: 'ai.generateContent', model: MODEL, request: genRequest('test') });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.aiEvidence).toMatchObject({ requestedModel: MODEL, routedModel: 'qwen3:8b', engine: 'openai', endpoint: 'http://localhost:11434' });
    await handleMessage(ctx, port, { t: 'sub', subId: 'identity-stream', target: { service: 'ai', op: 'streamGenerateContent' }, model: MODEL, request: genRequest('test') });
    await waitFor(() => port.snaps.length > 0);
    expect(port.snaps[0]!.value).toMatchObject({ __error: { aiEvidence: { routedModel: 'qwen3:8b', engine: 'openai' } } });
  });
});

it('retains one inspectable worker AI request for a late traffic observer', async () => {
  const ctx = makeCtx();
  const producer = fakePort();
  await handleMessage(ctx, producer, {
    t: 'sub', subId: 'background-generation', target: { service: 'ai', op: 'streamGenerateContent' },
    model: MODEL, request: genRequest('synthetic observation'),
    engine: { kind: 'scripted', script: [{ respond: { text: 'Synthetic worker answer' } }] },
  });
  await waitFor(() => producer.snaps.some(s => (s.value as { done?: boolean }).done));
  const { createTrafficFeed } = await import('../../../src/serve/runtime/chip-traffic.js');
  const feed = createTrafficFeed({ subscribeEvents: callback => {
    callback(ctx.sandbox.history());
    return ctx.sandbox.onEvent(event => callback([event]));
  } });
  const requests = feed.requests().filter(request => request.service === 'ai');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.aiRequest?.status).toBe('completed');
  expect(requests[0]?.aiRequest?.response?.text).toBe('Synthetic worker answer');
  expect(requests[0]?.aiRequest?.detail.requestedModel).toBe(MODEL);
  feed.dispose();
});

it('keeps the request identity across live updates and replay, beyond 64 operations', async () => {
  const ctx = makeCtx();
  const { createTrafficFeed } = await import('../../../src/serve/runtime/chip-traffic.js');
  let deliver: (events: readonly import('pyric/sandbox').SandboxEvent[]) => void = () => {};
  const feed = createTrafficFeed({ subscribeEvents: callback => {
    deliver = callback;
    return ctx.sandbox.onEvent(event => callback([event]));
  } });
  await sendOp(ctx, fakePort(), { t: 'op', id: 'inspectable', method: 'ai.generateContent',
    model: MODEL, request: genRequest('synthetic') });
  for (let index = 0; index < 70; index++) {
    await sendOp(ctx, fakePort(), { t: 'op', id: `noise-${index}`, method: 'ai.countTokens', model: MODEL, request: genRequest('noise') });
  }
  deliver(ctx.sandbox.history());
  expect(feed.requests()).toHaveLength(71);
  expect(feed.requests().filter(request => request.method === 'generateContent')).toHaveLength(1);
  feed.dispose();
});

it('records the issuing port identity rather than a later observer session', async () => {
  const ctx = makeCtx();
  const producer = fakePort();
  await sendOp(ctx, producer, { t: 'op', id: 'sign-in', method: 'auth.signInAnonymously' });
  const originalUid = ctx.portSessions?.get(producer)?.user.uid;
  expect(originalUid).toBeDefined();
  await handleMessage(ctx, producer, { t: 'sub', subId: 'identity-stream',
    target: { service: 'ai', op: 'streamGenerateContent' }, model: MODEL, request: genRequest('synthetic') });
  await sendOp(ctx, producer, { t: 'op', id: 'sign-out', method: 'auth.signOut' });
  await waitFor(() => producer.snaps.some(s => (s.value as { done?: boolean }).done));
  const requests = ctx.sandbox.history().filter(event => event.kind === 'operation' && event.service === 'ai');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ auth: { uid: originalUid }, observation: { status: 'completed' },
    operationContext: { source: { kind: 'app' } } });
});
