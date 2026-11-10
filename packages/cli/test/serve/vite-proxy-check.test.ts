/**
 * The Vite plugin checks each `server.proxy` target at start (#2304 G-5).
 * Fake targets answer the process health request as each kind of backend
 * would; the tests assert verdicts and the health report, never the warning's copy.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { PROCESS_HEALTH_HEADER, PROCESS_HEALTH_PATH } from '../../src/register/process-health.js';
import { EventEmitter } from 'node:events';
import {
  attachViteProxyCheck,
  createProxyCheck,
  type ProxyCheckServer,
  loopbackProxyTargets,
  reportProxyTargets,
  type HostIdentity,
  type ProxyHook,
} from '../../src/serve/vite-proxy-check.js';

const servers: http.Server[] = [];
afterAll(async () => {
  for (const server of servers) await new Promise((done) => server.close(done));
});

/** A backend that answers the process health request with `body`, or 404 when `body` is null. */
async function target(body: unknown): Promise<string> {
  const server = http.createServer((req, res) => {
    const asks = req.url === PROCESS_HEALTH_PATH && req.headers[PROCESS_HEALTH_HEADER] !== undefined;
    const answers = asks && body !== null;
    if (answers) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  await new Promise((done) => server.close(done));
  return port;
}

const sandboxHost: HostIdentity = { mode: 'sandbox', instanceId: 'host-1' };
const liveHost: HostIdentity = { mode: 'live', projectId: 'prod-app' };

async function verdicts(host: HostIdentity, proxy: Record<string, unknown>): Promise<Record<string, string>> {
  const check = createProxyCheck({ proxy, host: () => host, warn: () => {} });
  await check.checkAll();
  return Object.fromEntries(check.report().map((entry) => [entry.context, entry.verdict]));
}

describe('loopback proxy targets', () => {
  it('reads string and object targets on this machine, and skips the rest', () => {
    const proxy = {
      '/a': 'http://localhost:3000',
      '/b': { target: 'http://127.0.0.1:3001' },
      '/c': { target: 'http://[::1]:3002/base' },
      '/d': 'https://api.example.com',
      '/e': { target: 'http://10.0.0.5:3000' },
    };
    expect(loopbackProxyTargets(proxy).map((entry) => entry.context)).toEqual(['/a', '/b', '/c']);
  });

  it('reads no targets when the config has no proxy', () => {
    expect(loopbackProxyTargets(undefined)).toEqual([]);
  });
});

describe('a sandbox page checks its proxy targets', () => {
  it('gives each kind of backend its verdict', async () => {
    const proxy = {
      '/same': await target({ pyricProcess: { mode: 'sandbox', instanceId: 'host-1' } }),
      '/other': await target({ pyricProcess: { mode: 'sandbox', instanceId: 'host-2' } }),
      '/live': await target({ pyricProcess: { mode: 'live', projectId: 'prod-app' } }),
      '/host': await target({ mode: 'serve', instanceId: 'host-3', project: 'demo' }),
      '/plain': await target(null),
      '/down': `http://127.0.0.1:${await closedPort()}`,
    };
    expect(await verdicts(sandboxHost, proxy)).toEqual({
      '/same': 'same',
      '/other': 'other-instance',
      '/live': 'other-mode',
      '/host': 'pyric-host',
      '/plain': 'not-pyric',
      '/down': 'not-pyric',
    });
  });

  it('calls a sandbox backend the same when neither side has an instance', async () => {
    const proxy = { '/api': await target({ pyricProcess: { mode: 'sandbox' } }) };
    expect(await verdicts({ mode: 'sandbox' }, proxy)).toEqual({ '/api': 'same' });
  });
});

describe('WebSocket and HTTPS targets', () => {
  it('asks a ws:// target over HTTP', async () => {
    const backend = await target({ pyricProcess: { mode: 'sandbox', instanceId: 'host-1' } });
    const proxy = { '/socket.io': { target: backend.replace('http:', 'ws:'), ws: true } };
    expect(await verdicts(sandboxHost, proxy)).toEqual({ '/socket.io': 'same' });
  });

  it('asks an https:// or wss:// target over HTTPS, and reads a failed handshake as no answer', async () => {
    const backend = await target({ pyricProcess: { mode: 'sandbox', instanceId: 'host-1' } });
    const proxy = {
      '/tls': backend.replace('http:', 'https:'),
      '/wss': { target: backend.replace('http:', 'wss:'), ws: true },
    };
    expect(await verdicts(sandboxHost, proxy)).toEqual({ '/tls': 'not-pyric', '/wss': 'not-pyric' });
  });

  it('never rejects, whatever the target', async () => {
    const proxy: Record<string, unknown> = {
      '/ws': { target: `ws://127.0.0.1:${await closedPort()}`, ws: true },
      '/ftp': 'ftp://localhost:21',
      '/https': `https://localhost:${await closedPort()}`,
    };
    const check = createProxyCheck({ proxy, host: () => sandboxHost, warn: () => {} });
    await expect(check.checkAll()).resolves.toBeUndefined();
    for (const context of Object.keys(proxy)) {
      const entry = proxy[context] as { configure: (server: ProxyHook, options: unknown) => void };
      const listeners: Record<string, () => void> = {};
      const proxyServer: ProxyHook = { on: (event, listener) => { listeners[event] = listener as () => void; return proxyServer; } };
      entry.configure(proxyServer, entry);
      listeners.proxyRes?.();
    }
    await expect(check.settled()).resolves.toBeUndefined();
    expect(check.report().map((entry) => entry.verdict)).toEqual(['not-pyric', 'not-pyric', 'not-pyric']);
  });
});

describe('a live page checks its proxy targets', () => {
  it('gives each kind of backend its verdict', async () => {
    const proxy = {
      '/same': await target({ pyricProcess: { mode: 'live', projectId: 'prod-app' } }),
      '/project': await target({ pyricProcess: { mode: 'live', projectId: 'other-app' } }),
      '/sandbox': await target({ pyricProcess: { mode: 'sandbox', instanceId: 'host-1' } }),
      '/plain': await target(null),
    };
    expect(await verdicts(liveHost, proxy)).toEqual({
      '/same': 'same',
      '/project': 'other-project',
      '/sandbox': 'other-mode',
      '/plain': 'not-pyric',
    });
  });
});

describe('a target that did not answer at start', () => {
  it('is checked again on its first proxied request, through the app configure hook', async () => {
    const port = await closedPort();
    const appConfigured: unknown[] = [];
    const proxy: Record<string, unknown> = {
      '/api': { target: `http://127.0.0.1:${port}`, configure: (proxyServer: unknown) => appConfigured.push(proxyServer) },
    };
    const check = createProxyCheck({ proxy, host: () => sandboxHost, warn: () => {} });
    await check.checkAll();
    expect(check.report()).toEqual([{ context: '/api', verdict: 'not-pyric' }]);

    // The backend starts after the host, on the same port.
    const late = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pyricProcess: { mode: 'live', projectId: 'prod-app' } }));
    });
    servers.push(late);
    await new Promise<void>((done) => late.listen(port, '127.0.0.1', done));

    const listeners: Record<string, () => void> = {};
    const proxyServer: ProxyHook = { on: (event, listener) => { listeners[event] = listener as () => void; return proxyServer; } };
    const entry = proxy['/api'] as { configure: (server: ProxyHook, options: unknown) => void };
    entry.configure(proxyServer, entry);
    expect(appConfigured).toEqual([proxyServer]);
    listeners.proxyRes?.();
    await check.settled();
    expect(check.report()).toEqual([{ context: '/api', verdict: 'other-mode' }]);
  });
});

describe('the dangerous case warns once', () => {
  it('warns once per target and verdict, and not for a same backend', async () => {
    const proxy = {
      '/same': await target({ pyricProcess: { mode: 'sandbox', instanceId: 'host-1' } }),
      '/live': await target({ pyricProcess: { mode: 'live', projectId: 'prod-app' } }),
    };
    const warned: string[] = [];
    const check = createProxyCheck({ proxy, host: () => sandboxHost, warn: (line) => warned.push(line) });
    await check.checkAll();
    await check.checkAll();
    expect(warned.length).toBe(1);
  });
});

describe('host health lists the proxy targets', () => {
  function healthBody(
    mount: ReturnType<typeof createBridgeMount>,
    authenticated = true,
  ): Promise<Record<string, unknown>> {
    let body = '';
    const res = {
      writeHead() { return res; },
      end(chunk?: unknown) { body = String(chunk); return res; },
    };
    const headers: Record<string, string> = { host: 'localhost:5173' };
    if (authenticated) headers['x-pyric-session-token'] = mount.sessionToken;
    const req = { method: 'GET', headers, socket: { remoteAddress: '127.0.0.1', localPort: 5173 }, on() { return req; } };
    const url = new URL('http://localhost/__pyric/health');
    return mount.handler(req as never, res as never, url).then(() => JSON.parse(body) as Record<string, unknown>);
  }

  it('reports each context with its verdict when authenticated and omits proxyTargets when unauthenticated', async () => {
    const mount = createBridgeMount({ disableAuditLog: true });
    const stop = reportProxyTargets(mount.instanceId, () => [{ context: '/api', verdict: 'not-pyric' }]);
    expect((await healthBody(mount, false)).proxyTargets).toBeUndefined();
    expect((await healthBody(mount)).proxyTargets).toEqual([{ context: '/api', verdict: 'not-pyric' }]);
    stop();
    expect((await healthBody(mount)).proxyTargets).toBeUndefined();
    await mount.close();
  });

  it('lists the verdicts a dev server reached once it listens', async () => {
    const mount = createBridgeMount({ disableAuditLog: true });
    const httpServer = new EventEmitter();
    const server = {
      config: { server: { proxy: { '/api': await target({ pyricProcess: { mode: 'live', projectId: 'prod-app' } }) } }, logger: { warn() {} } },
      httpServer: httpServer as unknown as ProxyCheckServer['httpServer'],
      resolvedUrls: { local: ['http://localhost:5173/'] },
    };
    const stop = attachViteProxyCheck(server, { mode: 'sandbox', instanceId: mount.instanceId });
    httpServer.emit('listening');
    const expected = [{ context: '/api', verdict: 'other-mode' }];
    let listed: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      listed = (await healthBody(mount)).proxyTargets;
      if (JSON.stringify(listed) === JSON.stringify(expected)) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(listed).toEqual(expected);
    stop();
    await mount.close();
  });
});
