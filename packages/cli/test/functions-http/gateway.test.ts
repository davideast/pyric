import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
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

    const missing = await fetch(`${base}/demo-app/us-central1/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('Function us-central1-nope does not exist, valid functions are: us-central1-api');
  });
});
