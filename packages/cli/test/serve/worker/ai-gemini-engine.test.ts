/**
 * The gemini engine in the worker host (#1584). A browser worker
 * (`aiRunsInBrowser`, set by the worker entry) has no server environment, so it sends through the dev server's gemini proxy with
 * no credentials, and only after the App Check gate admits the request. The
 * Node host keeps the configured target and reads its own environment.
 *
 * A real pyric sandbox and fake MessagePorts, as in ai-ops.test.ts; the
 * network is a recorded `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
    const ctx = ctxWith({ aiRunsInBrowser: true, aiEngine: { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' } });
    const res = await sendOp(ctx, {
      t: 'op', id: 'g1', method: 'ai.generateContent', model: MODEL, request, appCheck: { token: await appCheckToken() },
    });
    expect(res.ok).toBe(true);
    expect(sent).toEqual([{ url: '/__pyric/ai-proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent', headers: { 'Content-Type': 'application/json' } }]);
  });

  it('is refused by the App Check gate before the proxy is called', async () => {
    const ctx = ctxWith({ aiRunsInBrowser: true, aiEngine: { kind: 'gemini' } });
    const res = await sendOp(ctx, { t: 'op', id: 'g2', method: 'ai.generateContent', model: MODEL, request, appCheck: { token: null } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.aiEnvelope?.error).toMatchObject({ code: 401, status: 'UNAUTHENTICATED', message: 'Firebase App Check token is invalid.' });
    expect(sent).toEqual([]);
  });

  it('keeps its own target when the config holds its own key', async () => {
    const ctx = ctxWith({ aiRunsInBrowser: true, aiEngine: { kind: 'gemini', baseUrl: 'http://gemini.test', apiKey: 'page-key' } });
    await sendOp(ctx, { t: 'op', id: 'g3', method: 'ai.countTokens', model: MODEL, request });
    expect(sent.map((s) => s.url)).toEqual(['http://gemini.test/v1beta/models/gemini-2.5-flash:countTokens?key=page-key']);
  });

  it('routes blank or whitespace-only apiKey through the gemini proxy instead of honoring page baseUrl (#1599)', async () => {
    for (const blankKey of ['', '   ']) {
      sent = [];
      const ctx = ctxWith({ aiRunsInBrowser: true });
      const res = await sendOp(ctx, {
        t: 'op',
        id: `blank-${blankKey.length}`,
        method: 'ai.countTokens',
        model: MODEL,
        request,
        engine: { kind: 'gemini', baseUrl: 'http://attacker.example', apiKey: blankKey },
      });
      expect(res.ok).toBe(true);
      expect(sent.map((s) => s.url)).toEqual([
        '/__pyric/ai-proxy/gemini/v1beta/models/gemini-2.5-flash:countTokens',
      ]);
    }
  });
});

describe('the gemini engine on the Node host', () => {
  it('a host that is not marked as a browser worker keeps the configured target, as before', async () => {
    // A Node repro replay builds a worker ctx with no aiUpstream and no browser flag.
    const ctx = ctxWith({ aiEngine: { kind: 'gemini', baseUrl: 'http://gemini.test' } });
    await sendOp(ctx, { t: 'op', id: 'g5', method: 'ai.countTokens', model: MODEL, request });
    expect(sent.map((s) => s.url)).toEqual(['http://gemini.test/v1beta/models/gemini-2.5-flash:countTokens?key=server-only-key']);
  });

  it('keeps the configured target and reads the key from its own environment', async () => {
    const aiUpstream = { baseUrl: 'http://127.0.0.1:11434/v1', fetch: globalThis.fetch };
    const ctx = ctxWith({ aiUpstream, aiEngine: { kind: 'gemini', baseUrl: 'http://gemini.test' } });
    await sendOp(ctx, { t: 'op', id: 'g4', method: 'ai.countTokens', model: MODEL, request });
    expect(sent.map((s) => s.url)).toEqual(['http://gemini.test/v1beta/models/gemini-2.5-flash:countTokens?key=server-only-key']);
  });

  it('ignores page-supplied baseUrl on hosted Node host when page supplies no apiKey, empty apiKey, or whitespace apiKey (#1599)', async () => {
    const attackerBase = 'http://attacker.example/steal';
    const cases: Array<{ label: string; apiKey?: string }> = [
      { label: 'missing-key' },
      { label: 'empty-key', apiKey: '' },
      { label: 'whitespace-key', apiKey: '   \t  ' },
    ];
    for (const testCase of cases) {
      sent = [];
      const ctx = ctxWith({ aiRunsInBrowser: false });
      const engine =
        testCase.apiKey === undefined
          ? { kind: 'gemini' as const, baseUrl: attackerBase }
          : { kind: 'gemini' as const, baseUrl: attackerBase, apiKey: testCase.apiKey };
      const res = await sendOp(ctx, {
        t: 'op',
        id: `hosted-unary-${testCase.label}`,
        method: 'ai.generateContent',
        model: MODEL,
        request,
        engine,
      });
      expect(res.ok).toBe(true);
      expect(sent).toHaveLength(1);
      const targetUrl = sent[0]?.url ?? '';
      expect(targetUrl).not.toContain('attacker.example');
      expect(targetUrl).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=server-only-key',
      );
    }
  });

  it('ignores page-supplied baseUrl for GOOGLE_GENAI_API_KEY and streamGenerateContent (#1599)', async () => {
    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGoogle = process.env.GOOGLE_GENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_GENAI_API_KEY = 'google-genai-server-secret-1599';
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        sent.push({ url: String(input), headers: init?.headers });
        return new Response(`data: ${JSON.stringify(ANSWER)}\r\n\r\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
      { preconnect: realFetch.preconnect },
    );
    try {
      const ctx = ctxWith({ aiRunsInBrowser: false });
      const port = fakePort();
      await handleMessage(ctx, port, {
        t: 'sub',
        subId: 'stream-1599',
        target: { service: 'ai', op: 'streamGenerateContent' },
        model: MODEL,
        request,
        appCheck: { token: await appCheckToken() },
        engine: { kind: 'gemini', baseUrl: 'http://attacker.example/stream' },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(sent).toHaveLength(1);
      const targetUrl = sent[0]?.url ?? '';
      expect(targetUrl).not.toContain('attacker.example');
      expect(targetUrl).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=google-genai-server-secret-1599',
      );
    } finally {
      if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGemini;
      if (prevGoogle === undefined) delete process.env.GOOGLE_GENAI_API_KEY;
      else process.env.GOOGLE_GENAI_API_KEY = prevGoogle;
    }
  });

  it('ignores page-supplied baseUrl when server falls back to ADC (empty env keys) (#1599)', async () => {
    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGoogle = process.env.GOOGLE_GENAI_API_KEY;
    const prevPath = process.env.PATH;
    const fakeAdcToken = 'synthetic-adc-token-1599';
    const binDir = mkdtempSync(join(tmpdir(), 'pyric-adc-stub-1599-'));
    const gcloudStub = join(binDir, 'gcloud');
    writeFileSync(gcloudStub, `#!/bin/sh\nprintf '%s\\n' '${fakeAdcToken}'\n`);
    chmodSync(gcloudStub, 0o755);
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
    process.env.PATH = prevPath ? `${binDir}${delimiter}${prevPath}` : binDir;
    try {
      const ctx = ctxWith({ aiRunsInBrowser: false });
      const res = await sendOp(ctx, {
        t: 'op',
        id: 'hosted-adc-1599',
        method: 'ai.countTokens',
        model: MODEL,
        request,
        engine: { kind: 'gemini', baseUrl: 'http://attacker.example/adc', apiKey: '   ' },
      });
      expect(res.ok).toBe(true);
      expect(sent).toHaveLength(1);
      const sentReq = sent[0];
      expect(sentReq?.url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:countTokens',
      );
      expect(sentReq?.url).not.toContain('attacker.example');
      expect((sentReq?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        `Bearer ${fakeAdcToken}`,
      );
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGemini;
      if (prevGoogle === undefined) delete process.env.GOOGLE_GENAI_API_KEY;
      else process.env.GOOGLE_GENAI_API_KEY = prevGoogle;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('allows page-supplied baseUrl on Node host only when paired with a non-blank page apiKey, never attaching server credentials (#1599)', async () => {
    const ctx = ctxWith({ aiRunsInBrowser: false });
    const res = await sendOp(ctx, {
      t: 'op',
      id: 'hosted-page-key-1599',
      method: 'ai.countTokens',
      model: MODEL,
      request,
      engine: { kind: 'gemini', baseUrl: 'http://custom.page.test', apiKey: '  page-supplied-key-1599  ' },
    });
    expect(res.ok).toBe(true);
    expect(sent.map((s) => s.url)).toEqual([
      'http://custom.page.test/v1beta/models/gemini-2.5-flash:countTokens?key=page-supplied-key-1599',
    ]);
    expect(sent[0]?.url).not.toContain('server-only-key');
  });

  it('ignores smuggled serverAttachesAuth from page opEngine and keeps server ctx.aiEngine precedence (#1599)', async () => {
    const ctxWithoutServer = ctxWith({ aiRunsInBrowser: false });
    await sendOp(ctxWithoutServer, {
      t: 'op',
      id: 'hosted-smuggle-1599',
      method: 'ai.countTokens',
      model: MODEL,
      request,
      engine: {
        kind: 'gemini',
        baseUrl: 'http://attacker.example/smuggled',
        serverAttachesAuth: true,
      } as unknown as { kind: 'gemini'; baseUrl: string },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).not.toContain('attacker.example');

    sent = [];
    const ctxWithServer = ctxWith({
      aiRunsInBrowser: false,
      aiEngine: { kind: 'gemini', baseUrl: 'http://server-configured.test' },
    });
    await sendOp(ctxWithServer, {
      t: 'op',
      id: 'hosted-precedence-1599',
      method: 'ai.countTokens',
      model: MODEL,
      request,
      engine: { kind: 'gemini', baseUrl: 'http://attacker.example/override', apiKey: 'page-key' },
    });
    expect(sent.map((s) => s.url)).toEqual([
      'http://server-configured.test/v1beta/models/gemini-2.5-flash:countTokens?key=server-only-key',
    ]);
  });
});
