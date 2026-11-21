import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppPorts } from '../../src/serve/app-ports.js';
import { handleActivity } from '../../src/serve/activity-route.js';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { createFlowTreatmentHost } from '../../src/serve/flow-treatment-host.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { createStudioRoutes, diskWorkspace } from '../../src/serve/studio/index.js';
import { startServer as startStandaloneBridge, type ServerHandle as BridgeHandle } from '../../src/bridge/server/standalone.js';

const handles: ServeHandle[] = [];
const bridgeHandles: BridgeHandle[] = [];
const mounts: Array<{ close(): Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (mounts.length > 0) {
    const mount = mounts.pop();
    if (mount !== undefined) await mount.close();
  }
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) await handle.stop();
  }
  while (bridgeHandles.length > 0) {
    const bridge = bridgeHandles.pop();
    if (bridge !== undefined) await bridge.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function rawRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('unified remote-access guards across route surfaces', () => {
  it('uses effectiveRequestScheme on POST /__pyric/activity behind a TLS proxy', async () => {
    const token = 'activity-session-secret';
    const activityToken = 'activity-cap-secret';
    let lastStatus = 0;
    const makeRes = (): ServerResponse =>
      ({
        writeHead(code: number) {
          lastStatus = code;
          return this;
        },
        end() {
          return this;
        },
      }) as unknown as ServerResponse;

    const makeReq = (headers: Record<string, string>, remoteAddress = '127.0.0.1'): IncomingMessage => {
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
      const req = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
        socket: { remoteAddress, localPort: 5173, encrypted: false },
        on(event: string, cb: (...args: unknown[]) => void) {
          const list = listeners.get(event) ?? [];
          list.push(cb);
          listeners.set(event, list);
          if (event === 'end') {
            queueMicrotask(() => {
              for (const fn of listeners.get('data') ?? []) fn(Buffer.from('{}'));
              for (const fn of listeners.get('end') ?? []) fn();
            });
          }
          return req;
        },
        resume() {},
      };
      return req as unknown as IncomingMessage;
    };

    // Without trustProxy, HTTPS Origin over plain HTTP socket is refused (403).
    await handleActivity(
      () => {},
      makeReq({
        host: 'devbox.example.com:8443',
        origin: 'https://devbox.example.com:8443',
        'x-forwarded-proto': 'https',
        'x-pyric-activity-token': activityToken,
        'x-pyric-session-token': token,
      }),
      makeRes(),
      activityToken,
      { boundHost: '127.0.0.1', allowedHosts: ['devbox.example.com'], sessionToken: token },
    );
    expect(lastStatus).toBe(403);

    // With trustProxy: 'loopback', missing session token fails with 401 on remote Host.
    await handleActivity(
      () => {},
      makeReq({
        host: 'devbox.example.com:8443',
        origin: 'https://devbox.example.com:8443',
        'x-forwarded-proto': 'https',
        'x-pyric-activity-token': activityToken,
      }),
      makeRes(),
      activityToken,
      {
        boundHost: '127.0.0.1',
        allowedHosts: ['devbox.example.com'],
        sessionToken: token,
        remoteAccess: { trustProxy: 'loopback' },
      },
    );
    expect(lastStatus).toBe(401);

    // Authenticated request passes scheme & host checks (400 only because body '{}' is not a full incident).
    await handleActivity(
      () => {},
      makeReq({
        host: 'devbox.example.com:8443',
        origin: 'https://devbox.example.com:8443',
        'x-forwarded-proto': 'https',
        'x-pyric-activity-token': activityToken,
        'x-pyric-session-token': token,
      }),
      makeRes(),
      activityToken,
      {
        boundHost: '127.0.0.1',
        allowedHosts: ['devbox.example.com'],
        sessionToken: token,
        remoteAccess: { trustProxy: 'loopback' },
      },
    );
    expect(lastStatus).toBe(400);
  });

  it('honors learned appPorts in studio/routes.ts and app-ports.ts under a trusted proxy', async () => {
    const dir = makeTempDir('pyric-studio-appports-');
    writeFileSync(join(dir, 'hello.txt'), 'world');
    const appPorts = createAppPorts('127.0.0.1', {
      allowedHosts: ['.tailnet.ts.net'],
      trustProxy: 'loopback',
    });
    // Untrusted peer cannot teach a remote host port.
    appPorts.learn({
      headers: {
        'sec-fetch-site': 'same-origin',
        'x-forwarded-host': 'box.tailnet.ts.net:3000',
      },
      socket: { remoteAddress: '203.0.113.5', localPort: 3473 },
    } as unknown as IncomingMessage);
    expect(appPorts.forRequest({ socket: { localPort: 3473 } } as unknown as IncomingMessage)).toEqual([3473]);

    // Loopback proxy peer teaches port 3000 on same-origin request.
    appPorts.learn({
      headers: {
        'sec-fetch-site': 'same-origin',
        'x-forwarded-host': 'box.tailnet.ts.net:3000',
      },
      socket: { remoteAddress: '127.0.0.1', localPort: 3473 },
    } as unknown as IncomingMessage);
    expect(appPorts.forRequest({ socket: { localPort: 3473 } } as unknown as IncomingMessage)).toEqual([3473, 3000]);

    const routes = createStudioRoutes({
      workspace: diskWorkspace(dir),
      sessionToken: 'studio-secret',
      boundHost: '127.0.0.1',
      appPorts,
      remoteAccess: { allowedHosts: ['.tailnet.ts.net'], trustProxy: 'loopback' },
    });

    let status = 0;
    const mockRes = {
      writeHead(code: number) {
        status = code;
        return mockRes;
      },
      end() {
        return mockRes;
      },
      headersSent: false,
    } as unknown as ServerResponse;

    await routes(
      {
        method: 'GET',
        headers: {
          host: 'box.tailnet.ts.net:3473',
          origin: 'http://box.tailnet.ts.net:3000',
          'sec-fetch-site': 'same-site',
          'x-pyric-session-token': 'studio-secret',
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 3473, encrypted: false },
      } as unknown as IncomingMessage,
      mockRes,
      new URL('http://box.tailnet.ts.net:3473/__pyric/workspace?path=hello.txt'),
    );
    expect(status).toBe(200);
  });

  it('throttles rejected WS upgrade diagnostics and wires remoteAccess on flow host and standalone bridge', async () => {
    const rejections: string[] = [];
    const mount = createBridgeMount({
      disableAuditLog: true,
      sessionToken: 'ws-secret-token',
      upgradeGuard: { boundHost: '127.0.0.1', allowedHosts: ['devbox.example.com'] },
      upgradeRejectionLogger: (line) => rejections.push(line),
    });
    mounts.push(mount);

    const projectDir = makeTempDir('pyric-ws-log-');
    const server = await startStaticServer({
      publicDir: projectDir,
      host: '127.0.0.1',
      port: 0,
      logger: silentServeLogger(),
    });
    handles.push(server);
    mount.attachHost({
      servers: server.servers,
      projectDir,
      origin: () => ({ host: '127.0.0.1', port: server.port }),
    });

    const destroyCalls = { count: 0 };
    const fakeUpgrade = (host: string) => {
      const fakeSocket = {
        destroy() {
          destroyCalls.count += 1;
        },
        once() {},
      };
      server.server.emit(
        'upgrade',
        {
          url: '/__pyric/sandbox',
          headers: { host },
          socket: { remoteAddress: '127.0.0.1', localPort: server.port, encrypted: false },
        },
        fakeSocket,
        Buffer.alloc(0),
      );
    };
    fakeUpgrade('evil.example');
    fakeUpgrade('evil.example');
    expect(destroyCalls.count).toBe(2);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain('disallowed-host');

    const flowHost = await createFlowTreatmentHost(projectDir, undefined, {
      boundHost: '127.0.0.1',
      sessionToken: 'flow-token',
      remoteAccess: { allowedHosts: ['.tailnet.ts.net'] },
    });
    let flowStatus = 0;
    const flowRes = {
      setHeader() {},
      end() {},
      set statusCode(code: number) {
        flowStatus = code;
      },
    } as unknown as ServerResponse;
    await flowHost.handle(
      {
        method: 'GET',
        headers: { host: 'box.tailnet.ts.net:5173' },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      } as unknown as IncomingMessage,
      flowRes,
      new URL('http://box.tailnet.ts.net:5173/__pyric/flow/manifest.json'),
    );
    expect(flowStatus).toBe(401);

    flowStatus = 200;
    let flowBody = '';
    const okFlowRes = {
      setHeader() {},
      end(chunk?: string) {
        if (chunk !== undefined) flowBody = chunk;
      },
      set statusCode(code: number) {
        flowStatus = code;
      },
    } as unknown as ServerResponse;
    await flowHost.handle(
      {
        method: 'GET',
        headers: { host: 'box.tailnet.ts.net:5173', 'x-pyric-session-token': 'flow-token' },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      } as unknown as IncomingMessage,
      okFlowRes,
      new URL('http://box.tailnet.ts.net:5173/__pyric/flow/manifest.json'),
    );
    expect(flowStatus).toBe(200);
    expect(flowBody.length).toBeGreaterThan(0);

    const standalone = await startStandaloneBridge({
      port: 0,
      disableAuditLog: true,
      silent: true,
      sessionToken: 'standalone-token',
      remoteAccess: { allowedHosts: ['.tailnet.ts.net'], trustProxy: 'loopback' },
    });
    bridgeHandles.push(standalone);

    const unauthHealth = await rawRequest({
      port: standalone.port,
      path: '/health',
      headers: { Host: 'box.tailnet.ts.net:8443', 'x-forwarded-proto': 'https' },
    });
    expect(unauthHealth.status).toBe(401);

    const authedHealth = await rawRequest({
      port: standalone.port,
      path: '/health',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
        'x-pyric-session-token': 'standalone-token',
      },
    });
    expect(authedHealth.status).toBe(200);
  });
});
