/**
 * AI broker diagnostics relay: headless dev visibility for the events that
 * carry a refusal or a silent swap.
 *
 * The broker lands a `service_mutation` event (`service: 'ai'`,
 * `op: 'request_rejected'`) on the sandbox's unified stream whenever it
 * refuses a request. That stream is browser-side (worker host / in-page
 * runtime); it never reaches the dev server, so an agent driving `pyric dev`
 * headlessly saw NOTHING when the broker rejected. The relay rides the
 * denial relay's existing channel (`POST /__pyric/denials`) so the dev
 * server prints a compact block through the same `ServeLogger`.
 *
 * The same relay carries the broker's OTHER silent refusal, `response_blocked`
 * (a safety or recitation filter block, which unlike a rejection throws
 * nothing at all, since production answers 200 with an empty candidate), and
 * `model_substituted`, which is not a refusal at all: the answer arrives, from
 * a model the developer never named.
 *
 * These tests drive the REAL worker host (an `ai.generateContent` op with a
 * role production rejects, one scripted to answer a blocked envelope, or one
 * whose engine redirects the model onto a stub OpenAI-compatible upstream)
 * through a REAL dev server, and assert on what the terminal logger received.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import {
  formatAiBlockedBlock,
  formatAiModelSubstitutionBlock,
  formatAiRejectionBlock,
} from '../../src/serve/ai-terminal-blocks.js';
import { setupAiDiagnosticsRelay } from '../../src/serve/ai-diagnostics-relay.js';
import { AI_TERMINAL_TEXT_MAX } from '../../src/serve/ai-terminal-text.js';
import { handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import type { OutboundMessage } from '../../src/serve/worker/protocol.js';
import { startStaticServer, type ServeHandle, type ServeLogger } from '../../src/serve/server.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-ai-rejections-'));
  const site = join(dir, 'public');
  const sdk = join(dir, 'sdk');
  for (const d of [site, sdk]) mkdirSync(d);
  writeFileSync(join(site, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  return { site, sdk };
}

function recordingLogger(): { logger: ServeLogger; notes: string[] } {
  const notes: string[] = [];
  return { logger: { info: () => {}, note: (m) => notes.push(m) }, notes };
}

const handles: ServeHandle[] = [];
/** Stub upstreams started by the model-substitution tests below. */
const upstreams: Array<{ stop(): void }> = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
  while (upstreams.length) upstreams.pop()!.stop();
});

async function startServe(logger: ServeLogger): Promise<ServeHandle> {
  const { site, sdk } = fixture();
  const ns = createPyricNamespace({
    sdkDir: sdk,
    initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    logger,
  });
  const h = await startStaticServer({
    publicDir: site,
    port: 0,
    host: '127.0.0.1',
    portScanLimit: 200,
    logger,
    namespaceHandler: ns,
  });
  handles.push(h);
  return h;
}

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return { db: getFirestore(sandbox), sandbox, subs: new Map() };
}

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage: (message) => void messages.push(message) };
}

/** The served page posts to the relative `/__pyric/denials`; in-process tests
 *  resolve it against the test server's origin. Returns the in-flight relay
 *  POSTs so a test can await delivery instead of racing it. */
function originFetch(origin: string): { fetch: typeof fetch; settled: () => Promise<void> } {
  const inFlight: Promise<unknown>[] = [];
  const fn = ((input: string, init?: RequestInit) => {
    const p = fetch(`${origin}${String(input)}`, init);
    inFlight.push(p.catch(() => {}));
    return p;
  }) as typeof fetch;
  return { fetch: fn, settled: async () => { await Promise.all(inFlight); } };
}

const badRoleOp = (model: string) => ({
  t: 'op' as const,
  id: `ai-${Math.random()}`,
  method: 'ai.generateContent' as const,
  model,
  request: { contents: [{ role: 'wizard', parts: [{ text: 'hi' }] }] },
});

/** A scripted op whose engine replays the envelope production returns when
 *  a safety / recitation filter fires: HTTP 200, an EMPTY candidate, and the
 *  reason in `finishReason`. Nothing throws: the caller just gets no text. */
const blockedOp = (model: string, finishReason: string, finishMessage?: string) => ({
  t: 'op' as const,
  id: `ai-${Math.random()}`,
  method: 'ai.generateContent' as const,
  model,
  request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
  engine: {
    kind: 'scripted' as const,
    script: [
      {
        respond: {
          candidates: [
            {
              content: { role: 'model', parts: [] },
              index: 0,
              finishReason,
              ...(finishMessage !== undefined ? { finishMessage } : {}),
              safetyRatings: [],
            },
          ],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 0, totalTokenCount: 2 },
        },
      },
    ] as Array<Record<string, unknown>>,
  },
});

describe('AI broker request_rejected → dev terminal', () => {
  it('prints a block via logger.note when the broker rejects a bad request shape', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiDiagnosticsRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    await handleMessage(ctx, fakePort(), badRoleOp('models/gemini-flash-lite-latest'));
    await relay.settled();

    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('ai request rejected');
    expect(notes[0]).toContain('valid role');
    expect(notes[0]).toContain('models/gemini-flash-lite-latest');
  });

  it('throttles an agent retry loop: identical rejections print once', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiDiagnosticsRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    const port = fakePort();
    for (let i = 0; i < 5; i += 1) {
      await handleMessage(ctx, port, badRoleOp('models/gemini-flash-lite-latest'));
    }
    await relay.settled();

    expect(notes.length).toBe(1);
  });

  it('does not throttle a different model', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiDiagnosticsRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    const port = fakePort();
    await handleMessage(ctx, port, badRoleOp('models/gemini-flash-lite-latest'));
    await handleMessage(ctx, port, badRoleOp('models/gemini-2.5-pro'));
    await relay.settled();

    // Two concurrent fire-and-forget POSTs, so assert on the set, not the order.
    expect(notes.length).toBe(2);
    expect(notes.some((n) => n.includes('models/gemini-flash-lite-latest'))).toBe(true);
    expect(notes.some((n) => n.includes('models/gemini-2.5-pro'))).toBe(true);
  });

  it('ignores every non-rejection sandbox event', async () => {
    const calls: string[] = [];
    const spyFetch = ((url: string) => {
      calls.push(String(url));
      return Promise.resolve({ ok: true, status: 204 } as Response);
    }) as typeof fetch;
    let emit: (event: unknown) => void = () => {};
    setupAiDiagnosticsRelay({ subscribe: (l) => { emit = l as (e: unknown) => void; } }, spyFetch);

    emit({ kind: 'service_mutation', id: '1', at: 0, service: 'ai', op: 'generate_content', path: 'm', auth: null });
    emit({ kind: 'service_mutation', id: '2', at: 0, service: 'auth', op: 'sign_in', path: 'u', auth: null });
    emit({ kind: 'request', id: '3', at: 0, method: 'get', path: 'a/b', result: 'deny' });
    expect(calls).toEqual([]);

    emit({
      kind: 'service_mutation', id: '4', at: 0, service: 'ai', op: 'request_rejected',
      path: 'models/x', auth: null, detail: { code: 400, status: 'INVALID_ARGUMENT', message: 'nope' },
    });
    expect(calls).toEqual(['/__pyric/denials']);
  });

  it('caps a huge upstream message before it crosses the POST', () => {
    const bodies: string[] = [];
    const spyFetch = ((_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Promise.resolve({ ok: true, status: 204 } as Response);
    }) as typeof fetch;
    let emit: (event: unknown) => void = () => {};
    setupAiDiagnosticsRelay({ subscribe: (l) => { emit = l as (e: unknown) => void; } }, spyFetch);

    emit({
      kind: 'service_mutation', id: '1', at: 0, service: 'ai', op: 'request_rejected',
      path: 'models/x', auth: null,
      detail: { code: 400, status: 'INVALID_ARGUMENT', message: 'x'.repeat(20_000) },
    });

    expect(bodies.length).toBe(1);
    const relayed = JSON.parse(bodies[0]!) as { message: string };
    expect(relayed.message.length).toBeLessThanOrEqual(AI_TERMINAL_TEXT_MAX + 1);
    expect(relayed.message.endsWith('\u2026')).toBe(true);
  });

  it('never lets a relay failure escape (fire-and-forget diagnostics)', () => {
    const throwingFetch = (() => { throw new Error('no network'); }) as unknown as typeof fetch;
    let emit: (event: unknown) => void = () => {};
    setupAiDiagnosticsRelay({ subscribe: (l) => { emit = l as (e: unknown) => void; } }, throwingFetch);
    expect(() => emit({
      kind: 'service_mutation', id: '1', at: 0, service: 'ai', op: 'request_rejected',
      path: 'models/x', auth: null, detail: { code: 400, status: 'INVALID_ARGUMENT', message: 'nope' },
    })).not.toThrow();
  });
});

describe('formatAiRejectionBlock', () => {
  it('renders reason, model + engine, then status/code', () => {
    const block = formatAiRejectionBlock({
      kind: 'ai-rejection',
      model: 'models/gemini-flash-lite-latest',
      engine: 'openai',
      code: 400,
      status: 'INVALID_ARGUMENT',
      message: 'Please use a valid role: SYSTEM, USER, MODEL.',
    });
    const lines = block.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('ai request rejected: Please use a valid role');
    expect(lines[1]).toContain('models/gemini-flash-lite-latest');
    expect(lines[1]).toContain('openai');
    expect(lines[2]).toContain('INVALID_ARGUMENT (400)');
  });

  it('omits the model line when the event carried no model', () => {
    const block = formatAiRejectionBlock({ kind: 'ai-rejection', message: 'boom', status: 'INTERNAL', code: 500 });
    expect(block.split('\n').length).toBe(2);
    expect(block).not.toContain('model:');
  });

  it('redacts credential-bearing query params in the reason', () => {
    const block = formatAiRejectionBlock({
      kind: 'ai-rejection',
      model: 'models/x',
      message: 'gemini upstream 403 for https://gl.googleapis.com/v1/models/x?key=SECRET123&alt=sse',
    });
    expect(block).toContain('key=***');
    expect(block).not.toContain('SECRET123');
  });

  it('flattens a multi-line upstream reason onto one line and strips control chars', () => {
    const block = formatAiRejectionBlock({
      kind: 'ai-rejection',
      model: 'models/gemini-2.5-pro',
      code: 400,
      status: 'INVALID_ARGUMENT',
      // Production's own `ai-error-empty-contents` text is a bulleted list.
      message: 'Invalid JSON payload received.\n\n * GenerateContentRequest.contents:\n   contents is not specified\u001b[31m',
    });
    expect(block.split('\n').length).toBe(3);
    expect(block.split('\n')[0]).toContain(
      'Invalid JSON payload received. * GenerateContentRequest.contents: contents is not specified',
    );
    expect(block).not.toContain('\u001b');
  });

  it('falls back to a generic reason for a malformed payload', () => {
    const block = formatAiRejectionBlock({ kind: 'ai-rejection' } as never);
    expect(block).toContain('ai request rejected: request rejected');
  });

  it('caps every remote-authored field it prints', () => {
    const block = formatAiRejectionBlock({
      kind: 'ai-rejection',
      model: 'm'.repeat(5_000),
      engine: 'e'.repeat(5_000),
      status: 'S'.repeat(5_000),
      code: 400,
      message: 'boom '.repeat(2_000),
    });
    for (const line of block.split('\n')) {
      // Each line is one capped field plus a short label, never a payload.
      expect(line.length).toBeLessThan(AI_TERMINAL_TEXT_MAX * 2 + 64);
    }
  });
});

// ── Blocked responses (SAFETY / RECITATION) ─────────────────────────────────
//
// A filter block is NOT a rejection: production answers 200 with an empty
// candidate and the reason in `finishReason`, so nothing throws and the app
// just renders nothing. The broker emits `response_blocked`; the same relay
// carries it over the same route, formatted by `formatAiBlockedBlock`.

describe('AI blocked responses → dev terminal', () => {
  it('prints a block when a SAFETY finish reason comes back', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiDiagnosticsRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    await handleMessage(ctx, fakePort(), blockedOp('models/gemini-flash-lite-latest', 'SAFETY'));
    await relay.settled();

    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('ai response blocked: SAFETY');
    expect(notes[0]).toContain('models/gemini-flash-lite-latest');
    expect(notes[0]).toContain('scripted');
  });

  it("prints RECITATION with production's own finishMessage", async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiDiagnosticsRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    await handleMessage(
      ctx,
      fakePort(),
      blockedOp('models/gemini-2.5-pro', 'RECITATION', 'matched copyrighted text'),
    );
    await relay.settled();

    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('ai response blocked: RECITATION');
    expect(notes[0]).toContain('matched copyrighted text');
  });

  it('stays silent for an ordinary (unblocked) response', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiDiagnosticsRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    await handleMessage(ctx, fakePort(), {
      t: 'op' as const,
      id: 'ai-ok',
      method: 'ai.generateContent' as const,
      model: 'models/gemini-flash-lite-latest',
      request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    });
    await relay.settled();

    expect(notes).toEqual([]);
  });

  it('throttles a retry loop and keys apart from a rejection on the same model', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiDiagnosticsRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    const port = fakePort();
    for (let i = 0; i < 4; i += 1) {
      await handleMessage(ctx, port, blockedOp('models/gemini-flash-lite-latest', 'SAFETY'));
    }
    await handleMessage(ctx, port, badRoleOp('models/gemini-flash-lite-latest'));
    await relay.settled();

    expect(notes.length).toBe(2);
    expect(notes.some((n) => n.includes('ai response blocked'))).toBe(true);
    expect(notes.some((n) => n.includes('ai request rejected'))).toBe(true);
  });
});

describe('formatAiBlockedBlock', () => {
  it('renders the finish reason, model + engine, then the finish message', () => {
    const block = formatAiBlockedBlock({
      kind: 'ai-blocked',
      model: 'models/gemini-2.5-pro',
      engine: 'gemini',
      finishReason: 'SAFETY',
      finishMessage: 'blocked by the safety filter',
    });
    const lines = block.split('\n');
    expect(lines[0]).toContain('ai response blocked: SAFETY');
    expect(lines[1]).toContain('models/gemini-2.5-pro');
    expect(lines[1]).toContain('gemini');
    expect(lines[2]).toContain('blocked by the safety filter');
  });

  it('reports a prompt-level block through blockReason', () => {
    const block = formatAiBlockedBlock({
      kind: 'ai-blocked',
      model: 'models/x',
      engine: 'scripted',
      blockReason: 'PROHIBITED_CONTENT',
    });
    expect(block).toContain('ai response blocked: PROHIBITED_CONTENT');
    expect(block).toContain('prompt');
  });

  it('flattens and redacts an upstream-authored finish message', () => {
    const block = formatAiBlockedBlock({
      kind: 'ai-blocked',
      model: 'models/x',
      finishReason: 'RECITATION',
      finishMessage:
        'see https://gl.googleapis.com/v1/models/x?key=SECRET123\n  line two\u001b[31m',
    });
    expect(block).toContain('key=***');
    expect(block).not.toContain('SECRET123');
    expect(block).not.toContain('\u001b');
    expect(block.split('\n').length).toBe(3);
  });

  it('falls back to a generic reason for a malformed payload', () => {
    const block = formatAiBlockedBlock({ kind: 'ai-blocked' } as never);
    expect(block).toContain('ai response blocked: unknown');
  });
});

// ── Model substitutions (alias / fallback redirects) ────────────────────────
//
// The quietest of the three: nothing throws, content comes back, and the
// developer concludes they tested the model they NAMED. The broker emits
// `model_substituted`; the same relay carries it over the same route with its
// own `kind`, formatted by `formatAiModelSubstitutionBlock`.

/** A tiny OpenAI-compatible upstream, enough for the openai engine to
 *  translate one unary answer, and it records the model it was asked for. */
function stubOpenAiUpstream(): { url: string; models: string[]; stop(): void } {
  const models: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { model?: string };
      models.push(String(body.model));
      return Response.json({
        id: 'chatcmpl-1',
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, models, stop: () => server.stop(true) };
}

const substitutedOp = (model: string, upstream: string, engineModel: string) => ({
  t: 'op' as const,
  id: `ai-${Math.random()}`,
  method: 'ai.generateContent' as const,
  model,
  request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
  engine: { kind: 'openai' as const, baseUrl: upstream, model: engineModel },
});

describe('AI model substitutions → dev terminal', () => {
  it('prints the swap when the engine answers as a different model', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const upstream = stubOpenAiUpstream();
    upstreams.push(upstream);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiDiagnosticsRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    await handleMessage(
      ctx,
      fakePort(),
      substitutedOp('models/gemini-2.5-pro', upstream.url, 'llama3'),
    );
    await relay.settled();

    expect(upstream.models).toEqual(['llama3']);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('ai model substituted');
    expect(notes[0]).toContain('models/gemini-2.5-pro');
    expect(notes[0]).toContain('llama3');
    expect(notes[0]).toContain('openai');
  });

  it('stays silent when the engine answers as the model that was asked for', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const upstream = stubOpenAiUpstream();
    upstreams.push(upstream);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiDiagnosticsRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    await handleMessage(
      ctx,
      fakePort(),
      substitutedOp('models/llama3', upstream.url, 'llama3'),
    );
    await relay.settled();

    expect(upstream.models).toEqual(['llama3']);
    expect(notes).toEqual([]);
  });

  it('throttles a loop and keys apart from a rejection on the same model', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const upstream = stubOpenAiUpstream();
    upstreams.push(upstream);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiDiagnosticsRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    const port = fakePort();
    for (let i = 0; i < 4; i += 1) {
      await handleMessage(ctx, port, substitutedOp('models/gemini-2.5-pro', upstream.url, 'llama3'));
    }
    await handleMessage(ctx, port, badRoleOp('models/gemini-2.5-pro'));
    await relay.settled();

    expect(notes.length).toBe(2);
    expect(notes.some((n) => n.includes('ai model substituted'))).toBe(true);
    expect(notes.some((n) => n.includes('ai request rejected'))).toBe(true);
  });

  it('relays a model_substituted event and ignores a no-op (requested === effective)', () => {
    const calls: string[] = [];
    const spyFetch = ((url: string) => {
      calls.push(String(url));
      return Promise.resolve({ ok: true, status: 204 } as Response);
    }) as typeof fetch;
    let emit: (event: unknown) => void = () => {};
    setupAiDiagnosticsRelay({ subscribe: (l) => { emit = l as (e: unknown) => void; } }, spyFetch);

    emit({
      kind: 'service_mutation', id: '1', at: 0, service: 'ai', op: 'model_substituted',
      path: 'models/x', auth: null,
      detail: { requestedModel: 'models/x', effectiveModel: 'x', reason: 'passthrough', engine: 'openai' },
    });
    expect(calls).toEqual([]);

    emit({
      kind: 'service_mutation', id: '2', at: 0, service: 'ai', op: 'model_substituted',
      path: 'models/x', auth: null,
      detail: { requestedModel: 'models/x', effectiveModel: 'qwen3', reason: 'engine modelMap', engine: 'openai' },
    });
    expect(calls).toEqual(['/__pyric/denials']);
  });
});

describe('formatAiModelSubstitutionBlock', () => {
  it('renders requested → effective with the engine and the reason', () => {
    const line = formatAiModelSubstitutionBlock({
      kind: 'ai-model-substituted',
      requestedModel: 'models/gemini-2.5-flash',
      effectiveModel: 'gemini-flash-lite-latest',
      engine: 'gemini',
      reason: 'experimental alias',
    });
    expect(line.split('\n').length).toBe(1);
    expect(line).toBe(
      '  ⚠ [pyric] ai model substituted: models/gemini-2.5-flash → gemini-flash-lite-latest (gemini, experimental alias)',
    );
  });

  it('drops the parenthetical when neither engine nor reason came through', () => {
    const line = formatAiModelSubstitutionBlock({
      kind: 'ai-model-substituted',
      requestedModel: 'models/x',
      effectiveModel: 'y',
    });
    expect(line).toBe('  ⚠ [pyric] ai model substituted: models/x → y');
  });

  it('flattens and redacts upstream-authored model text', () => {
    const line = formatAiModelSubstitutionBlock({
      kind: 'ai-model-substituted',
      requestedModel: 'models/x?key=SECRET123',
      effectiveModel: 'y\n  two\u001b[31m',
      engine: 'openai',
      reason: 'engine modelMap',
    });
    expect(line).toContain('key=***');
    expect(line).not.toContain('SECRET123');
    expect(line).not.toContain('\u001b');
    expect(line.split('\n').length).toBe(1);
  });

  it('falls back to generic names for a malformed payload', () => {
    const line = formatAiModelSubstitutionBlock({ kind: 'ai-model-substituted' } as never);
    expect(line).toContain('ai model substituted: unknown → unknown');
  });
});
