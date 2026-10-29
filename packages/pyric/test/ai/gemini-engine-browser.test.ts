/**
 * The gemini engine in a browser page or SharedWorker (#1584). A browser has
 * no `process`, so the engine must never read it there, and its key must
 * never reach the browser: a same-origin base URL is Pyric's dev server,
 * which attaches the credentials, so the engine sends none.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GeminiEngine, GeminiUpstream, hasGeminiStaticKey, type GenerateContentRequest } from '../../src/ai/broker/index.js';

const REQUEST: GenerateContentRequest = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
const KEY_VARS = ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'VITE_GEMINI_API_KEY'] as const;
const PROXY = '/__pyric/ai-proxy/gemini';

const answer = () =>
  Response.json({
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  });

interface Sent { url: string; headers: Record<string, string> }

function recordingFetch(sent: Sent[]): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return answer();
  }) as typeof fetch;
}

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const name of KEY_VARS) saved[name] = process.env[name];
});
afterEach(() => {
  for (const name of KEY_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/** Run `body` as a browser would, with no `process` global. */
async function withoutProcess<T>(body: () => Promise<T> | T): Promise<T> {
  const g = globalThis as { process?: unknown };
  const real = g.process;
  g.process = undefined;
  try {
    return await body();
  } finally {
    g.process = real;
  }
}

describe('a same-origin base URL: the dev server attaches the credentials', () => {
  it('sends no key and no Authorization header, even with a key in the environment', async () => {
    process.env.GEMINI_API_KEY = 'server-only-key';
    const sent: Sent[] = [];
    const engine = new GeminiEngine({ baseUrl: PROXY, fetch: recordingFetch(sent), printAdcToken: async () => 'adc' });
    await engine.generateContent(REQUEST, 'models/gemini-2.5-flash');
    await engine.countTokens(REQUEST, 'gemini-2.5-flash');
    expect(sent.map((s) => s.url)).toEqual([
      `${PROXY}/v1beta/models/gemini-2.5-flash:generateContent`,
      `${PROXY}/v1beta/models/gemini-2.5-flash:countTokens`,
    ]);
    for (const s of sent) expect(s.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('asks for the stream as server-sent events, with nothing appended', async () => {
    const sent: Sent[] = [];
    const engine = new GeminiEngine({ baseUrl: PROXY, fetch: recordingFetch(sent) });
    const stream = engine.streamGenerateContent(REQUEST, 'gemini-2.5-flash');
    for await (const _chunk of stream) { /* drain */ }
    expect(sent.map((s) => s.url)).toEqual([`${PROXY}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`]);
  });
});

describe('with no process global, as in a browser', () => {
  it('answers through the proxy without reading the environment', async () => {
    const sent: Sent[] = [];
    const engine = new GeminiEngine({ baseUrl: PROXY, fetch: recordingFetch(sent) });
    const response = await withoutProcess(() => engine.generateContent(REQUEST, 'gemini-2.5-flash'));
    expect(response.candidates?.[0]?.content?.parts).toEqual([{ text: 'ok' }]);
    expect(sent).toHaveLength(1);
  });

  it('reports no key configured instead of throwing', async () => {
    process.env.GEMINI_API_KEY = 'server-only-key';
    expect(await withoutProcess(() => hasGeminiStaticKey(undefined))).toBe(false);
    expect(await withoutProcess(() => new GeminiEngine({ baseUrl: PROXY }).hasKeyConfigured())).toBe(false);
    expect(await withoutProcess(() => hasGeminiStaticKey('explicit'))).toBe(true);
  });

  it('a direct engine with no key fails with its own 401, not a ReferenceError', async () => {
    const engine = new GeminiEngine({ fetch: recordingFetch([]) });
    const failure = await withoutProcess(() => engine.generateContent(REQUEST, 'gemini-2.5-flash').then(() => null, (e: unknown) => e));
    expect((failure as { envelope?: { error: { code: number; status: string } } }).envelope?.error).toMatchObject({
      code: 401,
      status: 'UNAUTHENTICATED',
    });
  });
});

describe('GeminiUpstream on the server', () => {
  it('attaches the environment key to the configured base URL and returns the raw answer', async () => {
    process.env.GEMINI_API_KEY = 'server-only-key';
    const sent: Sent[] = [];
    const upstream = new GeminiUpstream({ baseUrl: 'http://127.0.0.1:9/', fetch: recordingFetch(sent) });
    const response = await upstream.send('models/gemini-2.5-flash', 'generateContent', '{}');
    expect(response.status).toBe(200);
    expect(sent.map((s) => s.url)).toEqual(['http://127.0.0.1:9/v1beta/models/gemini-2.5-flash:generateContent?key=server-only-key']);
  });

  it('returns a non-2xx upstream answer unchanged, for the caller to read', async () => {
    process.env.GEMINI_API_KEY = 'server-only-key';
    const upstream = new GeminiUpstream({
      fetch: (async () => Response.json({ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } }, { status: 429 })) as unknown as typeof fetch,
    });
    const response = await upstream.send('models/gemini-2.5-flash', 'generateContent', '{}');
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } });
  });
});
