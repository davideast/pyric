/**
 * #1568 review: while a hosted Vite server restarts, the new plugin instance
 * closes the old generation before it builds its own, and the old generation's
 * middleware goes inactive. Its `/__pyric/health` must keep answering 503, as
 * a closed bridge mount does, so `pyric run --wait` keeps waiting for the
 * replacement. Falling through to Vite's 404 reads as "not a sandbox host".
 */
import { describe, expect, it } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ViteDevServer } from 'vite';
import type { BridgeMount } from '../../src/serve/bridge-mount.js';
import { createDiagnostics } from '../../src/serve/diagnostics.js';
import { evaluateNamespaceSurface, writeGuardRejection } from '../../src/serve/namespace-guards.js';
import { DIAGNOSTICS_PATH } from '../../src/serve/runtime/diagnostics-report.js';
import type { SandboxSession } from '../../src/serve/sandbox-session.js';
import { attachViteGenerationMiddleware } from '../../src/serve/vite-generation-middleware.js';
import { MockRes, type PyricMiddleware, type PyricReq } from './vite-plugin-harness.js';

interface Answer {
  readonly statusCode: number;
  readonly body: string;
  readonly nexted: boolean;
}

/** A Vite server stub whose Connect stack records the last middleware attached to it. */
function viteServer(): { server: ViteDevServer; last: () => PyricMiddleware | undefined } {
  let attached: PyricMiddleware | undefined;
  const server = {
    config: { server: { allowedHosts: [], host: 'localhost' } },
    middlewares: { use(_route: string, middleware: PyricMiddleware) { attached = middleware; } },
  } as unknown as ViteDevServer;
  return { server, last: () => attached };
}

function attach(
  hasBridge: boolean,
  onto: ReturnType<typeof viteServer> = viteServer(),
): { handler: PyricMiddleware; dispose: () => void } {
  const { server } = onto;
  const bridge = {
    handler(_req: IncomingMessage, res: ServerResponse) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"mode":"sandbox"}');
      return true;
    },
  } as unknown as BridgeMount;
  const session = { handle: async () => false } as unknown as SandboxSession;
  const dispose = attachViteGenerationMiddleware({ server, bridge: hasBridge ? bridge : null, session });
  const handler = onto.last();
  if (handler === undefined) throw new Error('no /__pyric middleware was attached');
  return { handler, dispose };
}

function call(handler: PyricMiddleware, path: string): Promise<Answer> {
  const response = new MockRes();
  return new Promise((resolve) => {
    response.on('finish', () => resolve({ statusCode: response.statusCode, body: response.body, nexted: false }));
    handler(
      { method: 'GET', url: path.replace('/__pyric', ''), originalUrl: path, headers: { host: 'localhost' } },
      response,
      () => resolve({ statusCode: 0, body: '', nexted: true }),
    );
  });
}

describe('a closed Vite generation', () => {
  it('answers /__pyric/health with 503 when it had a bridge', async () => {
    const { handler, dispose } = attach(true);
    dispose();
    const answer = await call(handler, '/__pyric/health');
    expect(answer.nexted).toBe(false);
    expect(answer.statusCode).toBe(503);
    expect(JSON.parse(answer.body)).toEqual({ error: 'pyric bridge: mount is closed' });
  });

  it('answers /__pyric/health with a query string the same way', async () => {
    const { handler, dispose } = attach(true);
    dispose();
    expect((await call(handler, '/__pyric/health?probe=1')).statusCode).toBe(503);
  });

  it('passes every other route through to the next generation', async () => {
    const { handler, dispose } = attach(true);
    dispose();
    expect((await call(handler, '/__pyric/init.json')).nexted).toBe(true);
  });

  it('passes /__pyric/health through when it had no bridge', async () => {
    const { handler, dispose } = attach(false);
    dispose();
    expect((await call(handler, '/__pyric/health')).nexted).toBe(true);
  });

  it('passes /__pyric/health through to a live generation on the same stack', async () => {
    const stack = viteServer();
    const first = attach(true, stack);
    first.dispose();
    attach(true, stack);
    expect((await call(first.handler, '/__pyric/health')).nexted).toBe(true);
  });

  it('answers /__pyric/health with 503 again once the later generation on the stack closes too', async () => {
    const stack = viteServer();
    const first = attach(true, stack);
    first.dispose();
    const second = attach(true, stack);
    second.dispose();
    second.dispose();
    expect((await call(first.handler, '/__pyric/health')).statusCode).toBe(503);
  });

  it('answers /__pyric/health from the mount while it is active', async () => {
    const { handler } = attach(true);
    const answer = await call(handler, '/__pyric/health');
    expect(answer.statusCode).toBe(200);
  });

  it('refuses non-loopback Host on /__pyric/* even when Vite server.allowedHosts is true', async () => {
    const stack = viteServer();
    (stack.server.config.server as { allowedHosts: string[] | true }).allowedHosts = true;
    const { handler } = attach(true, stack);
    const response = new MockRes();
    const answer = await new Promise<Answer>((resolve) => {
      response.on('finish', () => resolve({ statusCode: response.statusCode, body: response.body, nexted: false }));
      handler(
        { method: 'GET', url: '/init.json', originalUrl: '/__pyric/init.json', headers: { host: 'evil.example:5173' } },
        response,
        () => resolve({ statusCode: 0, body: '', nexted: true }),
      );
    });
    expect(answer.statusCode).toBe(403);
    expect(answer.nexted).toBe(false);
  });

  it('keeps answering POST /__pyric/diagnostics with 204 while no replacement generation is live (#2098)', async () => {
    const stack = viteServer();
    const diagnostics = createDiagnostics(() => 'hosted');
    const session = {
      async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
        if (url.pathname !== DIAGNOSTICS_PATH) return false;
        const decision = evaluateNamespaceSurface(
          req,
          { boundHost: 'localhost', sessionToken: 'tok-1', requireSessionToken: false },
          'namespace',
          url,
        );
        if (!decision.ok) {
          writeGuardRejection(res, decision, { nextPath: url.pathname });
          return true;
        }
        await diagnostics(req, res);
        return true;
      },
    } as unknown as SandboxSession;
    const dispose = attachViteGenerationMiddleware({ server: stack.server, bridge: null, session });
    const handler = stack.last();
    if (handler === undefined) throw new Error('no /__pyric middleware was attached');
    dispose();

    const validBody = JSON.stringify({
      version: 1,
      clientId: 'tab-1',
      sequence: 1,
      realm: 'page',
      pageOrigin: 'http://localhost:5173',
      events: [{ at: 1, phase: 'socket-close', connectionId: 'c1', endpoint: 'ws://localhost:5173/__pyric/sandbox', code: 1006 }],
    });
    const postAnswer = await callDiagnostics(handler, { method: 'POST', body: validBody });
    expect(postAnswer.nexted).toBe(false);
    expect(postAnswer.statusCode).toBe(204);

    // Rebound Host and cross-origin browser requests remain blocked (#3130/#3147).
    const reboundAnswer = await callDiagnostics(handler, {
      method: 'POST',
      host: 'evil.example:5173',
      body: validBody,
    });
    expect(reboundAnswer.statusCode).toBe(403);

    const crossOriginAnswer = await callDiagnostics(handler, {
      method: 'POST',
      headers: { origin: 'http://localhost:9999' },
      body: validBody,
    });
    expect(crossOriginAnswer.statusCode).toBe(403);

    // Oversized body (> 16 KiB) still rejects with 413.
    const hugeAnswer = await callDiagnostics(handler, {
      method: 'POST',
      body: JSON.stringify({ payload: 'x'.repeat(20_000) }),
    });
    expect(hugeAnswer.statusCode).toBe(413);

    // Once a replacement generation attaches on the same stack, the closed one yields.
    attach(true, stack);
    const yielded = await callDiagnostics(handler, { method: 'POST', body: validBody });
    expect(yielded.nexted).toBe(true);
  });
});

function callDiagnostics(
  handler: PyricMiddleware,
  opts: { method: string; host?: string; headers?: Record<string, string>; body?: string },
): Promise<Answer> {
  const response = new MockRes();
  const stream = Readable.from(opts.body ? [Buffer.from(opts.body, 'utf8')] : []);
  const req = Object.assign(stream, {
    method: opts.method,
    url: '/diagnostics',
    originalUrl: DIAGNOSTICS_PATH,
    headers: {
      host: opts.host ?? 'localhost:5173',
      'content-type': 'application/json',
      ...(opts.headers ?? {}),
    },
    socket: { remoteAddress: '127.0.0.1', localPort: 5173, end() {}, destroy() {} },
  }) as unknown as PyricReq;
  return new Promise((resolve) => {
    response.on('finish', () => resolve({ statusCode: response.statusCode, body: response.body, nexted: false }));
    handler(req, response, () => resolve({ statusCode: 0, body: '', nexted: true }));
  });
}
