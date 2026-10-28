import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, get, request, type Server } from 'node:http';
import { join } from 'node:path';
import { startHttpChildServer } from '../../src/functions/http/child-server.js';
import type { DiscoveredOnRequest } from '../../src/functions/http/discovery.js';
import type { AddressInfo } from 'node:net';
import {
  createFunctionsHttpGateway,
  requestTimeoutSeconds,
  type FunctionsHttpGateway,
  type FunctionsHttpRecord,
} from '../../src/functions/http/gateway.js';
import type { HttpFunctionInfo } from '../../src/functions/http/discovery.js';
import { servedLine } from '../../src/functions/http/report.js';
import { hostingRewrites } from '../../src/functions/http/rewrites.js';
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

  test('a hosting rewrite forwards the full URL, only __session, and the forwarding headers, unless a file answers', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const child = await listen(createServer((req, res) => {
      seen.push({ url: req.url, cookie: req.headers.cookie, host: req.headers['x-forwarded-host'], original: req.headers['x-original-url'] });
      res.end('ok');
    }));
    const records: FunctionsHttpRecord[] = [];
    const gateway = createFunctionsHttpGateway({
      projectId: 'demo-app',
      initial: { kind: 'starting' },
      rewrites: hostingRewrites({ hosting: { rewrites: [{ source: '/api/**', function: 'api' }, { source: '/east/**', function: { functionId: 'api', region: 'us-east1' } }] } }),
      staticFileExists: (pathname) => pathname === '/api/static.txt',
      onServed: (record) => records.push(record),
    });
    const base = await plane(gateway);
    expect((await fetch(`${base}/api/before`)).status).toBe(503);
    gateway.update({
      kind: 'ready',
      http: { port: Number(new URL(child).port), functions: [{ exportName: 'api', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: null }] },
    });
    const response = await fetch(`${base}/api/items/42?x=1`, { headers: { cookie: 'other=1; __session=s1' } });
    expect(await response.text()).toBe('ok');
    expect(seen).toEqual([{ url: '/api/items/42?x=1', cookie: '__session=s1', host: new URL(base).host, original: '/api/items/42?x=1' }]);
    expect((await fetch(`${base}/api/static.txt`)).status).toBe(404); // the plane's static fallback answered
    const wrongRegion = await fetch(`${base}/east/x`);
    expect(wrongRegion.status).toBe(404);
    expect(await wrongRegion.text()).toBe('Function us-east1-api named by a hosting rewrite does not exist, valid functions are: us-central1-api');
    expect(records.map(({ exportName, method, path, status, timedOut }) => ({ exportName, method, path, status, timedOut }))).toEqual([
      { exportName: 'api', method: 'GET', path: '/api/items/42?x=1', status: 200, timedOut: false },
    ]);
  });

  test('a function that does not answer within timeoutSeconds gets 504, or a closed connection once headers are out', async () => {
    const child = await listen(createServer((req, res) => {
      if (req.url === '/partial') {
        res.writeHead(200);
        res.write('partial');
      }
    }));
    const records: FunctionsHttpRecord[] = [];
    const gateway = createFunctionsHttpGateway({ projectId: 'demo-app', initial: { kind: 'starting' }, onServed: (record) => records.push(record) });
    gateway.update({
      kind: 'ready',
      http: { port: Number(new URL(child).port), functions: [{ exportName: 'slow', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: 1 }] },
    });
    const base = await plane(gateway);
    const startedAt = Date.now();
    const cut = await fetch(`${base}/demo-app/us-central1/slow`);
    expect(cut.status).toBe(504);
    expect(await cut.text()).toBe('pyric: slow did not respond within its timeout (1 s).');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
    // One request on its own connection (fetch would retry a GET whose socket resets).
    const partial = await new Promise<{ status: number | undefined; body: string; aborted: boolean }>((resolvePartial) => {
      get(`${base}/demo-app/us-central1/slow/partial`, { agent: false }, (response) => {
        let body = '';
        let aborted = false;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('aborted', () => { aborted = true; });
        response.on('close', () => resolvePartial({ status: response.statusCode, body, aborted }));
      });
    });
    expect(partial.status).toBe(200);
    expect(partial.body.startsWith('partial')).toBe(true);
    expect(partial.aborted).toBe(true);
    await Bun.sleep(50);
    expect(records.map(({ status, timedOut }) => ({ status, timedOut }))).toEqual([
      { status: 504, timedOut: true },
      { status: null, timedOut: true },
    ]);
  }, 10_000);

  test('a rewrite without a region finds the function where its source deploys it, and refuses an ambiguous one', async () => {
    const seen: string[] = [];
    const child = await listen(createServer((req, res) => {
      seen.push(String(req.headers[FUNCTION_TARGET_HEADER]));
      res.end('ok');
    }));
    const warnings: string[] = [];
    const gateway = createFunctionsHttpGateway({
      projectId: 'demo-app',
      initial: { kind: 'starting' },
      rewrites: hostingRewrites({
        hosting: {
          rewrites: [
            { source: '/eu/**', function: 'eu' },
            { source: '/both/**', function: 'both' },
            { source: '/far/**', function: 'far' },
            { source: '/none/**', function: 'none' },
          ],
        },
      }),
      onWarning: (warning) => warnings.push(warning),
    });
    const info = (exportName: string, regions: string[]): HttpFunctionInfo => ({
      exportName, regions, platform: 'gcfv2', privateInvoker: false, timeoutSeconds: null,
    });
    gateway.update({
      kind: 'ready',
      http: {
        port: Number(new URL(child).port),
        functions: [
          info('eu', ['europe-west1']),
          info('both', ['europe-west1', 'us-central1']),
          info('far', ['asia-east1', 'europe-west1']),
        ],
      },
    });
    const base = await plane(gateway);
    // onRequest({ region: 'europe-west1' }, h) behind a rewrite that names no region: production serves it.
    expect((await fetch(`${base}/eu/x`)).status).toBe(200);
    expect((await fetch(`${base}/both/x`)).status).toBe(200);
    expect(warnings).toEqual([]);
    // Several regions, none us-central1: firebase-tools 15.23.0 refuses the rewrite
    // (`lib/deploy/hosting/convertConfig.js:48-56`), so pyric does too.
    const ambiguousMessage =
      'More than one backend found for function name: far. If the function is deployed in multiple regions, you must specify a region.';
    for (const path of ['/far/x', '/far/y']) {
      const ambiguous = await fetch(`${base}${path}`);
      expect(ambiguous.status).toBe(404);
      expect(await ambiguous.text()).toBe(ambiguousMessage);
    }
    expect(warnings).toEqual([`firebase.json hosting rewrite: ${ambiguousMessage}`]);
    const missing = await fetch(`${base}/none/x`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(
      'Function none named by a hosting rewrite does not exist, valid functions are: europe-west1-eu, europe-west1-both, us-central1-both, asia-east1-far, europe-west1-far',
    );
    expect(seen).toEqual(['eu', 'both']);
  });

  test('the gateway cuts a rewritten request at the Hosting cap, and the emulator path runs to the function timeout', async () => {
    const child = await listen(createServer((_req, res) => {
      setTimeout(() => res.end('late'), 600);
    }));
    const gateway = createFunctionsHttpGateway({
      projectId: 'demo-app',
      initial: { kind: 'starting' },
      rewrites: hostingRewrites({ hosting: { rewrites: [{ source: '/api/**', function: 'api' }] } }),
      // A short stand-in for Hosting's 60 s, so the test runs in under a second.
      hostingRewriteTimeoutSeconds: 0.2,
    });
    gateway.update({
      kind: 'ready',
      http: { port: Number(new URL(child).port), functions: [{ exportName: 'api', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: 5 }] },
    });
    const base = await plane(gateway);
    const [rewritten, direct] = await Promise.all([fetch(`${base}/api/slow`), fetch(`${base}/demo-app/us-central1/api/slow`)]);
    expect(rewritten.status).toBe(504);
    expect(await rewritten.text()).toBe("pyric: api did not respond within Hosting's 0.2 s limit for a rewritten request.");
    expect(direct.status).toBe(200);
    expect(await direct.text()).toBe('late');
  });

  test('a rewritten request is cut at Hosting\'s 60 s, and the emulator path keeps the function\'s own timeout', () => {
    const fn = (timeoutSeconds: number | null): HttpFunctionInfo => ({
      exportName: 'api', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds,
    });
    expect(requestTimeoutSeconds(fn(null), { viaRewrite: false })).toBe(60);
    expect(requestTimeoutSeconds(fn(300), { viaRewrite: false })).toBe(300);
    expect(requestTimeoutSeconds(fn(5), { viaRewrite: false })).toBe(5);
    expect(requestTimeoutSeconds(fn(null), { viaRewrite: true })).toBe(60);
    expect(requestTimeoutSeconds(fn(300), { viaRewrite: true })).toBe(60);
    expect(requestTimeoutSeconds(fn(5), { viaRewrite: true })).toBe(5);
    // Clamped so the timer cannot overflow setTimeout's 32-bit delay.
    expect(requestTimeoutSeconds(fn(10_000_000), { viaRewrite: false })).toBe(3600);
  });

  test('the request log line names the path without its query string', () => {
    const { line } = servedLine({
      exportName: 'api', method: 'GET', path: '/api/items?token=secret&x=1', status: 200, timedOut: false, durationMs: 3,
    });
    expect(line).toBe('function  api ← GET /api/items 200 (3 ms)');
  });
});
