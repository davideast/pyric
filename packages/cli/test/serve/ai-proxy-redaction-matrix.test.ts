import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';

const handles: ServeHandle[] = [];
const upstreams: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.stop();
  }
  while (upstreams.length > 0) {
    const srv = upstreams.pop()!;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const SESSION_TOKEN = 'ai-redaction-matrix-session-token';

async function startProxyHarness(opts: {
  aiProxyUpstream?: string;
  geminiBaseUrl?: string;
  geminiApiKey?: string;
}): Promise<ServeHandle> {
  const root = mkdtempSync(join(tmpdir(), 'pyric-ai-redaction-'));
  tempDirs.push(root);
  const siteDir = join(root, 'public');
  const sdkDir = join(root, 'sdk');
  mkdirSync(siteDir, { recursive: true });
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(join(siteDir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n');

  let aiGemini: { baseUrl?: string; apiKey?: string } | undefined;
  if (opts.geminiBaseUrl !== undefined || opts.geminiApiKey !== undefined) {
    aiGemini = { baseUrl: opts.geminiBaseUrl, apiKey: opts.geminiApiKey };
  }
  const ns = createPyricNamespace({
    sdkDir,
    sessionToken: SESSION_TOKEN,
    requireSessionToken: true,
    aiProxyUpstream: opts.aiProxyUpstream,
    aiGemini,
    initPayload: () => ({
      rules: null,
      rulesHash: null,
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
    }),
  });
  const handle = await startStaticServer({
    publicDir: siteDir,
    host: '127.0.0.1',
    port: 0,
    namespaceHandler: ns,
    sessionToken: SESSION_TOKEN,
    logger: silentServeLogger(),
  });
  handles.push(handle);
  return handle;
}

describe('AI and Gemini proxy upstream credential redaction matrix (ADR 0024)', () => {
  it('joins query-bearing proxyUpstream paths cleanly (including trailing-slash Base64 keys) and redacts configured query keys on non-2xx responses', async () => {
    const querySecret = 'UPSTREAM_QUERY_KEY_SECRET_9988/';
    const seenUrls: string[] = [];
    const upstream = createServer((req, res) => {
      seenUrls.push(req.url ?? '');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: `Invalid key ${querySecret} on request ${req.url ?? ''}` },
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreams.push(upstream);
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const handle = await startProxyHarness({
      aiProxyUpstream: `http://127.0.0.1:${upstreamPort}/v1/?key=${querySecret}`,
    });

    const res = await fetch(`${handle.url}/__pyric/ai-proxy/chat/completions?stream=false`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pyric-session-token': SESSION_TOKEN,
      },
      body: JSON.stringify({ model: 'demo-model', messages: [] }),
    });
    expect(res.status).toBe(401);
    expect(seenUrls).toEqual([`/v1/chat/completions?key=${encodeURIComponent(querySecret)}&stream=false`]);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(querySecret);
    expect(bodyText).not.toContain(encodeURIComponent(querySecret));
    expect(JSON.parse(bodyText).error.message).toContain('***');
  });

  it('redacts synthesized Basic-auth base64 credentials in Gemini proxy error responses and SSE error frames', async () => {
    const basicUser = 'gw-svc';
    const basicPass = 'GW_BASIC_SECRET_445566';
    const basicBase64 = Buffer.from(`${basicUser}:${basicPass}`, 'utf8').toString('base64');
    const geminiKey = 'GEMINI_KEY_SECRET_112233';

    const upstream = createServer((req, res) => {
      const authHeader = req.headers.authorization ?? '';
      if ((req.url ?? '').includes(':streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"candidates":[{"content":{"parts":[{"text":"chunk-1"}]}}]}\n\n');
        res.end(
          `data: ${JSON.stringify({
            error: {
              code: 500,
              message: `Gateway stream rejected ${authHeader} for ${basicPass} and ${geminiKey}`,
              status: 'INTERNAL',
            },
          })}\n\n`,
        );
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 401,
            message: `Gateway rejected Authorization=${authHeader}`,
            status: 'UNAUTHENTICATED',
          },
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreams.push(upstream);
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const handle = await startProxyHarness({
      geminiBaseUrl: `http://${basicUser}:${basicPass}@127.0.0.1:${upstreamPort}`,
      geminiApiKey: geminiKey,
    });

    const unaryRes = await fetch(
      `${handle.url}/__pyric/ai-proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pyric-session-token': SESSION_TOKEN,
        },
        body: '{"contents":[]}',
      },
    );
    expect(unaryRes.status).toBe(401);
    const unaryText = await unaryRes.text();
    expect(unaryText).not.toContain(basicBase64);
    expect(unaryText).not.toContain(basicPass);

    const streamRes = await fetch(
      `${handle.url}/__pyric/ai-proxy/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pyric-session-token': SESSION_TOKEN,
        },
        body: '{"contents":[]}',
      },
    );
    expect(streamRes.status).toBe(200);
    const streamText = await streamRes.text();
    expect(streamText).toContain('chunk-1');
    expect(streamText).not.toContain(basicBase64);
    expect(streamText).not.toContain(basicPass);
    expect(streamText).not.toContain(geminiKey);
  });

  it('redacts upstream Basic-auth, query-key, and Bearer credentials inside OpenAI ai-proxy 200 text/event-stream mid-stream error frames', async () => {
    const basicUser = 'proxy-svc';
    const basicPass = 'PROXY_STREAM_PASS_8877';
    const basicBase64 = Buffer.from(`${basicUser}:${basicPass}`, 'utf8').toString('base64');
    const querySecret = 'PROXY_STREAM_QUERY_SECRET_5544';

    const upstream = createServer((req, res) => {
      const authHeader = req.headers.authorization ?? '';
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n');
      const errorLine = `data: ${JSON.stringify({
        error: {
          message: `Mid-stream upstream failure: ${authHeader} (${basicPass}) url=${req.url ?? ''}`,
        },
      })}\n\n`;
      const splitIndex = Math.floor(errorLine.length / 2);
      res.write(errorLine.slice(0, splitIndex));
      setImmediate(() => {
        res.write(errorLine.slice(splitIndex));
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreams.push(upstream);
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const handle = await startProxyHarness({
      aiProxyUpstream: `http://${basicUser}:${basicPass}@127.0.0.1:${upstreamPort}/v1?key=${querySecret}`,
    });

    const sseRes = await fetch(`${handle.url}/__pyric/ai-proxy/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pyric-session-token': SESSION_TOKEN,
      },
      body: '{"stream":true}',
    });
    expect(sseRes.status).toBe(200);
    const sseText = await sseRes.text();
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    expect(sseText).toContain('partial answer');
    expect(sseText).toContain('data: [DONE]');
    expect(sseText).not.toContain(basicBase64);
    expect(sseText).not.toContain(basicPass);
    expect(sseText).not.toContain(querySecret);
  });
});
