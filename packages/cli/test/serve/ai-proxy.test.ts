/**
 * `/__pyric/ai-proxy` — the same-origin passthrough to an OpenAI-compatible
 * upstream (pyric/ai, cdd-deltas #98.2). Exercised over the REAL serve
 * server with a tiny Bun.serve upstream:
 *   - POST forwards path suffix + query + body + headers, minus the
 *     origin-sensitive set (origin/referer/cookie stripped; authorization kept)
 *   - the response body STREAMS through — the client sees the first SSE event
 *     while the upstream is still holding the stream open (no buffering)
 *   - POST-only (405), unreachable upstream → 502
 *   - upstream failures (unreachable / non-2xx / mid-stream abort) reach the
 *     dev server's terminal logger as structured warnings
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace, formatAiProxyWarning } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer, type ServeHandle, type ServeLogger } from '../../src/serve/server.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-aiproxy-'));
  const site = join(dir, 'public');
  const sdk = join(dir, 'sdk');
  for (const d of [site, sdk]) mkdirSync(d);
  writeFileSync(join(site, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  return { site, sdk };
}

const handles: ServeHandle[] = [];
const upstreams: Array<{ stop(): void }> = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
  while (upstreams.length) upstreams.pop()!.stop();
});

function recordingLogger(): { logger: ServeLogger; notes: string[] } {
  const notes: string[] = [];
  return { logger: { info: () => {}, note: (m) => notes.push(m) }, notes };
}

async function startServe(aiProxyUpstream?: string, logger?: ServeLogger): Promise<ServeHandle> {
  const { site, sdk } = fixture();
  const ns = createPyricNamespace({
    sdkDir: sdk,
    initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    aiProxyUpstream,
    ...(logger ? { logger } : {}),
  });
  const h = await startStaticServer({
    publicDir: site,
    port: 0,
    host: '127.0.0.1',
    portScanLimit: 200,
    logger: logger ?? silentServeLogger(),
    namespaceHandler: ns,
  });
  handles.push(h);
  return h;
}

function closedLoopbackUrl(path = ''): string {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  });
  const url = `http://127.0.0.1:${server.port}${path}`;
  server.stop(true);
  return url;
}

describe('/__pyric/ai-proxy', () => {
  it('defaults to Ollama\'s OpenAI-compatible endpoint', async () => {
    const h = await startServe();
    const nativeFetch = globalThis.fetch;
    const priorEnv = process.env.PYRIC_AI_PROXY_UPSTREAM;
    let target = '';
    delete process.env.PYRIC_AI_PROXY_UPSTREAM;
    globalThis.fetch = (async (input: string | URL | Request) => {
      target = String(input);
      return Response.json({ choices: [] });
    }) as typeof fetch;
    try {
      const res = await nativeFetch(`${h.url}/__pyric/ai-proxy/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      expect(target).toBe('http://localhost:11434/v1/chat/completions');
    } finally {
      globalThis.fetch = nativeFetch;
      if (priorEnv === undefined) delete process.env.PYRIC_AI_PROXY_UPSTREAM;
      else process.env.PYRIC_AI_PROXY_UPSTREAM = priorEnv;
    }
  });

  it('forwards POST path suffix + query + body, keeps authorization, strips origin-sensitive headers', async () => {
    const seen: Array<{ method: string; url: string; body: string; headers: Headers }> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        seen.push({ method: req.method, url: req.url, body: await req.text(), headers: req.headers });
        return Response.json({ id: 'chatcmpl-1', choices: [] });
      },
    });
    upstreams.push(upstream);

    const h = await startServe(`http://127.0.0.1:${upstream.port}/v1`);
    const res = await fetch(`${h.url}/__pyric/ai-proxy/chat/completions?probe=1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
        origin: 'http://evil.example',
        referer: 'http://evil.example/page',
        cookie: 'session=secret',
      },
      body: JSON.stringify({ model: 'llama3', messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'chatcmpl-1', choices: [] });

    expect(seen.length).toBe(1);
    const hit = seen[0]!;
    expect(hit.method).toBe('POST');
    expect(new URL(hit.url).pathname).toBe('/v1/chat/completions');
    expect(new URL(hit.url).search).toBe('?probe=1');
    expect(JSON.parse(hit.body)).toEqual({ model: 'llama3', messages: [] });
    // authorization forwards (upstreams may require a key)…
    expect(hit.headers.get('authorization')).toBe('Bearer test-key');
    expect(hit.headers.get('content-type')).toBe('application/json');
    // …origin-sensitive context does NOT.
    expect(hit.headers.get('origin')).toBeNull();
    expect(hit.headers.get('referer')).toBeNull();
    expect(hit.headers.get('cookie')).toBeNull();
  });

  it('streams SSE through without buffering (first event arrives while upstream is still open)', async () => {
    let release: (() => void) | undefined;
    const released = new Promise<void>((r) => {
      release = r;
    });
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode('data: {"n":1}\n\n'));
            // Hold the stream OPEN until the test has observed event 1 on the
            // proxied response — proving the proxy did not buffer to the end.
            await released;
            controller.enqueue(encoder.encode('data: {"n":2}\n\ndata: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    upstreams.push(upstream);

    const h = await startServe(`http://127.0.0.1:${upstream.port}/v1`);
    const res = await fetch(`${h.url}/__pyric/ai-proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"stream":true}',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    // Read until event 1 shows — the upstream is STILL blocked on `released`.
    while (!received.includes('data: {"n":1}')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('stream ended before the first event arrived');
      received += decoder.decode(value, { stream: true });
    }
    // Now let the upstream finish; the rest must flow through.
    release!();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    expect(received).toBe('data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n');
  });

  it('rejects non-POST with 405', async () => {
    const h = await startServe('http://127.0.0.1:9/v1');
    const res = await fetch(`${h.url}/__pyric/ai-proxy/chat/completions`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('answers 502 with a pointer when the upstream is unreachable', async () => {
    const h = await startServe(closedLoopbackUrl('/v1'));
    const res = await fetch(`${h.url}/__pyric/ai-proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('ai-proxy');
    expect(text).toContain('PYRIC_AI_PROXY_UPSTREAM');
  });
});

describe('/__pyric/ai-proxy — terminal diagnostics', () => {
  it('warns on the dev logger when the upstream is unreachable', async () => {
    const { logger, notes } = recordingLogger();
    const upstream = closedLoopbackUrl('/v1');
    const h = await startServe(upstream, logger);
    const res = await fetch(`${h.url}/__pyric/ai-proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(502);

    expect(notes.length).toBe(1);
    const line = notes[0]!;
    expect(line).toContain('ai-proxy');
    expect(line).toContain('unreachable');
    // The upstream host must be identifiable in the terminal.
    expect(line).toContain(new URL(upstream).host);
    // …with the underlying cause and a cheap latency stamp.
    expect(line).toMatch(/ECONNREFUSED|refused|Unable to connect|fetch failed/i);
    expect(line).toMatch(/\d+ms/);
  });

  it('warns on the dev logger when the upstream answers non-2xx', async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('model not found', { status: 404 }),
    });
    upstreams.push(upstream);

    const { logger, notes } = recordingLogger();
    const h = await startServe(`http://127.0.0.1:${upstream.port}/v1`, logger);
    const res = await fetch(`${h.url}/__pyric/ai-proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // The status still passes through to the caller untouched…
    expect(res.status).toBe(404);
    // …and it is ALSO surfaced in the terminal.
    expect(notes.length).toBe(1);
    const line = notes[0]!;
    expect(line).toContain('ai-proxy');
    expect(line).toContain('404');
    expect(line).toContain(`127.0.0.1:${upstream.port}`);
    expect(line).toMatch(/\d+ms/);
  });

  it('surfaces the upstream Retry-After backoff on a 429', async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response('rate limit exceeded', { status: 429, headers: { 'retry-after': '12' } }),
    });
    upstreams.push(upstream);

    const { logger, notes } = recordingLogger();
    const h = await startServe(`http://127.0.0.1:${upstream.port}/v1`, logger);
    const res = await fetch(`${h.url}/__pyric/ai-proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // The 429 rides through untouched — nothing here retries or waits.
    expect(res.status).toBe(429);
    expect(notes.length).toBe(1);
    const line = notes[0]!;
    expect(line).toContain('429');
    expect(line).toContain('Retry-After: 12s');
    expect(line).toMatch(/no automatic retry/i);
  });

  it('stays quiet on a 2xx upstream', async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ choices: [] }),
    });
    upstreams.push(upstream);

    const { logger, notes } = recordingLogger();
    const h = await startServe(`http://127.0.0.1:${upstream.port}/v1`, logger);
    const res = await fetch(`${h.url}/__pyric/ai-proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(notes).toEqual([]);
  });

  it('warns when the upstream aborts mid-stream', async () => {
    // Raw TCP: promise a content-length the upstream never delivers, then hang
    // up. (A `Bun.serve` upstream that `controller.error()`s its body is NOT
    // enough — Bun's fetch client reports the truncated read as a clean `done`,
    // so the proxy's stream loop never sees a failure.)
    const truncating = createNetServer((sock) => {
      sock.once('data', () => {
        sock.write(
          'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 100\r\n\r\n',
        );
        sock.write('data: {"n":1}\n\n');
        setTimeout(() => sock.destroy(), 30);
      });
    });
    await new Promise<void>((r) => truncating.listen(0, '127.0.0.1', r));
    const upstreamPort = (truncating.address() as AddressInfo).port;
    upstreams.push({ stop: () => truncating.close() });

    const { logger, notes } = recordingLogger();
    const h = await startServe(`http://127.0.0.1:${upstreamPort}/v1`, logger);
    const res = await fetch(`${h.url}/__pyric/ai-proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"stream":true}',
    });
    expect(res.status).toBe(200);
    try {
      await res.text();
    } catch {
      /* the truncated stream may surface as a read error on the client too */
    }
    expect(notes.length).toBe(1);
    expect(notes[0]!).toContain('ai-proxy');
    expect(notes[0]!).toMatch(/stream/i);
    expect(notes[0]!).toContain(`127.0.0.1:${upstreamPort}`);
  });

  it('redacts key-bearing query params from the logged upstream URL', async () => {
    const { logger, notes } = recordingLogger();
    const h = await startServe(closedLoopbackUrl('/v1'), logger);
    const res = await fetch(`${h.url}/__pyric/ai-proxy/chat/completions?key=AIzaSuperSecretValue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(502);
    expect(notes.length).toBe(1);
    expect(notes[0]!).not.toContain('AIzaSuperSecretValue');
    expect(notes[0]!).toContain('key=***');
  });

  it('drops diagnostics entirely when no logger is wired (never throws)', async () => {
    const h = await startServe(closedLoopbackUrl('/v1'));
    const res = await fetch(`${h.url}/__pyric/ai-proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(502);
  });
});

describe('formatAiProxyWarning', () => {
  const target = 'http://localhost:11434/v1/chat/completions';

  it('renders the unreachable block: cause, POST target + latency, the env-var pointer', () => {
    const lines = formatAiProxyWarning({
      kind: 'unreachable',
      target,
      latencyMs: 7,
      cause: 'connect ECONNREFUSED 127.0.0.1:11434',
    }).split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('ai-proxy');
    expect(lines[0]).toContain('connect ECONNREFUSED 127.0.0.1:11434');
    expect(lines[1]).toBe(`      POST ${target} (7ms)`);
    expect(lines[2]).toContain('PYRIC_AI_PROXY_UPSTREAM');
  });

  it('renders the status block with the upstream status code (two lines, no pointer)', () => {
    const lines = formatAiProxyWarning({ kind: 'status', target, latencyMs: 42, status: 503 }).split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('503');
    expect(lines[1]).toContain('(42ms)');
  });

  it('renders a rate-limit block: 429 headline, the Retry-After backoff, no-retry note', () => {
    const lines = formatAiProxyWarning({
      kind: 'status',
      target,
      latencyMs: 42,
      status: 429,
      retryAfter: '30',
    }).split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('429');
    expect(lines[0]).toMatch(/rate limit/i);
    expect(lines[1]).toContain('(42ms)');
    // Delta-seconds render as a duration, and the terminal states plainly that
    // nothing backs off on the developer's behalf.
    expect(lines[2]).toContain('Retry-After: 30s');
    expect(lines[2]).toMatch(/no automatic retry/i);
  });

  it('keeps a Retry-After-less 429 at two lines', () => {
    const lines = formatAiProxyWarning({ kind: 'status', target, latencyMs: 5, status: 429 }).split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('429');
  });

  it('prints an HTTP-date Retry-After verbatim (no bogus seconds suffix)', () => {
    const block = formatAiProxyWarning({
      kind: 'status',
      target,
      latencyMs: 5,
      status: 503,
      retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT',
    });
    expect(block).toContain('Retry-After: Wed, 21 Oct 2026 07:28:00 GMT');
    expect(block).not.toContain('GMTs');
  });

  it('sanitizes a hostile Retry-After header (control chars, newlines, length)', () => {
    const block = formatAiProxyWarning({
      kind: 'status',
      target,
      latencyMs: 5,
      status: 429,
      retryAfter: `30\n  ⚠ [pyric] forged line\u001b[31m${'x'.repeat(200)}`,
    });
    // One block-line per real line: headline, POST, Retry-After. A header
    // authored by a remote model server cannot forge a fourth.
    expect(block.split('\n').length).toBe(3);
    expect(block).not.toContain('\u001b');
    expect(block.length).toBeLessThan(320);
  });

  it('renders the mid-stream abort block', () => {
    const block = formatAiProxyWarning({
      kind: 'stream-abort',
      target,
      latencyMs: 1200,
      cause: 'socket hang up',
    });
    expect(block).toContain('stream aborted mid-response');
    expect(block).toContain('socket hang up');
    expect(block).toContain('(1200ms)');
  });

  it('masks credential query params in BOTH the target and the cause', () => {
    const block = formatAiProxyWarning({
      kind: 'unreachable',
      target: 'http://up.example/v1/chat?api_key=sk-live-1&model=x',
      latencyMs: 1,
      cause: 'fetch to http://up.example/v1/chat?access_token=tok-2 failed',
    });
    expect(block).not.toContain('sk-live-1');
    expect(block).not.toContain('tok-2');
    expect(block).toContain('api_key=***');
    expect(block).toContain('access_token=***');
    // Non-secret params and the host/path stay readable.
    expect(block).toContain('model=x');
    expect(block).toContain('up.example/v1/chat');
  });
});
