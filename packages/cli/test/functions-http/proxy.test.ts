import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FUNCTION_TARGET_HEADER } from '../../src/functions/http/child-server.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import { createFunctionsHttpGateway } from '../../src/functions/http/gateway.js';
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

  test('propagates x-forwarded-proto only from trusted proxy peers', async () => {
    const seenProto: string[] = [];
    const child = await listen(
      createServer((req, res) => {
        seenProto.push(String(req.headers['x-forwarded-proto'] ?? ''));
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ok');
      }),
    );

    const untrustedGateway = await listen(
      createServer((req, res) => {
        void proxyToChild(req, res, {
          port: child.port,
          token: TOKEN,
          exportName: 'protoHandler',
          forwardUrl: req.url ?? '/',
          timeoutMs: 5_000,
          timeoutMessage: 'timed out',
        });
      }),
    );

    const trustedGateway = await listen(
      createServer((req, res) => {
        void proxyToChild(req, res, {
          port: child.port,
          token: TOKEN,
          exportName: 'protoHandler',
          forwardUrl: req.url ?? '/',
          timeoutMs: 5_000,
          timeoutMessage: 'timed out',
          trustProxy: 'loopback',
        });
      }),
    );

    const untrustedRes = await fetch(`${untrustedGateway.url}/check`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(untrustedRes.status).toBe(200);

    const trustedHttpsRes = await fetch(`${trustedGateway.url}/check`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(trustedHttpsRes.status).toBe(200);

    const spoofedChainRes = await fetch(`${trustedGateway.url}/check`, {
      headers: { 'x-forwarded-proto': 'https, http' },
    });
    expect(spoofedChainRes.status).toBe(200);

    const markedRemoteRes = await fetch(`${trustedGateway.url}/check`, {
      headers: { 'x-forwarded-proto': 'https', 'x-pyric-remote-peer': '1' },
    });
    expect(markedRemoteRes.status).toBe(200);

    expect(seenProto).toEqual(['http', 'https', 'http', 'http']);
  });

  test('streams multi-megabyte bodies, cuts oversized chunked streams with 413, and closes incomplete early-response sockets (#3214)', async () => {
    const child = await listen(
      createServer((req, res) => {
        if (req.url === '/early') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
          res.end('early');
          return;
        }
        let received = 0;
        req.on('data', (chunk: Buffer) => {
          received += chunk.byteLength;
        });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`bytes:${received}`);
        });
      }),
    );

    const limitBytes = 4 * 1024 * 1024;
    const gateway = await listen(
      createServer((req, res) => {
        const cap = req.url === '/capped' ? limitBytes : 16 * 1024 * 1024;
        void proxyToChild(req, res, {
          port: child.port,
          token: TOKEN,
          exportName: 'uploadHandler',
          forwardUrl: req.url ?? '/',
          timeoutMs: 10_000,
          timeoutMessage: 'timed out',
          maxBodyBytes: cap,
        });
      }),
    );

    const sixMb = new Uint8Array(6 * 1024 * 1024);
    for (let round = 0; round < 5; round += 1) {
      let remaining = limitBytes + 1;
      const unit = new Uint8Array(512 * 1024);
      const chunkedInit: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (remaining <= 0) {
              controller.close();
              return;
            }
            const count = Math.min(remaining, unit.byteLength);
            remaining -= count;
            if (count === unit.byteLength) {
              controller.enqueue(unit);
            } else {
              controller.enqueue(unit.subarray(0, count));
            }
          },
        }),
        duplex: 'half',
      };
      const refused = await fetch(`${gateway.url}/capped`, chunkedInit);
      expect(refused.status).toBe(413);
      await refused.text();

      const accepted = await fetch(`${gateway.url}/items/${round}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: sixMb,
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toBe(`bytes:${sixMb.byteLength}`);

      const early = await fetch(`${gateway.url}/early`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: sixMb,
      });
      expect(early.status).toBe(200);
      expect(await early.text()).toBe('early');
    }
  }, 20_000);

  test('preserves an unread POST body across a deferred ECONNREFUSED retry and keeps node-http transport parity (#3214)', async () => {
    const dead = await listen(createServer());
    const deadPort = dead.port;
    await new Promise<void>((resolveClose) => {
      servers.pop()?.close(() => resolveClose());
    });

    const receivedBodies: string[] = [];
    const replacement = await listen(
      createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          body += chunk;
        });
        req.on('end', () => {
          receivedBodies.push(body);
          res.writeHead(201, { 'set-cookie': ['s1=1', 's2=2'] });
          res.end(`echo:${body}`);
        });
      }),
    );

    const retryGateway = await listen(
      createServer(async (req, res) => {
        const first = await proxyToChild(req, res, {
          port: deadPort,
          token: TOKEN,
          exportName: 'retryHandler',
          forwardUrl: req.url ?? '/',
          timeoutMs: 5_000,
          timeoutMessage: 'timed out',
          deferConnectRefused: true,
        });
        expect(first).toEqual({ status: null, timedOut: false, connectRefused: true });
        await proxyToChild(req, res, {
          port: replacement.port,
          token: TOKEN,
          exportName: 'retryHandler',
          forwardUrl: req.url ?? '/',
          timeoutMs: 5_000,
          timeoutMessage: 'timed out',
          deferConnectRefused: false,
        });
      }),
    );

    const retried = await fetch(`${retryGateway.url}/items/1`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'preserved-across-refusal',
    });
    expect(retried.status).toBe(201);
    expect(retried.headers.getSetCookie()).toEqual(['s1=1', 's2=2']);
    expect(await retried.text()).toBe('echo:preserved-across-refusal');

    const nodeHttpGateway = await listen(
      createServer((req, res) => {
        void proxyToChild(req, res, {
          port: replacement.port,
          token: TOKEN,
          exportName: 'retryHandler',
          forwardUrl: req.url ?? '/',
          timeoutMs: 5_000,
          timeoutMessage: 'timed out',
          upstreamTransport: 'node-http',
        });
      }),
    );

    const viaNodeHttp = await fetch(`${nodeHttpGateway.url}/items/2`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'node-http-branch',
    });
    expect(viaNodeHttp.status).toBe(201);
    expect(viaNodeHttp.headers.getSetCookie()).toEqual(['s1=1', 's2=2']);
    expect(await viaNodeHttp.text()).toBe('echo:node-http-branch');
    expect(receivedBodies).toEqual(['preserved-across-refusal', 'node-http-branch']);
  });

  test('closes gateway and child listeners promptly after single-packet and restarting-gateway POSTs (#3214)', async () => {
    const seenBodies: string[] = [];
    const childServer = createServer((req, res) => {
      if (req.url === '/early') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('early-ok');
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        seenBodies.push(body);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`got:${body}`);
      });
    });
    const child = await listen(childServer);

    let releaseRestart: (() => void) | null = null;
    const restartReady = new Promise<void>((resolveReady) => {
      releaseRestart = resolveReady;
    });

    const gateway = createFunctionsHttpGateway({
      projectId: 'demo-app',
      initial: { kind: 'restarting', code: 1, ready: restartReady },
      plane: 'pyric-sandbox',
    });

    const gatewayServer = createServer((req, res) => {
      void gateway.handle(req, res, () => true);
    });
    const gatewayAddr = await listen(gatewayServer);

    const sendSinglePacketPost = (path: string, payload: string): Promise<{ status: number; body: string }> =>
      new Promise((resolveCall, rejectCall) => {
        const outgoing = httpRequest(
          {
            host: '127.0.0.1',
            port: gatewayAddr.port,
            path,
            method: 'POST',
            headers: {
              'content-type': 'text/plain',
              'content-length': String(Buffer.byteLength(payload)),
              connection: 'close',
            },
          },
          (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              text += chunk;
            });
            response.on('end', () => {
              resolveCall({ status: response.statusCode ?? 0, body: text });
            });
          },
        );
        outgoing.on('error', rejectCall);
        outgoing.end(payload);
      });

    const pendingDuringRestart = sendSinglePacketPost('/demo-app/us-central1/api/echo', 'held-across-restart');
    setTimeout(() => {
      gateway.update({
        kind: 'ready',
        http: {
          port: child.port,
          token: TOKEN,
          functions: [
            {
              exportName: 'api',
              regions: ['us-central1'],
              platform: 'gcfv2',
              privateInvoker: false,
              timeoutSeconds: null,
            },
          ],
        },
      });
      releaseRestart?.();
    }, 20);

    expect(await pendingDuringRestart).toEqual({ status: 200, body: 'got:held-across-restart' });
    expect(await sendSinglePacketPost('/demo-app/us-central1/api/early', 'unread-single-packet')).toEqual({
      status: 200,
      body: 'early-ok',
    });
    expect(seenBodies).toEqual(['held-across-restart']);

    servers.length = 0;
    const closeWithinBudget = (server: Server): Promise<number> => {
      const started = performance.now();
      return new Promise((resolveClose, rejectClose) => {
        const timer = setTimeout(() => {
          rejectClose(new Error('server.close() exceeded 500ms budget'));
        }, 500);
        timer.unref();
        server.close((err) => {
          clearTimeout(timer);
          if (err) rejectClose(err);
          else resolveClose(performance.now() - started);
        });
      });
    };

    const [gatewayCloseMs, childCloseMs] = await Promise.all([
      closeWithinBudget(gatewayServer),
      closeWithinBudget(childServer),
    ]);
    expect(gatewayCloseMs).toBeLessThan(500);
    expect(childCloseMs).toBeLessThan(500);
  });
});
