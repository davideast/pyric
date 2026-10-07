/**
 * Application Default Credentials in the gemini engine: the access token from
 * `gcloud auth application-default print-access-token` is cached per engine
 * for a bounded lifetime, concurrent requests share one lookup, a failed
 * lookup is not cached, and an upstream 401 refreshes the token and retries
 * once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AiBrokerError, GeminiEngine, type GenerateContentRequest } from '../../src/ai/broker/index.js';

const REQUEST: GenerateContentRequest = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
const MODEL = 'gemini-3.1-flash-lite';
const KEY_VARS = ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'VITE_GEMINI_API_KEY'] as const;

const ok = () =>
  Response.json({
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  });

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const name of KEY_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of KEY_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

interface Harness {
  engine: GeminiEngine;
  lookups: () => number;
  authHeaders: string[];
  advance: (ms: number) => void;
}

function harness(opts: {
  tokens?: string[];
  respond?: (call: number) => Response;
  failFirstLookup?: boolean;
}): Harness {
  let lookups = 0;
  let clock = 1_000_000;
  let calls = 0;
  const tokens = opts.tokens ?? ['adc-token-1', 'adc-token-2', 'adc-token-3'];
  const authHeaders: string[] = [];
  const engine = new GeminiEngine({
    fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(String((init?.headers as Record<string, string>)['Authorization']));
      calls += 1;
      return opts.respond ? opts.respond(calls) : ok();
    }) as typeof fetch,
    printAdcToken: async () => {
      lookups += 1;
      if (opts.failFirstLookup && lookups === 1) throw new Error('gcloud: not logged in');
      return `${tokens[lookups - 1]}\n`;
    },
    now: () => clock,
  });
  return { engine, lookups: () => lookups, authHeaders, advance: (ms) => (clock += ms) };
}

describe('GeminiEngine: Application Default Credentials token cache', () => {
  it('three sequential calls look up the token once', async () => {
    const h = harness({});
    await h.engine.generateContent(REQUEST, MODEL);
    await h.engine.countTokens({ contents: REQUEST.contents }, MODEL);
    await h.engine.generateContent(REQUEST, MODEL);
    expect(h.lookups()).toBe(1);
    expect(h.authHeaders).toEqual([
      'Bearer adc-token-1',
      'Bearer adc-token-1',
      'Bearer adc-token-1',
    ]);
  });

  it('concurrent calls share one lookup', async () => {
    const h = harness({});
    await Promise.all([
      h.engine.generateContent(REQUEST, MODEL),
      h.engine.generateContent(REQUEST, MODEL),
      h.engine.generateContent(REQUEST, MODEL),
    ]);
    expect(h.lookups()).toBe(1);
  });

  it('looks the token up again once the cached lifetime has passed', async () => {
    const h = harness({});
    await h.engine.generateContent(REQUEST, MODEL);
    h.advance(20 * 60 * 1000);
    await h.engine.generateContent(REQUEST, MODEL);
    expect(h.lookups()).toBe(1);
    h.advance(20 * 60 * 1000);
    await h.engine.generateContent(REQUEST, MODEL);
    expect(h.lookups()).toBe(2);
    expect(h.authHeaders.at(-1)).toBe('Bearer adc-token-2');
  });

  it('does not cache a failed lookup', async () => {
    const h = harness({ failFirstLookup: true });
    const err = await h.engine.generateContent(REQUEST, MODEL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBrokerError);
    expect((err as AiBrokerError).envelope.error.code).toBe(401);
    await h.engine.generateContent(REQUEST, MODEL);
    expect(h.lookups()).toBe(2);
    expect(h.authHeaders).toEqual(['Bearer adc-token-2']);
  });

  it('refreshes the token and retries once when the upstream answers 401', async () => {
    const h = harness({
      respond: (call) => (call === 1 ? new Response('expired', { status: 401 }) : ok()),
    });
    const res = await h.engine.generateContent(REQUEST, MODEL);
    expect(res.candidates?.[0]?.finishReason).toBe('STOP');
    expect(h.lookups()).toBe(2);
    expect(h.authHeaders).toEqual(['Bearer adc-token-1', 'Bearer adc-token-2']);
  });

  it('surfaces a second 401 instead of retrying again', async () => {
    const h = harness({ respond: () => new Response('denied', { status: 401 }) });
    const err = await h.engine.generateContent(REQUEST, MODEL).catch((e: unknown) => e);
    expect((err as AiBrokerError).envelope.error.code).toBe(401);
    expect(h.authHeaders.length).toBe(2);
  });

  it('streams with the cached token and refreshes on a 401', async () => {
    const sse = () =>
      new Response(`data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'x' }] }, finishReason: 'STOP' }] })}\n\n`);
    const h = harness({
      respond: (call) => (call === 1 ? new Response('expired', { status: 401 }) : sse()),
    });
    const chunks = [];
    for await (const chunk of h.engine.streamGenerateContent(REQUEST, MODEL)) chunks.push(chunk);
    expect(chunks.length).toBe(1);
    for await (const _ of h.engine.streamGenerateContent(REQUEST, MODEL)) {
      // drain
    }
    expect(h.lookups()).toBe(2);
    expect(h.authHeaders).toEqual(['Bearer adc-token-1', 'Bearer adc-token-2', 'Bearer adc-token-2']);
  });

  it('a static key never looks up ADC and a 401 on it is not retried', async () => {
    process.env.GEMINI_API_KEY = 'static-key';
    const h = harness({ respond: () => new Response('bad key', { status: 401 }) });
    const err = await h.engine.generateContent(REQUEST, MODEL).catch((e: unknown) => e);
    expect((err as AiBrokerError).envelope.error.code).toBe(401);
    expect(h.lookups()).toBe(0);
    expect(h.authHeaders.length).toBe(1);
  });
});
