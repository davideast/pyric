/**
 * #1568 review: while a hosted Vite server restarts, the new plugin instance
 * closes the old generation before it builds its own, and the old generation's
 * middleware goes inactive. Its `/__pyric/health` must keep answering 503, as
 * a closed bridge mount does, so `pyric run --wait` keeps waiting for the
 * replacement. Falling through to Vite's 404 reads as "not a sandbox host".
 */
import { describe, expect, it } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import type { BridgeMount } from '../../src/serve/bridge-mount.js';
import type { SandboxSession } from '../../src/serve/sandbox-session.js';
import { attachViteGenerationMiddleware } from '../../src/serve/vite-generation-middleware.js';
import { MockRes, type PyricMiddleware } from './vite-plugin-harness.js';

interface Answer {
  readonly statusCode: number;
  readonly body: string;
  readonly nexted: boolean;
}

function attach(hasBridge: boolean): { handler: PyricMiddleware; dispose: () => void } {
  let handler: PyricMiddleware | undefined;
  const server = {
    config: { server: { allowedHosts: [], host: 'localhost' } },
    middlewares: { use(_route: string, middleware: PyricMiddleware) { handler = middleware; } },
  } as unknown as ViteDevServer;
  const bridge = {
    handler(_req: IncomingMessage, res: ServerResponse) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"mode":"sandbox"}');
      return true;
    },
  } as unknown as BridgeMount;
  const session = { handle: async () => false } as unknown as SandboxSession;
  const dispose = attachViteGenerationMiddleware({ server, bridge: hasBridge ? bridge : null, session });
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

  it('answers /__pyric/health from the mount while it is active', async () => {
    const { handler } = attach(true);
    const answer = await call(handler, '/__pyric/health');
    expect(answer.statusCode).toBe(200);
  });
});
