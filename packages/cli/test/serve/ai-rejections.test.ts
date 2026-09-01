/**
 * AI broker rejection relay — headless dev visibility for `request_rejected`.
 *
 * The broker lands a `service_mutation` event (`service: 'ai'`,
 * `op: 'request_rejected'`) on the sandbox's unified stream whenever it
 * refuses a request. That stream is browser-side (worker host / in-page
 * runtime); it never reaches the dev server, so an agent driving `pyric dev`
 * headlessly saw NOTHING when the broker rejected. The relay rides the
 * denial relay's existing channel (`POST /__pyric/denials`) so the dev
 * server prints a compact block through the same `ServeLogger`.
 *
 * These tests drive the REAL worker host (an `ai.generateContent` op with a
 * role production rejects) through a REAL dev server, and assert on what the
 * terminal logger received.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { createPyricNamespace, formatAiRejectionBlock } from '../../src/serve/namespace.js';
import { setupAiRejectionRelay } from '../../src/serve/ai-rejection-relay.js';
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
afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
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

describe('AI broker request_rejected → dev terminal', () => {
  it('prints a block via logger.note when the broker rejects a bad request shape', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiRejectionRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    await handleMessage(ctx, fakePort(), badRoleOp('models/gemini-flash-lite-latest'));
    await relay.settled();

    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('ai request rejected');
    expect(notes[0]).toContain('valid role');
    expect(notes[0]).toContain('models/gemini-flash-lite-latest');
  });

  it('throttles an agent retry loop — identical rejections print once', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(logger);
    const relay = originFetch(h.url);
    const ctx = makeCtx();
    setupAiRejectionRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

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
    setupAiRejectionRelay({ subscribe: (l) => ctx.sandbox.onEvent(l) }, relay.fetch);

    const port = fakePort();
    await handleMessage(ctx, port, badRoleOp('models/gemini-flash-lite-latest'));
    await handleMessage(ctx, port, badRoleOp('models/gemini-2.5-pro'));
    await relay.settled();

    // Two concurrent fire-and-forget POSTs — assert on the set, not the order.
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
    setupAiRejectionRelay({ subscribe: (l) => { emit = l as (e: unknown) => void; } }, spyFetch);

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

  it('never lets a relay failure escape (fire-and-forget diagnostics)', () => {
    const throwingFetch = (() => { throw new Error('no network'); }) as unknown as typeof fetch;
    let emit: (event: unknown) => void = () => {};
    setupAiRejectionRelay({ subscribe: (l) => { emit = l as (e: unknown) => void; } }, throwingFetch);
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
});
