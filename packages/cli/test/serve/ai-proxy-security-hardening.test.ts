import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAiUpstream, handleAiProxy } from '../../src/serve/ai-proxy.js';
import { validateAiProxyPathSuffix } from '../../src/serve/ai-proxy-upstream-policy.js';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';

const SESSION_TOKEN = 'm5-ai-proxy-security-session-token';
const QUERY_SECRET = 'UPSTREAM_QUERY_SECRET_M5_9988';
const BASIC_USER = 'proxy-svc-user';
const BASIC_PASS = 'UPSTREAM_BASIC_SECRET_M5_7766';
const BASIC_BASE64 = Buffer.from(`${BASIC_USER}:${BASIC_PASS}`, 'utf8').toString('base64');
const CLIENT_API_KEY = 'CLIENT_X_API_KEY_SECRET_M5_5544';
const CLIENT_BEARER = 'CLIENT_BEARER_SECRET_M5_3322';

const handles: ServeHandle[] = [];
const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) await handle.stop();
  }
  while (servers.length > 0) {
    const srv = servers.pop();
    if (srv === undefined) continue;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function listenLoopback(
  handler: Parameters<typeof createServer>[0],
): Promise<{ port: number }> {
  const srv = createServer(handler);
  servers.push(srv);
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  return { port: (srv.address() as AddressInfo).port };
}

async function startProxyServer(aiProxyUpstream: string): Promise<ServeHandle> {
  const root = mkdtempSync(join(tmpdir(), 'pyric-m5-aiproxy-'));
  tempDirs.push(root);
  const siteDir = join(root, 'public');
  const sdkDir = join(root, 'sdk');
  mkdirSync(siteDir, { recursive: true });
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(join(siteDir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n');

  const ns = createPyricNamespace({
    sdkDir,
    sessionToken: SESSION_TOKEN,
    requireSessionToken: true,
    aiProxyUpstream,
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

function rawTcpPost(opts: {
  port: number;
  rawPath: string;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyText = opts.body ?? '{}';
    const socket = connect(opts.port, '127.0.0.1', () => {
      const requestHead = [
        `POST ${opts.rawPath} HTTP/1.1`,
        `Host: 127.0.0.1:${opts.port}`,
        'Content-Type: application/json',
        `x-pyric-session-token: ${SESSION_TOKEN}`,
        `Content-Length: ${Buffer.byteLength(bodyText)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      socket.write(requestHead + bodyText);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const sep = raw.indexOf('\r\n\r\n');
      const head = sep === -1 ? raw : raw.slice(0, sep);
      const body = sep === -1 ? '' : raw.slice(sep + 4);
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(head);
      const status = statusMatch !== null ? Number(statusMatch[1]) : 0;
      resolve({ status, body });
    });
  });
}

function rawPost(opts: {
  port: number;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyText = opts.body ?? '{}';
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pyric-session-token': SESSION_TOKEN,
          'content-length': String(Buffer.byteLength(bodyText)),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(bodyText);
    req.end();
  });
}

describe('ai-proxy redirect: manual credential protection', () => {
  it('blocks 301/302/303/307/308 upstream redirects without contacting the redirect target or leaking Location', async () => {
    const attackerHits: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
    const attacker = await listenLoopback((req, res) => {
      attackerHits.push({ url: req.url ?? '', headers: { ...req.headers } });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"stolen":true}');
    });

    const upstream = await listenLoopback((req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      const code = Number(parsed.searchParams.get('status') ?? '307');
      res.writeHead(code, {
        location: `http://127.0.0.1:${attacker.port}/steal?key=${QUERY_SECRET}`,
      });
      res.end(`redirecting with ${QUERY_SECRET}`);
    });

    const handle = await startProxyServer(
      `http://${BASIC_USER}:${BASIC_PASS}@127.0.0.1:${upstream.port}/v1?key=${QUERY_SECRET}`,
    );

    for (const status of [301, 302, 303, 307, 308]) {
      const res = await rawPost({
        port: handle.port,
        path: `/__pyric/ai-proxy/chat/completions?status=${status}`,
        headers: {
          'x-api-key': CLIENT_API_KEY,
          authorization: `Bearer ${CLIENT_BEARER}`,
        },
      });
      expect(res.status).toBe(502);
      expect(res.headers.location).toBeUndefined();
      expect(res.body).not.toContain(QUERY_SECRET);
      expect(res.body).not.toContain(BASIC_PASS);
      expect(res.body).not.toContain(CLIENT_API_KEY);
      expect(res.body).not.toContain(CLIENT_BEARER);
    }
    expect(attackerHits).toEqual([]);

    // fetchAiUpstream directly enforces redirect: 'manual' even when caller passes redirect: 'follow'.
    const directRes = await fetchAiUpstream(
      `http://127.0.0.1:${upstream.port}/v1/chat/completions?status=307`,
      {
        method: 'POST',
        redirect: 'follow',
        headers: { 'x-api-key': CLIENT_API_KEY },
        body: '{}',
      },
      { shouldPrint: () => false },
    );
    expect(directRes.status).toBe(307);
    await directRes.body?.cancel();
    expect(attackerHits).toEqual([]);
  });
});

describe('ai-proxy upstream path-suffix validation and allowlist', () => {
  it('rejects raw/encoded traversal, malformed syntax, and disallowed endpoints before reaching upstream', async () => {
    const upstreamHits: string[] = [];
    const upstream = await listenLoopback((req, res) => {
      upstreamHits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });

    const handle = await startProxyServer(
      `http://127.0.0.1:${upstream.port}/v1?key=${QUERY_SECRET}`,
    );

    const traversalAndMalformedPaths = [
      '/__pyric/ai-proxy/chat/%2e%2e/api/delete',
      '/__pyric/ai-proxy/chat/completions/%2e%2e/completions',
      '/__pyric/ai-proxy/%2E%2E%2Fapi%2Fdelete',
      '/__pyric/ai-proxy/chat/completions/..%2f..%2fapi/delete',
      '/__pyric/ai-proxy/chat/completions/../completions',
      '/__pyric/ai-proxy/chat/completions/..',
      '/__pyric/ai-proxy/./chat/completions',
      '/__pyric/ai-proxy/%252e%252e/admin',
      '/__pyric/ai-proxy/chat%5c..%5cadmin',
      '/__pyric/ai-proxy/chat\\..\\admin',
      '/__pyric/ai-proxy//evil.example/chat/completions',
      '/__pyric/ai-proxy/chat//completions',
      '/__pyric/ai-proxy/chat/completions/',
      '/__pyric/ai-proxy/@evil.example',
    ];
    for (const badPath of traversalAndMalformedPaths) {
      const res = await rawTcpPost({ port: handle.port, rawPath: badPath });
      expect(res.status).toBe(400);
      expect(res.body).not.toContain(QUERY_SECRET);
    }

    // Prefix-escaping dot-segments are rejected before upstream both at HTTP routing and directly.
    for (const escapePath of ['/__pyric/ai-proxy/%2e%2e/api/delete', '/__pyric/ai-proxy/../api/delete']) {
      const res = await rawTcpPost({ port: handle.port, rawPath: escapePath });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toContain(QUERY_SECRET);
      const direct = validateAiProxyPathSuffix(escapePath, '/__pyric/api/delete', '/__pyric/ai-proxy');
      expect(direct.ok).toBe(false);
      if (!direct.ok) expect(direct.status).toBe(400);
    }

    const disallowedEndpoints = [
      '/__pyric/ai-proxy/admin/keys',
      '/__pyric/ai-proxy/api/delete',
      '/__pyric/ai-proxy/api/pull',
      '/__pyric/ai-proxy/models',
    ];
    for (const badEndpoint of disallowedEndpoints) {
      const res = await rawPost({ port: handle.port, path: badEndpoint });
      expect(res.status).toBe(404);
      expect(res.body).not.toContain(QUERY_SECRET);
    }

    expect(upstreamHits).toEqual([]);

    // Positive: allowlisted OpenAI POST suffixes forward cleanly.
    const allowedSuffixes = [
      '',
      '/chat/completions',
      '/completions',
      '/embeddings',
      '/responses',
      '/v1/chat/completions',
    ];
    for (const suffix of allowedSuffixes) {
      const res = await rawPost({ port: handle.port, path: `/__pyric/ai-proxy${suffix}` });
      expect(res.status).toBe(200);
    }
    expect(upstreamHits).toEqual([
      `/v1?key=${QUERY_SECRET}`,
      `/v1/chat/completions?key=${QUERY_SECRET}`,
      `/v1/completions?key=${QUERY_SECRET}`,
      `/v1/embeddings?key=${QUERY_SECRET}`,
      `/v1/responses?key=${QUERY_SECRET}`,
      `/v1/v1/chat/completions?key=${QUERY_SECRET}`,
    ]);
  });

  it('reads req.originalUrl when Connect/Vite middleware strips the /__pyric mount prefix from req.url', async () => {
    const upstreamHits: string[] = [];
    const upstream = await listenLoopback((req, res) => {
      upstreamHits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    const upstreamUrl = `http://127.0.0.1:${upstream.port}/v1`;
    const throttle = { shouldPrint: () => false };

    // Simulate Connect/Vite `server.middlewares.use('/__pyric', ...)` stripping the mount prefix from req.url
    // while retaining the unstripped raw request target in req.originalUrl.
    const mounted = await listenLoopback((req, res) => {
      const mountedReq = req as typeof req & { originalUrl?: string };
      const rawUrl = mountedReq.url ?? '/';
      mountedReq.originalUrl = rawUrl;
      mountedReq.url = rawUrl.replace(/^\/__pyric(?=\/|$)/, '') || '/';
      const parsed = new URL(rawUrl, `http://${req.headers.host ?? '127.0.0.1'}`);
      void handleAiProxy(upstreamUrl, throttle, mountedReq, res, parsed);
    });

    // Positive: Connect/Vite strips '/__pyric' from req.url while keeping full path in req.originalUrl.
    const okRes = await rawPost({
      port: mounted.port,
      path: '/__pyric/ai-proxy/chat/completions',
    });
    expect(okRes.status).toBe(200);
    expect(upstreamHits).toEqual(['/v1/chat/completions']);

    // Negative: raw traversal inside req.originalUrl is still rejected with 400 even when URL normalizes it.
    const badRes = await rawTcpPost({
      port: mounted.port,
      rawPath: '/__pyric/ai-proxy/chat/completions/%2e%2e/completions',
    });
    expect(badRes.status).toBe(400);
    expect(upstreamHits).toEqual(['/v1/chat/completions']);
  });
});

describe('ai-proxy exact credential redaction across JSON, SSE, and plain/non-JSON responses', () => {
  it('redacts exact and transformed credentials in 200 JSON, plain text, HTML, empty Content-Type, SSE, and non-2xx errors', async () => {
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const upstream = await listenLoopback((req, res) => {
      const mode = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('mode');
      if (mode === 'json-200') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            id: 'cmpl-ok',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content:
                    `echo query=${QUERY_SECRET} enc=${encodeURIComponent(QUERY_SECRET)} ` +
                    `pass=${BASIC_PASS} basic=${BASIC_BASE64} api=${CLIENT_API_KEY} ` +
                    `keep=https://example.test/?key=keep-me-intact`,
                },
              },
            ],
          }),
        );
        return;
      }
      if (mode === 'problem-json-200') {
        res.writeHead(200, { 'content-type': 'application/problem+json' });
        res.end(JSON.stringify({ title: 'ok', detail: `token=${QUERY_SECRET} auth=${BASIC_BASE64}` }));
        return;
      }
      if (mode === 'plain-200') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`upstream plain echo ${QUERY_SECRET} ${BASIC_PASS} ${CLIENT_API_KEY}`);
        return;
      }
      if (mode === 'html-200') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html><body>error ${QUERY_SECRET} ${BASIC_BASE64}</body></html>`);
        return;
      }
      if (mode === 'empty-ct-200') {
        res.writeHead(200);
        res.end(`no content-type ${QUERY_SECRET} ${CLIENT_API_KEY}`);
        return;
      }
      if (mode === 'octet-200') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(`octet echo ${QUERY_SECRET} ${BASIC_PASS} ${BASIC_BASE64} ${CLIENT_API_KEY}`);
        return;
      }
      if (mode === 'plain-500') {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(
          `Gateway failure for ${QUERY_SECRET} and ${BASIC_PASS} (${BASIC_BASE64}) key=${CLIENT_API_KEY}`,
        );
        return;
      }
      if (mode === 'sse-200') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(
          `data: {"choices":[{"delta":{"content":"chunk1 ${QUERY_SECRET} https://example.test/?key=keep-me-intact"}}]}\n\n`,
        );
        void streamGate.then(() => {
          const splitSecret = `data: {"choices":[{"delta":{"content":"split ${BASIC_PASS}"}}]}\r\n\r\n`;
          const cut = splitSecret.indexOf(BASIC_PASS) + 5;
          res.write(splitSecret.slice(0, cut));
          setImmediate(() => {
            res.write(splitSecret.slice(cut));
            res.write(`data: plain non-json sse error ${CLIENT_API_KEY} ${BASIC_BASE64}\n\n`);
            res.end('data: [DONE]\n\n');
          });
        });
        return;
      }
      res.writeHead(400).end('unknown mode');
    });

    const handle = await startProxyServer(
      `http://${BASIC_USER}:${BASIC_PASS}@127.0.0.1:${upstream.port}/v1?key=${QUERY_SECRET}`,
    );

    const secrets = [
      QUERY_SECRET,
      encodeURIComponent(QUERY_SECRET),
      BASIC_PASS,
      BASIC_BASE64,
      CLIENT_API_KEY,
    ];

    for (const [mode, expectedStatus] of [
      ['json-200', 200],
      ['problem-json-200', 200],
      ['plain-200', 200],
      ['html-200', 200],
      ['empty-ct-200', 200],
      ['octet-200', 200],
      ['plain-500', 500],
    ] as const) {
      const res = await rawPost({
        port: handle.port,
        path: `/__pyric/ai-proxy/chat/completions?mode=${mode}`,
        headers: { 'x-api-key': CLIENT_API_KEY },
      });
      expect(res.status).toBe(expectedStatus);
      for (const secret of secrets) {
        expect(res.body).not.toContain(secret);
      }
      expect(res.body).toContain('***');
      if (mode === 'json-200') {
        expect(res.body).toContain('https://example.test/?key=keep-me-intact');
      }
    }

    // SSE 200: first masked event streams before upstream closes, and split/plain secrets are masked.
    const sseRes = await fetch(`${handle.url}/__pyric/ai-proxy/chat/completions?mode=sse-200`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pyric-session-token': SESSION_TOKEN,
        'x-api-key': CLIENT_API_KEY,
      },
      body: '{"stream":true}',
    });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return;

    const decoder = new TextDecoder();
    let sseText = '';
    while (!sseText.includes('chunk1')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('SSE stream ended before first event arrived');
      sseText += decoder.decode(value, { stream: true });
    }
    expect(sseText).not.toContain(QUERY_SECRET);
    expect(sseText).toContain('chunk1 ***');
    expect(sseText).toContain('https://example.test/?key=keep-me-intact');

    if (releaseStream !== undefined) releaseStream();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseText += decoder.decode(value, { stream: true });
    }
    for (const secret of secrets) {
      expect(sseText).not.toContain(secret);
    }
    expect(sseText).toContain('split ***');
    expect(sseText).toContain('plain non-json sse error *** ***');
    expect(sseText).toContain('data: [DONE]');
  });
});
