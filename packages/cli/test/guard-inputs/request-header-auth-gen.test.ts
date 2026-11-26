/**
 * Generative verification of request header & capability-token cartesian
 * products against `isTrustedSameOriginLoopbackRequest` across:
 *  - Private & public HTTP Functions in `pyric sandbox` (`startServe`) and
 *    `@pyric/cli/vite` (`attachViteGenerationFunctions`)
 *  - Ephemeral Functions host (`startEphemeralFunctionsHost`) `/__pyric/health`,
 *    `/__pyric/beacon`, `/__pyric/init.json`, and `WS /__pyric/sandbox` upgrade
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import type { ViteDevServer } from 'vite';
import { WebSocket } from 'ws';
import { startEphemeralFunctionsHost } from '../../src/bridge/surface/functions-ephemeral-host.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import type { HttpFunctionInfo } from '../../src/functions/http/discovery.js';
import { createFunctionsHttpGateway } from '../../src/functions/http/gateway.js';
import type { BridgeMount } from '../../src/serve/bridge-mount.js';
import { silentServeLogger } from '../../src/serve/server.js';
import type { ViteFunctionsDevelopmentOptions } from '../../src/serve/vite-functions-development.js';
import { attachViteGenerationFunctions } from '../../src/serve/vite-generation-functions.js';
import { mapPool } from './combinators.js';
import {
  expectedEphemeralBeaconStatus,
  expectedEphemeralHealthOutcome,
  expectedEphemeralInitStatus,
  expectedEphemeralWsUpgraded,
  generateEphemeralHostCartesianProduct,
  generateFunctionsHeaderCartesianProduct,
  isTrustedSameOriginLoopbackRequest,
  toWireHeaders,
} from './request-header-auth-gen.js';

const tempDirs: string[] = [];
const plainServers: Server[] = [];
const serveRuntimes: ServeRuntime[] = [];

function makeTempProjectDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, '.firebaserc'),
    JSON.stringify({ projects: { default: 'demo-project' } }),
  );
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({}));
  return dir;
}

function listenLoopback(server: Server): Promise<number> {
  plainServers.push(server);
  return new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => {
      resolvePort((server.address() as AddressInfo).port);
    });
  });
}

function sendHttp(opts: {
  port: number;
  path: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  const wireHeaders: Record<string, string> = {
    ...opts.headers,
    connection: 'close',
  };
  if (opts.body !== undefined) {
    wireHeaders['content-length'] = String(Buffer.byteLength(opts.body));
  }
  return new Promise((resolveCall, rejectCall) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: wireHeaders,
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolveCall({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', rejectCall);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function probeWsUpgrade(wsUrl: string, headers: Record<string, string>): Promise<boolean> {
  return new Promise((resolveWs) => {
    let settled = false;
    const finish = (upgraded: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveWs(upgraded);
    };
    const ws = new WebSocket(wsUrl, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      finish(false);
    }, 2000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'attach', protocol: 1 }));
    });
    ws.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString()) as { type?: string };
      finish(parsed.type === 'attach-ack');
      ws.close();
    });
    ws.on('error', () => finish(false));
    ws.on('close', () => finish(false));
  });
}

function probeRawEmptyHostWsUpgrade(port: number, sessionToken: string): Promise<boolean> {
  return new Promise((resolveRaw) => {
    let responseHead = '';
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(
        [
          'GET /__pyric/sandbox HTTP/1.1',
          'Host: ',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          `x-pyric-session-token: ${sessionToken}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      responseHead += chunk;
      if (responseHead.includes('\r\n')) socket.destroy();
    });
    socket.on('error', () => resolveRaw(false));
    socket.on('close', () => {
      resolveRaw(/^HTTP\/1\.[01]\s+101\b/.test(responseHead));
    });
  });
}

const privateFn: HttpFunctionInfo = {
  exportName: 'privateItems',
  regions: ['us-central1'],
  platform: 'gcfv2',
  privateInvoker: true,
  timeoutSeconds: null,
};

const publicFn: HttpFunctionInfo = {
  exportName: 'publicItems',
  regions: ['us-central1'],
  platform: 'gcfv2',
  privateInvoker: false,
  timeoutSeconds: null,
};

function createViteFunctionsHttpHarness(
  childPort: number,
  allowedHosts: true | string[],
): Promise<number> {
  let captured: ViteFunctionsDevelopmentOptions | undefined;
  const mockVite = {
    config: { server: { host: '127.0.0.1', allowedHosts }, logger: { warn: () => undefined } },
    httpServer: {},
    middlewares: { use: () => undefined },
    watcher: {},
  } as unknown as ViteDevServer;
  attachViteGenerationFunctions({
    server: mockVite,
    projectDir: '/project',
    cliRoot: '/cli',
    bridge: {} as BridgeMount,
    resolved: {
      options: {},
      project: { sourceDir: '/project/functions', entry: '/project/functions/index.js' },
      projectId: 'demo-project',
    },
    registerModuleUrl: () => 'file:///register.js',
    fileExists: () => false,
    attach: (options) => {
      captured = options;
      return { close: async () => undefined };
    },
  });
  if (captured === undefined) {
    throw new Error('attachViteGenerationFunctions did not invoke attach');
  }
  const viteOpts = captured;
  const gateway = createFunctionsHttpGateway({
    projectId: 'demo-project',
    initial: { kind: 'starting' },
    plane: 'vite',
  });
  gateway.update({
    kind: 'ready',
    http: { port: childPort, token: 'child-token', functions: [privateFn, publicFn] },
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!viteOpts.isAllowedRequest(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden Host');
      return;
    }
    void gateway.handle(req, res, viteOpts.allowsAppOrigin).then((handled) => {
      if (!handled) res.writeHead(404).end('Not Found');
    });
  });
  return listenLoopback(server);
}

afterAll(async () => {
  while (serveRuntimes.length > 0) {
    const rt = serveRuntimes.pop();
    if (rt !== undefined) await rt.handle.stop();
  }
  while (plainServers.length > 0) {
    const srv = plainServers.pop();
    if (srv !== undefined) {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Request header & auth cartesian generator (HTTP Functions & ephemeral host)', () => {
  it('9. enforces isTrustedSameOriginLoopbackRequest across all 240 Host x Origin x Sec-Fetch-Site combinations on pyric sandbox and @pyric/cli/vite private HTTP Functions', async () => {
    const childPort = await listenLoopback(
      createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/plain' }).end('ok-item');
        });
      }),
    );

    const sandboxGateway = createFunctionsHttpGateway({
      projectId: 'demo-project',
      initial: { kind: 'starting' },
      plane: 'pyric-sandbox',
    });
    sandboxGateway.update({
      kind: 'ready',
      http: { port: childPort, token: 'child-token', functions: [privateFn, publicFn] },
    });
    const projectDir = makeTempProjectDir('pyric-gen-hdr-serve-');
    const cacheDir = makeTempProjectDir('pyric-gen-hdr-cache-');
    const runtime = await startServe({
      cwd: projectDir,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: cacheDir,
      capture: false,
      logger: silentServeLogger(),
      functionsHandler: sandboxGateway.handle,
    });
    serveRuntimes.push(runtime);
    const sandboxPort = runtime.handle.port;

    const viteStrictPort = await createViteFunctionsHttpHarness(childPort, []);
    const viteWildcardPort = await createViteFunctionsHttpHarness(childPort, true);

    const privatePath = '/demo-project/us-central1/privateItems';
    const publicPath = '/demo-project/us-central1/publicItems';
    const failures: string[] = [];

    const sandboxVectors = generateFunctionsHeaderCartesianProduct(sandboxPort);
    expect(sandboxVectors.length).toBe(240);
    await mapPool(sandboxVectors, 24, async (vec) => {
      const expectedStatus = isTrustedSameOriginLoopbackRequest(vec) ? 200 : 403;
      const ans = await sendHttp({
        port: sandboxPort,
        path: privatePath,
        method: 'POST',
        headers: toWireHeaders(vec),
        body: 'x',
      });
      if (ans.status !== expectedStatus) {
        failures.push(
          `sandbox ${vec.id}: expected ${String(expectedStatus)}, got ${String(ans.status)}`,
        );
      }
    });

    const publicForeignOrigin = await sendHttp({
      port: sandboxPort,
      path: publicPath,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${String(sandboxPort)}`,
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
      body: 'x',
    });
    if (publicForeignOrigin.status !== 200) {
      failures.push(`sandbox public foreign origin: got ${String(publicForeignOrigin.status)}`);
    }
    const publicForeignHost = await sendHttp({
      port: sandboxPort,
      path: publicPath,
      method: 'POST',
      headers: { host: 'evil.test' },
      body: 'x',
    });
    if (publicForeignHost.status !== 403) {
      failures.push(`sandbox public evil.test Host: got ${String(publicForeignHost.status)}`);
    }

    const viteStrictVectors = generateFunctionsHeaderCartesianProduct(viteStrictPort);
    await mapPool(viteStrictVectors, 24, async (vec) => {
      const expectedStatus = isTrustedSameOriginLoopbackRequest(vec) ? 200 : 403;
      const ans = await sendHttp({
        port: viteStrictPort,
        path: privatePath,
        method: 'POST',
        headers: toWireHeaders(vec),
        body: 'x',
      });
      if (ans.status !== expectedStatus) {
        failures.push(
          `vite-strict ${vec.id}: expected ${String(expectedStatus)}, got ${String(ans.status)}`,
        );
      }
    });

    const viteWildcardVectors = generateFunctionsHeaderCartesianProduct(viteWildcardPort);
    await mapPool(viteWildcardVectors, 24, async (vec) => {
      // Vite server.allowedHosts: true is ignored for Functions DNS-rebinding checks.
      const expectedStatus = isTrustedSameOriginLoopbackRequest(vec) ? 200 : 403;
      const ans = await sendHttp({
        port: viteWildcardPort,
        path: privatePath,
        method: 'POST',
        headers: toWireHeaders(vec),
        body: 'x',
      });
      if (ans.status !== expectedStatus) {
        failures.push(
          `vite-wildcard ${vec.id}: expected ${String(expectedStatus)}, got ${String(ans.status)}`,
        );
      }
    });

    expect(failures).toEqual([]);
  }, 45_000);

  it('10. enforces Host x Origin x Sec-Fetch-Site x Auth predicates across /__pyric/health, /__pyric/beacon, /__pyric/init.json, and WS upgrade on functions-ephemeral-host', async () => {
    const sandbox = initializeSandbox();
    const host = await startEphemeralFunctionsHost(sandbox, {
      projectId: 'demo-project',
      defaultInstance: 'demo-project-default-rtdb',
    });
    const port = Number(new URL(host.serveUrl()).port);
    const wsUrl = `ws://127.0.0.1:${String(port)}/__pyric/sandbox`;

    try {
      const matrix = generateEphemeralHostCartesianProduct(port, host.sessionToken);
      expect(matrix.length).toBe(480);

      const failures: string[] = [];

      await mapPool(matrix, 24, async (vec) => {
        const headers = toWireHeaders(vec);

        const expectedHealth = expectedEphemeralHealthOutcome(vec);
        const healthAns = await sendHttp({ port, path: '/__pyric/health', headers });
        if (healthAns.status !== expectedHealth.status) {
          failures.push(
            `health ${vec.id}: expected ${String(expectedHealth.status)}, got ${String(healthAns.status)}`,
          );
        } else if (healthAns.status === 200) {
          const parsed = JSON.parse(healthAns.body) as Record<string, unknown>;
          const hasProject = 'project' in parsed;
          if (hasProject !== expectedHealth.exposesProject) {
            failures.push(
              `health.project ${vec.id}: expected exposesProject=${String(expectedHealth.exposesProject)}, got ${String(hasProject)}`,
            );
          }
        }

        const expectedInit = expectedEphemeralInitStatus(vec);
        const initAns = await sendHttp({ port, path: '/__pyric/init.json', headers });
        if (initAns.status !== expectedInit) {
          failures.push(
            `init ${vec.id}: expected ${String(expectedInit)}, got ${String(initAns.status)}`,
          );
        }

        const expectedBeacon = expectedEphemeralBeaconStatus(vec);
        const beaconAns = await sendHttp({
          port,
          path: '/__pyric/beacon',
          method: 'POST',
          headers: toWireHeaders(vec, { 'content-type': 'application/json' }),
          body: JSON.stringify({ pid: 100, hooks: true }),
        });
        if (beaconAns.status !== expectedBeacon) {
          failures.push(
            `beacon ${vec.id}: expected ${String(expectedBeacon)}, got ${String(beaconAns.status)}`,
          );
        }
      });

      const wsSlice = matrix.filter((vec) => vec.host.kind !== 'empty');
      expect(wsSlice.length).toBe(360);

      await mapPool(wsSlice, 32, async (vec) => {
        const expectedUpgraded = expectedEphemeralWsUpgraded(vec);
        const upgraded = await probeWsUpgrade(wsUrl, toWireHeaders(vec));
        if (upgraded !== expectedUpgraded) {
          failures.push(
            `ws ${vec.id}: expected upgraded=${String(expectedUpgraded)}, got ${String(upgraded)}`,
          );
        }
      });

      const emptyHostUpgraded = await probeRawEmptyHostWsUpgrade(port, host.sessionToken);
      if (emptyHostUpgraded) {
        failures.push('ws empty Host header unexpectedly upgraded to 101');
      }

      expect(failures).toEqual([]);
    } finally {
      await host.close();
      sandbox.dispose();
    }
  }, 45_000);
});
