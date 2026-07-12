/**
 * `/__pyric/ai-proxy` — the same-origin passthrough to an OpenAI-compatible
 * upstream (pyric/ai, cdd-deltas #98.2). Exercised over the REAL serve
 * server with a tiny Bun.serve upstream:
 *   - POST forwards path suffix + query + body + headers, minus the
 *     origin-sensitive set (origin/referer/cookie stripped; authorization kept)
 *   - the response body STREAMS through — the client sees the first SSE event
 *     while the upstream is still holding the stream open (no buffering)
 *   - POST-only (405), unreachable upstream → 502
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';

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

async function startServe(aiProxyUpstream: string): Promise<ServeHandle> {
  const { site, sdk } = fixture();
  const ns = createPyricNamespace({
    sdkDir: sdk,
    initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    aiProxyUpstream,
  });
  const h = await startStaticServer({
    publicDir: site,
    port: 0,
    host: '127.0.0.1',
    portScanLimit: 200,
    logger: silentServeLogger(),
    namespaceHandler: ns,
  });
  handles.push(h);
  return h;
}

describe('/__pyric/ai-proxy', () => {
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
    // Port 9 (discard) — nothing listens on loopback.
    const h = await startServe('http://127.0.0.1:9/v1');
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
