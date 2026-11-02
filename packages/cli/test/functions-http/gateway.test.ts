import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, request, type Server } from 'node:http';
import { join } from 'node:path';
import { startHttpChildServer } from '../../src/functions/http/child-server.js';
import type { DiscoveredOnRequest } from '../../src/functions/http/discovery.js';
import type { AddressInfo } from 'node:net';
import { createFunctionsHttpGateway, type AppOriginCheck, type FunctionsHttpGateway } from '../../src/functions/http/gateway.js';
import { FUNCTION_TARGET_HEADER } from '../../src/functions/http/child-server.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import type { HttpFunctionInfo } from '../../src/functions/http/discovery.js';

const TOKEN = 'test-token';

/** The plane's Origin check: only http://localhost:5173 is the app's own page. */
const appOriginOnly: AppOriginCheck = (req) => req.headers.origin === undefined || req.headers.origin === 'http://localhost:5173';

const info = (exportName: string, privateInvoker = false): HttpFunctionInfo => ({
  exportName, regions: ['us-central1'], platform: 'gcfv2', privateInvoker, timeoutSeconds: null,
});

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
    void gateway.handle(req, res, appOriginOnly).then((handled) => {
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
      plane: 'pyric-sandbox',
    });
    const base = await plane(gateway);
    const read = async () => {
      const response = await fetch(`${base}/demo-app/us-central1/api`);
      return [response.status, await response.text()];
    };
    expect(await read()).toEqual([503, 'Functions are not running yet: no browser tab is connected to the sandbox. Open http://localhost:3473 to start them.']);
    gateway.update({ kind: 'peer-timeout', serveUrl: 'http://localhost:3473' });
    expect(await read()).toEqual([503, 'Functions did not start: no browser tab connected to pyric sandbox within 30 s, and pyric sandbox does not retry. Open http://localhost:3473, then restart pyric sandbox.']);
    gateway.update({ kind: 'starting' });
    expect(await read()).toEqual([503, 'Functions are starting. Retry in a moment.']);
    gateway.update({ kind: 'reloading' });
    expect(await read()).toEqual([503, 'Functions are reloading after a source change. Retry in a moment.']);
    gateway.update({ kind: 'failed', message: 'SyntaxError in index.js' });
    expect(await read()).toEqual([503, 'Functions failed to start: SyntaxError in index.js']);
    gateway.update({ kind: 'unresponsive' });
    expect(await read()).toEqual([503, 'The Functions child is unresponsive: a handler may be stuck in a synchronous loop. pyric is restarting it; retry in a moment.']);
    gateway.update({ kind: 'exited', code: 1 });
    expect(await read()).toEqual([503, 'The Functions child exited (code 1). Restart pyric sandbox to start it again.']);
    // A path that is not a function route is never claimed, whatever the state.
    expect((await fetch(`${base}/index.html`)).status).toBe(404);
  });

  test('under Vite, the 503 lines name what Vite does to recover: it retries on a tab and reloads on save', async () => {
    const gateway = createFunctionsHttpGateway({
      projectId: 'demo-app',
      initial: { kind: 'peer-timeout', serveUrl: 'http://localhost:5173' },
      plane: 'vite',
    });
    const base = await plane(gateway);
    const read = async () => (await fetch(`${base}/demo-app/us-central1/api`)).text();
    expect(await read()).toBe('Functions are not running: no browser tab connected to the sandbox within 30 s. Open http://localhost:5173; they start when the tab connects.');
    gateway.update({ kind: 'exited', code: 1 });
    expect(await read()).toBe('The Functions child exited (code 1). Save a Functions source file or restart the Vite dev server to start it again.');
  });

  test('a write to an unknown function name gets firebase-tools\' 404; a read stays the plane\'s', async () => {
    const gateway = createFunctionsHttpGateway({ projectId: 'demo-app', initial: { kind: 'starting' }, plane: 'pyric-sandbox' });
    gateway.update({ kind: 'ready', http: { port: 1, token: TOKEN, functions: [info('api'), info('admin', true)] } });
    const base = await plane(gateway);
    const posted = await fetch(`${base}/demo-app/us-central1/typoName`, { method: 'POST', body: 'x' });
    expect(posted.status).toBe(404);
    expect(await posted.text()).toBe('Function us-central1-typoName does not exist, valid functions are: us-central1-api, us-central1-admin');
    const read = await fetch(`${base}/demo-app/us-central1/typoName`);
    expect([read.status, await read.text()]).toEqual([404, 'static']);
  });

  test('a private function refuses a foreign Origin; a public one answers it, as production does', async () => {
    const seen: string[] = [];
    const child = await listen(createServer((req, res) => {
      seen.push(String(req.headers[FUNCTION_TARGET_HEADER]));
      res.end('ran');
    }));
    const gateway = createFunctionsHttpGateway({ projectId: 'demo-app', initial: { kind: 'starting' }, plane: 'pyric-sandbox' });
    gateway.update({ kind: 'ready', http: { port: Number(new URL(child).port), token: TOKEN, functions: [info('api'), info('admin', true)] } });
    const base = await plane(gateway);
    const post = (name: string, origin?: string) => fetch(`${base}/demo-app/us-central1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...(origin === undefined ? {} : { origin }) },
      body: 'x',
    });

    const foreign = await post('admin', 'https://attacker.example');
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).toContain("invoker: 'private'");
    expect(seen).toEqual([]);

    expect((await post('admin', 'http://localhost:5173')).status).toBe(200);
    expect((await post('admin')).status).toBe(200);
    expect((await post('api', 'https://attacker.example')).status).toBe(200);
    expect(seen).toEqual(['admin', 'admin', 'api']);

    // A browser leaves the Origin off a cross-site GET, but Sec-Fetch-Site still names another page.
    const getWith = (name: string, site: string) => fetch(`${base}/demo-app/us-central1/${name}`, { headers: { 'sec-fetch-site': site } });
    for (const site of ['cross-site', 'same-site']) {
      const refused = await getWith('admin', site);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain(`a ${site} page`);
    }
    expect((await getWith('admin', 'same-origin')).status).toBe(200);
    expect((await getWith('admin', 'none')).status).toBe(200);
    expect((await getWith('api', 'cross-site')).status).toBe(200);
    expect(seen).toEqual(['admin', 'admin', 'api', 'admin', 'admin', 'api']);
  });

  test('forwards a served function to the child with its body and streams the answer back', async () => {
    const seen: Array<{ url: string | undefined; target: unknown; token: unknown; body: string }> = [];
    const child = await listen(createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        seen.push({ url: req.url, target: req.headers[FUNCTION_TARGET_HEADER], token: req.headers[CHILD_TOKEN_HEADER], body });
        res.writeHead(201, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] });
        res.write('one,');
        res.end('two');
      });
    }));
    const port = Number(new URL(child).port);
    const gateway = createFunctionsHttpGateway({ projectId: 'demo-app', initial: { kind: 'starting' }, plane: 'pyric-sandbox' });
    gateway.update({
      kind: 'ready',
      http: { port, token: TOKEN, functions: [info('api')] },
    });
    const base = await plane(gateway);
    const response = await fetch(`${base}/demo-app/us-central1/api/items?x=1`, { method: 'POST', body: 'payload' });
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await response.text()).toBe('one,two');
    expect(seen).toEqual([{ url: '/items?x=1', target: 'api', token: TOKEN, body: 'payload' }]);

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
        res.json({ ip: req.ip, hostname: req.hostname, protocol: req.protocol, forwardedFor: req.headers['x-forwarded-for'], secret: req.headers['x-secret'] ?? null, token: req.headers[CHILD_TOKEN_HEADER] ?? null });
      }) as DiscoveredOnRequest['handler'],
    };
    const child = await startHttpChildServer(join(import.meta.dir, '../../../conformance/package.json'), [report], { token: TOKEN });
    const gateway = createFunctionsHttpGateway({ projectId: 'demo-app', initial: { kind: 'starting' }, plane: 'pyric-sandbox' });
    gateway.update({ kind: 'ready', http: { port: child.port, token: TOKEN, functions: [report] } });
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
        token: null,
      });
    } finally {
      await child.close();
    }
  });
});
