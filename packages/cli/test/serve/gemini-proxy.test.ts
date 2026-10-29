/**
 * `/__pyric/ai-proxy/gemini` (#1584): a browser gemini engine sends here
 * with no credentials, and the dev server sends on to Gemini with the key
 * from its own environment, to its own configured base URL. Exercised over
 * the real serve server with a Bun.serve stand-in for the Gemini API.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { createGeminiProxy, geminiProxyConfig, GEMINI_PROXY_PATH } from '../../src/serve/gemini-proxy.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';

const KEY_VARS = ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'VITE_GEMINI_API_KEY'] as const;
const KEY = 'server-only-key';
const CALL = `${GEMINI_PROXY_PATH}/v1beta/models/gemini-2.5-flash:generateContent`;
const ANSWER = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] };

interface Seen { url: string; body: string; headers: Record<string, string> }

const cleanups: Array<() => unknown> = [];
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const name of KEY_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const name of KEY_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function standIn(respond: (url: URL) => Response = () => Response.json(ANSWER)): { url: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      seen.push({ url: request.url, body: await request.text(), headers: Object.fromEntries(request.headers) });
      return respond(new URL(request.url));
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

async function startServe(baseUrl: string): Promise<ServeHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-gemini-proxy-'));
  const site = join(dir, 'public');
  const sdk = join(dir, 'sdk');
  for (const d of [site, sdk]) mkdirSync(d);
  writeFileSync(join(site, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  const ns = createPyricNamespace({
    sdkDir: sdk,
    initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    aiGemini: { baseUrl },
  });
  const h = await startStaticServer({
    publicDir: site, port: 0, host: '127.0.0.1', portScanLimit: 200, logger: silentServeLogger(), namespaceHandler: ns,
  });
  cleanups.push(() => h.stop());
  return h;
}

/** The handler alone on a plain node server, with the ADC lookup replaced. */
async function startHandler(baseUrl: string, printAdcToken: () => Promise<string>): Promise<string> {
  const handler = createGeminiProxy({ baseUrl }, { shouldPrint: () => false }, undefined, { printAdcToken });
  const server: Server = createServer((req, res) => {
    void handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"contents":[]}' });

describe('/__pyric/ai-proxy/gemini', () => {
  it('sends the call to the configured base URL with the key from the server environment', async () => {
    process.env.GEMINI_API_KEY = KEY;
    const upstream = standIn();
    const h = await startServe(upstream.url);
    const response = await post(`${h.url}${CALL}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ANSWER);
    expect(upstream.seen.map((s) => s.url)).toEqual([`${upstream.url}/v1beta/models/gemini-2.5-flash:generateContent?key=${KEY}`]);
    expect(upstream.seen[0]!.body).toBe('{"contents":[]}');
  });

  it('streams server-sent events through', async () => {
    process.env.GEMINI_API_KEY = KEY;
    const upstream = standIn(() => new Response('data: {"candidates":[]}\r\n\r\n', { headers: { 'content-type': 'text/event-stream' } }));
    const h = await startServe(upstream.url);
    const response = await post(`${h.url}${GEMINI_PROXY_PATH}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe('data: {"candidates":[]}\r\n\r\n');
    expect(new URL(upstream.seen[0]!.url).pathname).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent');
  });

  it('relays an upstream error unchanged', async () => {
    process.env.GEMINI_API_KEY = KEY;
    const quota = { error: { code: 429, message: 'Resource exhausted.', status: 'RESOURCE_EXHAUSTED' } };
    const upstream = standIn(() => Response.json(quota, { status: 429 }));
    const h = await startServe(upstream.url);
    const response = await post(`${h.url}${CALL}`);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(quota);
  });

  it('sends only the three Gemini calls, so no page can spend the key on anything else', async () => {
    process.env.GEMINI_API_KEY = KEY;
    const upstream = standIn();
    const h = await startServe(upstream.url);
    const refused = [
      `${GEMINI_PROXY_PATH}/v1beta/models/gemini-2.5-flash:embedContent`,
      `${GEMINI_PROXY_PATH}/v1beta/files`,
      `${GEMINI_PROXY_PATH}/v1beta/models/../files:generateContent`,
      `${CALL}?key=other`,
    ];
    for (const path of refused) {
      const response = await post(`${h.url}${path}`);
      expect(response.status).toBe(404);
      expect((await response.json()).error.status).toBe('NOT_FOUND');
    }
    expect((await fetch(`${h.url}${CALL}`)).status).toBe(405);
    expect(upstream.seen).toEqual([]);
  });

  it('refuses a page from another origin', async () => {
    process.env.GEMINI_API_KEY = KEY;
    const upstream = standIn();
    const h = await startServe(upstream.url);
    const response = await post(`${h.url}${CALL}`, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(upstream.seen).toEqual([]);
  });

  it('answers the engine\'s own 401 when the server has no key and no ADC', async () => {
    const upstream = standIn();
    const url = await startHandler(upstream.url, async () => '');
    const response = await post(`${url}${CALL}`);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.status).toBe('UNAUTHENTICATED');
    expect(body.error.message).toContain('GEMINI_API_KEY');
    expect(upstream.seen).toEqual([]);
  });

  it('uses an ADC token as a bearer when the server has no key', async () => {
    const upstream = standIn();
    const url = await startHandler(upstream.url, async () => 'adc-token');
    await post(`${url}${CALL}`);
    expect(upstream.seen[0]!.headers.authorization).toBe('Bearer adc-token');
    expect(new URL(upstream.seen[0]!.url).search).toBe('');
  });
});

describe('geminiProxyConfig', () => {
  it('takes the base URL and key of a gemini engine, and nothing from another engine', () => {
    expect(geminiProxyConfig({ kind: 'gemini', baseUrl: 'http://x' })).toEqual({ baseUrl: 'http://x' });
    expect(geminiProxyConfig({ kind: 'gemini' })).toEqual({});
    expect(geminiProxyConfig({ kind: 'openai', baseUrl: '/__pyric/ai-proxy' })).toBeUndefined();
    expect(geminiProxyConfig(undefined)).toBeUndefined();
  });
});
