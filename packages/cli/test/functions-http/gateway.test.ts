import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, request, type Server } from 'node:http';
import { join } from 'node:path';
import { startHttpChildServer } from '../../src/functions/http/child-server.js';
import type { DiscoveredOnRequest } from '../../src/functions/http/discovery.js';
import type { AddressInfo } from 'node:net';
import { createFunctionsHttpGateway, type FunctionsHttpGateway } from '../../src/functions/http/gateway.js';
import { FUNCTION_TARGET_HEADER } from '../../src/functions/http/child-server.js';

const servers: Server[] = [];

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }));
}

/** A plane: the gateway first, then a static fallback that answers 404. */
async function plane(gateway: FunctionsHttpGateway): Promise<string> {
  return listen(createServer((req, res) => {
    void gateway.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end('static');
    });
  }));
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('functions HTTP gateway', () => {
  test('answers 503 naming the cause while functions cannot serve', async () => {
    const gateway = createFunctionsHttpGateway({
      projectId: 'demo-app',
      initial: { kind: 'waiting-peer', serveUrl: 'http://localhost:3473' },
    });
    const base = await plane(gateway);
    const read = async () => {
      const response = await fetch(`${base}/demo-app/us-central1/api`);
      return [response.status, await response.text()];
    };
    expect(await read()).toEqual([503, 'Functions are not running yet: no browser tab is connected to pyric sandbox. Open http://localhost:3473 to start them.']);
    gateway.update({ kind: 'starting' });
    expect(await read()).toEqual([503, 'Functions are starting. Retry in a moment.']);
    gateway.update({ kind: 'reloading' });
    expect(await read()).toEqual([503, 'Functions are reloading after a source change. Retry in a moment.']);
    gateway.update({ kind: 'failed', message: 'SyntaxError in index.js' });
    expect(await read()).toEqual([503, 'Functions failed to start: SyntaxError in index.js']);
    gateway.update({ kind: 'unresponsive' });
    expect(await read()).toEqual([503, 'The Functions child is unresponsive: a handler may be stuck in a synchronous loop. pyric is restarting it; retry in a moment.']);
    gateway.update({ kind: 'exited', code: 1 });
    expect(await read()).toEqual([503, 'The Functions child exited (code 1). Save a Functions source file or restart pyric to start it again.']);
    // A path that is not a function route is never claimed, whatever the state.
    expect((await fetch(`${base}/index.html`)).status).toBe(404);
  });

  test('forwards a served function to the child with its body and streams the answer back', async () => {
    const seen: Array<{ url: string | undefined; target: unknown; body: string }> = [];
    const child = await listen(createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        seen.push({ url: req.url, target: req.headers[FUNCTION_TARGET_HEADER], body });
        res.writeHead(201, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] });
        res.write('one,');
        res.end('two');
      });
    }));
    const port = Number(new URL(child).port);
    const gateway = createFunctionsHttpGateway({ projectId: 'demo-app', initial: { kind: 'starting' } });
    gateway.update({
      kind: 'ready',
      http: { port, functions: [{ exportName: 'api', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: null }] },
    });
    const base = await plane(gateway);
    const response = await fetch(`${base}/demo-app/us-central1/api/items?x=1`, { method: 'POST', body: 'payload' });
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await response.text()).toBe('one,two');
    expect(seen).toEqual([{ url: '/items?x=1', target: 'api', body: 'payload' }]);

    // Only discovered names are function routes; anything else is the plane's (the plan's collision rule).
    const missing = await fetch(`${base}/demo-app/us-central1/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('static');
  });

  test('the function sees the proxy hop, not what the client claims about it', async () => {
    const report: DiscoveredOnRequest = {
      exportName: 'whoami',
      regions: ['us-central1'],
      platform: 'gcfv2',
      privateInvoker: false,
      timeoutSeconds: null,
      handler: ((req: { ip: string; hostname: string; protocol: string; headers: Record<string, unknown> }, res: { json(value: unknown): void }) => {
        res.json({ ip: req.ip, hostname: req.hostname, protocol: req.protocol, forwardedFor: req.headers['x-forwarded-for'], secret: req.headers['x-secret'] ?? null });
      }) as DiscoveredOnRequest['handler'],
    };
    const child = await startHttpChildServer(join(import.meta.dir, '../../../conformance/package.json'), [report]);
    const gateway = createFunctionsHttpGateway({ projectId: 'demo-app', initial: { kind: 'starting' } });
    gateway.update({ kind: 'ready', http: { port: child.port, functions: [report] } });
    const base = new URL(await plane(gateway));
    try {
      const seen = await new Promise<Record<string, unknown>>((resolveSeen, rejectSeen) => {
        const outgoing = request({
          host: base.hostname,
          port: base.port,
          path: '/demo-app/us-central1/whoami',
          headers: {
            'x-forwarded-for': '6.6.6.6',
            'x-forwarded-host': 'evil.example',
            'x-forwarded-proto': 'https',
            connection: 'x-secret',
            'x-secret': 'hop-only',
          },
        }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => resolveSeen(JSON.parse(body) as Record<string, unknown>));
        });
        outgoing.on('error', rejectSeen);
        outgoing.end();
      });
      expect(seen).toEqual({
        ip: '127.0.0.1',
        hostname: '127.0.0.1',
        protocol: 'http',
        forwardedFor: '6.6.6.6, 127.0.0.1',
        secret: null,
      });
    } finally {
      await child.close();
    }
  });
});
