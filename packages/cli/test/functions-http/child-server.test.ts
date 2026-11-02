import { describe, expect, test } from 'bun:test';
import { request } from 'node:http';
import { join } from 'node:path';
import { startHttpChildServer } from '../../src/functions/http/child-server.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import type { DiscoveredOnRequest } from '../../src/functions/http/discovery.js';

/** Any file inside the conformance package resolves its firebase-functions, and through it express. */
const ENTRY = join(import.meta.dir, '../../../conformance/package.json');

type Res = { end(body: string): void };

function fn(exportName: string, handler: (req: unknown, res: Res) => void): DiscoveredOnRequest {
  return {
    exportName,
    regions: ['us-central1'],
    platform: 'gcfv2',
    privateInvoker: false,
    timeoutSeconds: null,
    handler: handler as DiscoveredOnRequest['handler'],
  };
}

const TOKEN = 'spawn-token';

const call = (port: number, name: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-pyric-function-target': name, [CHILD_TOKEN_HEADER]: TOKEN } });

/** A raw request, so the test can send any Host header, as a rebinding page's browser would. */
function rawCall(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolveCall, rejectCall) => {
    const outgoing = request({ host: '127.0.0.1', port, path: '/', method: 'POST', headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolveCall({ status: response.statusCode ?? 0, body }));
    });
    outgoing.on('error', rejectCall);
    outgoing.end('{}');
  });
}

describe('the child HTTP server', () => {
  test('close lets an in-flight request finish (a reload must not cut it)', async () => {
    const server = await startHttpChildServer(ENTRY, [
      fn('slow', (_req, res) => { setTimeout(() => res.end('done'), 300); }),
    ], { token: TOKEN });
    const inFlight = call(server.port, 'slow');
    await Bun.sleep(50);
    const closed = server.close();
    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('done');
    await closed;
  });

  test('close force-closes a request still open after the drain deadline', async () => {
    const server = await startHttpChildServer(ENTRY, [fn('hang', () => undefined)], { token: TOKEN, drainMs: 200 });
    const inFlight = call(server.port, 'hang').then(() => 'answered', () => 'closed');
    await Bun.sleep(50);
    const startedAt = Date.now();
    await server.close();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await inFlight).toBe('closed');
  });

  test('a request without the spawn token gets 403 and runs nothing, whatever Host and target it names', async () => {
    let ran = 0;
    const server = await startHttpChildServer(ENTRY, [
      fn('pyricHttpPrivate', (_req, res) => { ran += 1; res.end('ran'); }),
    ], { token: TOKEN });
    try {
      const forged = { 'x-pyric-function-target': 'pyricHttpPrivate', 'content-type': 'application/json' };
      const rebound = await rawCall(server.port, { ...forged, host: 'attacker.example' });
      expect(rebound.status).toBe(403);
      const local = await rawCall(server.port, forged);
      expect(local.status).toBe(403);
      const wrong = await rawCall(server.port, { ...forged, host: 'attacker.example', [CHILD_TOKEN_HEADER]: 'guess' });
      expect(wrong.status).toBe(403);
      const tooLong = await rawCall(server.port, { ...forged, [CHILD_TOKEN_HEADER]: `${TOKEN}x` });
      expect(tooLong.status).toBe(403);
      expect(ran).toBe(0);
      const proxied = await rawCall(server.port, { ...forged, [CHILD_TOKEN_HEADER]: TOKEN });
      expect(proxied).toEqual({ status: 200, body: 'ran' });
      expect(ran).toBe(1);
    } finally {
      await server.close();
    }
  });

  test('the function never sees the token or target header, in headers or rawHeaders', async () => {
    type Seen = { headers: Record<string, unknown>; rawHeaders: string[] };
    const server = await startHttpChildServer(ENTRY, [
      fn('headers', (req, res) => {
        const { headers, rawHeaders } = req as Seen;
        res.end(JSON.stringify({ headers, rawHeaders }));
      }),
    ], { token: TOKEN });
    try {
      const response = await call(server.port, 'headers');
      const { headers, rawHeaders } = (await response.json()) as Seen;
      expect(headers[CHILD_TOKEN_HEADER]).toBeUndefined();
      expect(headers['x-pyric-function-target']).toBeUndefined();
      const rawNames = rawHeaders.filter((_, at) => at % 2 === 0).map((name) => name.toLowerCase());
      expect(rawNames).not.toContain(CHILD_TOKEN_HEADER);
      expect(rawNames).not.toContain('x-pyric-function-target');
      expect(rawHeaders).not.toContain(TOKEN);
      expect(rawNames).toContain('host');
    } finally {
      await server.close();
    }
  });
});
