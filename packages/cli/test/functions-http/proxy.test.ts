import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FUNCTION_TARGET_HEADER } from '../../src/functions/http/child-server.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import { proxyToChild, type ProxyOutcome } from '../../src/functions/http/proxy.js';

const TOKEN = 'proxy-test-token';
const servers: Server[] = [];

function listen(server: Server): Promise<{ port: number; url: string }> {
  servers.push(server);
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolveListen({ port: address.port, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

afterEach(async () => {
  const active = servers.splice(0);
  await Promise.all(
    active.map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        }),
    ),
  );
});

describe('proxyToChild', () => {
  test('serves consecutive POSTs cleanly when the upstream handler ends before draining the request body', async () => {
    const seenTargets: string[] = [];
    const child = await listen(
      createServer((req, res) => {
        seenTargets.push(String(req.headers[FUNCTION_TARGET_HEADER]));
        expect(req.headers[CHILD_TOKEN_HEADER]).toBe(TOKEN);
        // Respond immediately without reading req body bytes.
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('answered-early');
      }),
    );

    const outcomes: ProxyOutcome[] = [];
    const gateway = await listen(
      createServer((req, res) => {
        void proxyToChild(req, res, {
          port: child.port,
          token: TOKEN,
          exportName: 'earlyHandler',
          forwardUrl: req.url ?? '/',
          timeoutMs: 5_000,
          timeoutMessage: 'timed out',
        }).then((outcome) => {
          outcomes.push(outcome);
        });
      }),
    );

    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${gateway.url}/items/${index}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: `unread-payload-${index}`,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('answered-early');
    }

    expect(seenTargets).toEqual([
      'earlyHandler',
      'earlyHandler',
      'earlyHandler',
      'earlyHandler',
      'earlyHandler',
    ]);
    expect(outcomes).toEqual([
      { status: 200, timedOut: false },
      { status: 200, timedOut: false },
      { status: 200, timedOut: false },
      { status: 200, timedOut: false },
      { status: 200, timedOut: false },
    ]);
  });
});
