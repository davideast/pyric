/**
 * Tests for private HTTP Function foreign-origin refusal (`private-origin.ts`),
 * covering empty `Origin: ""` (with and without `Sec-Fetch-Site`), cross-scheme
 * loopback origins, and clean 403 diagnostics.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpFunctionInfo } from '../../src/functions/http/discovery.js';
import { createFunctionsHttpGateway } from '../../src/functions/http/gateway.js';
import { refuseForeignOrigin } from '../../src/functions/http/private-origin.js';
import {
  getHeader,
  isAllowedOriginOnPorts,
  isForeignFetchSite,
  requestSocketScheme,
} from '../../src/serve/loopback-guard.js';

const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function sendRaw(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'POST',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (method === 'POST') req.end('payload');
    else req.end();
  });
}

function makeMockRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let code = 200;
  let text = '';
  const res = {
    writeHead(status: number) {
      code = status;
      return res;
    },
    end(chunk?: string) {
      if (chunk !== undefined) text += chunk;
      return res;
    },
  } as unknown as ServerResponse;
  return { res, status: () => code, body: () => text };
}

const privateFn: HttpFunctionInfo = {
  exportName: 'privateItem',
  regions: ['us-central1'],
  platform: 'gcfv2',
  privateInvoker: true,
  timeoutSeconds: null,
};

const publicFn: HttpFunctionInfo = {
  exportName: 'publicItem',
  regions: ['us-central1'],
  platform: 'gcfv2',
  privateInvoker: false,
  timeoutSeconds: null,
};

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('refuseForeignOrigin', () => {
  it('fails closed on empty or whitespace Origin even if allowsAppOrigin is permissive', () => {
    const vectors: Array<{ headers: Record<string, string>; expectedSnippet: string }> = [
      { headers: { origin: '', 'sec-fetch-site': 'cross-site' }, expectedSnippet: 'a cross-site page' },
      { headers: { origin: '', 'sec-fetch-site': 'same-site' }, expectedSnippet: 'a same-site page' },
      { headers: { origin: '' }, expectedSnippet: 'an empty Origin' },
      { headers: { origin: '   ' }, expectedSnippet: 'an empty Origin' },
    ];

    for (const vector of vectors) {
      const mockRes = makeMockRes();
      const req = { headers: vector.headers } as unknown as IncomingMessage;
      const refused = refuseForeignOrigin(req, mockRes.res, privateFn, () => true);
      expect(refused).toBe(true);
      expect(mockRes.status()).toBe(403);
      expect(mockRes.body()).toContain(vector.expectedSnippet);
      expect(mockRes.body()).toContain("invoker: 'private'");
    }
  });

  it('still allows public functions regardless of empty Origin or foreign Sec-Fetch-Site', () => {
    const mockRes = makeMockRes();
    const req = {
      headers: { origin: '', 'sec-fetch-site': 'cross-site' },
    } as unknown as IncomingMessage;
    expect(refuseForeignOrigin(req, mockRes.res, publicFn, () => false)).toBe(false);
    expect(mockRes.status()).toBe(200);
  });

  it('blocks empty Origin and cross-scheme loopback Origin over a real HTTP gateway', async () => {
    let childHits = 0;
    const childPort = await listen(
      createServer((req, res) => {
        req.resume();
        childHits += 1;
        res.end('ok');
      }),
    );

    const gateway = createFunctionsHttpGateway({
      projectId: 'demo-project',
      initial: { kind: 'starting' },
      plane: 'pyric-sandbox',
    });
    gateway.update({
      kind: 'ready',
      http: { port: childPort, token: 'child-token', functions: [privateFn, publicFn] },
    });

    const gatewayPort = await listen(
      createServer((req, res) => {
        const ports = req.socket.localPort === undefined ? [] : [req.socket.localPort];
        const scheme = requestSocketScheme(req);
        const allows = (incoming: IncomingMessage): boolean =>
          isAllowedOriginOnPorts(getHeader(incoming, 'origin'), '127.0.0.1', [], ports, scheme) &&
          !isForeignFetchSite(incoming, '127.0.0.1', ports, scheme);
        void gateway.handle(req, res, allows).then((handled) => {
          if (!handled) res.writeHead(404).end('not found');
        });
      }),
    );

    const path = '/demo-project/us-central1/privateItem';
    const hostHeader = `127.0.0.1:${gatewayPort}`;

    const emptyWithSite = await sendRaw(gatewayPort, path, {
      host: hostHeader,
      origin: '',
      'sec-fetch-site': 'cross-site',
    });
    expect(emptyWithSite.status).toBe(403);

    const emptyAlone = await sendRaw(gatewayPort, path, {
      host: hostHeader,
      origin: '',
    });
    expect(emptyAlone.status).toBe(403);

    const crossScheme = await sendRaw(gatewayPort, path, {
      host: hostHeader,
      origin: `https://127.0.0.1:${gatewayPort}`,
    });
    expect(crossScheme.status).toBe(403);

    const crossSiteSameOriginHeader = await sendRaw(gatewayPort, path, {
      host: hostHeader,
      origin: `http://127.0.0.1:${gatewayPort}`,
      'sec-fetch-site': 'cross-site',
    });
    expect(crossSiteSameOriginHeader.status).toBe(403);
    expect(childHits).toBe(0);

    // Same-origin HTTP page and Origin-less non-browser caller succeed.
    const sameOrigin = await sendRaw(gatewayPort, path, {
      host: hostHeader,
      origin: `http://127.0.0.1:${gatewayPort}`,
      'sec-fetch-site': 'same-origin',
    });
    expect(sameOrigin.status).toBe(200);

    const nonBrowser = await sendRaw(gatewayPort, path, { host: hostHeader });
    expect(nonBrowser.status).toBe(200);
    expect(childHits).toBe(2);
  });
});
