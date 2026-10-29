/**
 * The gemini engine in the worker host (#1584). A browser worker has no
 * server environment, so it sends through the dev server's gemini proxy with
 * no credentials, and only after the App Check gate admits the request. The
 * Node host keeps the configured target and reads its own environment.
 *
 * A real pyric sandbox and fake MessagePorts, as in ai-ops.test.ts; the
 * network is a recorded `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

const MODEL = 'models/gemini-2.5-flash';
const ANSWER = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'proxied' }] }, finishReason: 'STOP' }] };

interface Sent { url: string; headers: unknown }

let sent: Sent[] = [];
let realFetch: typeof fetch;
let savedKey: string | undefined;
beforeEach(() => {
  sent = [];
  realFetch = globalThis.fetch;
  savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'server-only-key';
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent.push({ url: String(input), headers: init?.headers });
    return Response.json(ANSWER);
  }, { preconnect: realFetch.preconnect });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
});

function ctxWith(extra: Partial<HostCtx>): HostCtx {
  const sandbox = initializeSandbox();
  return { db: getFirestore(sandbox), sandbox, instanceId: 'test-gemini', subs: new Map(), ...extra };
}

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage: (msg: OutboundMessage) => { messages.push(msg); } };
}

async function sendOp(ctx: HostCtx, msg: InboundMessage): Promise<ResMessage> {
  const port = fakePort();
  await handleMessage(ctx, port, msg);
  const res = port.messages.find((m): m is ResMessage => m.t === 'res');
  if (!res) throw new Error('no res message');
  return res;
}

async function appCheckToken(): Promise<string> {
  const { mintAppCheckToken } = await import('pyric/sandbox/internal');
  return (await mintAppCheckToken({ appId: '1:123456789012:web:abc', projectId: 'demo' }, 3600)).token;
}

const request = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

describe('the gemini engine in a browser worker', () => {
  it('sends through /__pyric/ai-proxy/gemini with no key, whatever base URL the config names', async () => {
    const ctx = ctxWith({ aiEngine: { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' } });
    const res = await sendOp(ctx, {
      t: 'op', id: 'g1', method: 'ai.generateContent', model: MODEL, request, appCheck: { token: await appCheckToken() },
    });
    expect(res.ok).toBe(true);
    expect(sent).toEqual([{ url: '/__pyric/ai-proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent', headers: { 'Content-Type': 'application/json' } }]);
  });

  it('is refused by the App Check gate before the proxy is called', async () => {
    const ctx = ctxWith({ aiEngine: { kind: 'gemini' } });
    const res = await sendOp(ctx, { t: 'op', id: 'g2', method: 'ai.generateContent', model: MODEL, request, appCheck: { token: null } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.aiEnvelope?.error).toMatchObject({ code: 403, status: 'PERMISSION_DENIED' });
    expect(sent).toEqual([]);
  });

  it('keeps its own target when the config holds its own key', async () => {
    const ctx = ctxWith({ aiEngine: { kind: 'gemini', baseUrl: 'http://gemini.test', apiKey: 'page-key' } });
    await sendOp(ctx, { t: 'op', id: 'g3', method: 'ai.countTokens', model: MODEL, request });
    expect(sent.map((s) => s.url)).toEqual(['http://gemini.test/v1beta/models/gemini-2.5-flash:countTokens?key=page-key']);
  });
});

describe('the gemini engine on the Node host', () => {
  it('keeps the configured target and reads the key from its own environment', async () => {
    const aiUpstream = { baseUrl: 'http://127.0.0.1:11434/v1', fetch: globalThis.fetch };
    const ctx = ctxWith({ aiUpstream, aiEngine: { kind: 'gemini', baseUrl: 'http://gemini.test' } });
    await sendOp(ctx, { t: 'op', id: 'g4', method: 'ai.countTokens', model: MODEL, request });
    expect(sent.map((s) => s.url)).toEqual(['http://gemini.test/v1beta/models/gemini-2.5-flash:countTokens?key=server-only-key']);
  });
});
