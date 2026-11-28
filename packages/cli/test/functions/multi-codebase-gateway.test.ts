/**
 * Cross-codebase HTTP gateway routing, Hosting rewrites, 404 listings,
 * and execution-log `codebase` metadata tests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { initializeSandbox } from 'pyric/sandbox';
import {
  createFunctionsDevelopmentRuntime,
  type FunctionsDevelopmentEvent,
} from '../../src/functions/development-runtime.js';
import { listExecutions } from '../../src/functions/execution-log.js';
import { FUNCTION_TARGET_HEADER } from '../../src/functions/http/child-server.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import {
  createFunctionsHttpGateway,
  type FunctionsHttpRecord,
} from '../../src/functions/http/gateway.js';
import { hostingRewrites } from '../../src/functions/http/rewrites.js';
import type { FunctionsChildHandle, SpawnFunctionsChildOptions } from '../../src/functions/spawn.js';

const openServers: Server[] = [];

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

async function startEchoBackend(label: string, expectedToken: string): Promise<number> {
  const server = createServer((req, res) => {
    if (req.headers[CHILD_TOKEN_HEADER] !== expectedToken) {
      res.writeHead(403).end('forbidden');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        backend: label,
        target: req.headers[FUNCTION_TARGET_HEADER],
        url: req.url,
      }),
    );
  });
  openServers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return (server.address() as AddressInfo).port;
}

function createHttpChildStub(options: {
  exportName: string;
  port: number;
  token: string;
  readyPromise?: Promise<unknown>;
  captureCrash?: (fn: (code: number) => void) => void;
  onStop?: () => void;
}): FunctionsChildHandle {
  const child = new EventEmitter() as unknown as ChildProcess;
  (child as unknown as { stdout: PassThrough; stderr: PassThrough }).stdout = new PassThrough();
  (child as unknown as { stdout: PassThrough; stderr: PassThrough }).stderr = new PassThrough();
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((res) => {
    resolveExit = res;
  });
  options.captureCrash?.(resolveExit);
  let isStopped = false;
  const ready = (options.readyPromise ??
    Promise.resolve({
      triggerCount: 0,
      unsupportedTriggers: [],
      exportNames: [options.exportName],
      http: {
        port: options.port,
        token: options.token,
        functions: [
          {
            exportName: options.exportName,
            regions: ['us-central1'],
            platform: 'gcfv2',
            privateInvoker: false,
            timeoutSeconds: null,
          },
        ],
      },
    })) as FunctionsChildHandle['ready'];
  return {
    child,
    ready,
    exited,
    async stop(): Promise<number> {
      if (!isStopped) {
        isStopped = true;
        options.onStop?.();
        resolveExit(0);
      }
      return exited;
    },
  };
}

describe('createFunctionsHttpGateway cross-codebase routing and Hosting rewrites', () => {
  test('routes emulator URLs and Hosting rewrites to each codebase backend and records codebase metadata', async () => {
    const portApi = await startEchoBackend('codebase-api', 'tok-api');
    const portAdmin = await startEchoBackend('codebase-admin', 'tok-admin');
    const sandbox = initializeSandbox();
    const served: FunctionsHttpRecord[] = [];

    const gateway = createFunctionsHttpGateway({
      projectId: 'demo-multi',
      initial: {
        kind: 'ready',
        http: {
          port: portApi,
          token: 'tok-api',
          functions: [
            {
              exportName: 'apiHandler',
              codebase: 'api',
              regions: ['us-central1'],
              platform: 'gcfv2',
              privateInvoker: false,
              timeoutSeconds: null,
            },
            {
              exportName: 'adminHandler',
              codebase: 'admin',
              regions: ['europe-west1'],
              platform: 'gcfv2',
              privateInvoker: false,
              timeoutSeconds: null,
            },
          ],
          backends: [
            {
              codebase: 'api',
              port: portApi,
              token: 'tok-api',
              functions: [
                {
                  exportName: 'apiHandler',
                  codebase: 'api',
                  regions: ['us-central1'],
                  platform: 'gcfv2',
                  privateInvoker: false,
                  timeoutSeconds: null,
                },
              ],
            },
            {
              codebase: 'admin',
              port: portAdmin,
              token: 'tok-admin',
              functions: [
                {
                  exportName: 'adminHandler',
                  codebase: 'admin',
                  regions: ['europe-west1'],
                  platform: 'gcfv2',
                  privateInvoker: false,
                  timeoutSeconds: null,
                },
              ],
            },
          ],
        },
      },
      rewrites: hostingRewrites({
        hosting: {
          rewrites: [
            { source: '/api/**', function: 'apiHandler' },
            { source: '/admin/**', function: { functionId: 'adminHandler', region: 'europe-west1' } },
          ],
        },
      }),
      sandbox,
      onServed: (rec) => served.push(rec),
      plane: 'pyric-sandbox',
    });

    const hostServer = createServer((req, res) => {
      void gateway.handle(req, res, () => true).then((handled) => {
        if (!handled) res.writeHead(404).end('not handled');
      });
    });
    openServers.push(hostServer);
    await new Promise<void>((resolveListen) => hostServer.listen(0, '127.0.0.1', resolveListen));
    const hostPort = (hostServer.address() as AddressInfo).port;

    try {
      const apiRewrite = await fetch(`http://127.0.0.1:${hostPort}/api/orders?page=2`);
      expect(apiRewrite.status).toBe(200);
      expect(await apiRewrite.json()).toEqual({
        backend: 'codebase-api',
        target: 'apiHandler',
        url: '/api/orders?page=2',
      });

      const adminRewrite = await fetch(`http://127.0.0.1:${hostPort}/admin/metrics`);
      expect(adminRewrite.status).toBe(200);
      expect(await adminRewrite.json()).toEqual({
        backend: 'codebase-admin',
        target: 'adminHandler',
        url: '/admin/metrics',
      });

      const directAdmin = await fetch(
        `http://127.0.0.1:${hostPort}/demo-multi/europe-west1/adminHandler/ping`,
      );
      expect(directAdmin.status).toBe(200);
      expect(await directAdmin.json()).toEqual({
        backend: 'codebase-admin',
        target: 'adminHandler',
        url: '/ping',
      });

      // Unknown emulator function lists valid functions across all codebases.
      const missing = await fetch(`http://127.0.0.1:${hostPort}/demo-multi/us-central1/nope`, {
        method: 'POST',
      });
      expect(missing.status).toBe(404);
      const missingText = await missing.text();
      expect(missingText).toContain('us-central1-apiHandler');
      expect(missingText).toContain('europe-west1-adminHandler');

      expect(served.map((r) => ({ exportName: r.exportName, codebase: r.codebase }))).toEqual([
        { exportName: 'apiHandler', codebase: 'api' },
        { exportName: 'adminHandler', codebase: 'admin' },
        { exportName: 'adminHandler', codebase: 'admin' },
      ]);

      const executions = listExecutions(sandbox);
      expect(executions.map((e) => ({ trigger: e.trigger, codebase: e.codebase }))).toEqual([
        { trigger: 'apiHandler', codebase: 'api' },
        { trigger: 'adminHandler', codebase: 'admin' },
        { trigger: 'adminHandler', codebase: 'admin' },
      ]);
    } finally {
      sandbox.dispose();
    }
  });

  test('refreshes merged HTTP backends on single-codebase crash restart without disrupting sibling codebases', async () => {
    const portApiV1 = await startEchoBackend('api-v1', 'tok-api-1');
    const portApiV2 = await startEchoBackend('api-v2', 'tok-api-2');
    const portAdmin = await startEchoBackend('admin-v1', 'tok-admin-1');

    let apiSpawnCount = 0;
    let triggerApiCrash: ((code: number) => void) | null = null;
    const events: FunctionsDevelopmentEvent[] = [];

    const gateway = createFunctionsHttpGateway({
      projectId: 'demo-crash',
      initial: { kind: 'starting' },
      plane: 'pyric-sandbox',
    });

    const runtime = createFunctionsDevelopmentRuntime({
      sourceDir: '/tmp/api',
      entry: '/tmp/api/index.js',
      codebases: [
        { codebase: 'api', sourceDir: '/tmp/api', entry: '/tmp/api/index.js' },
        { codebase: 'admin', sourceDir: '/tmp/admin', entry: '/tmp/admin/index.js' },
      ],
      baseEnv: {},
      serveUrl: 'http://127.0.0.1:4100',
      registerUrl: 'file:///register.js',
      instance: 'demo-default-rtdb',
      location: 'us-central1',
      projectId: 'demo-crash',
      readiness: { wait: () => Promise.resolve(true) },
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'restarted' && event.result.kind === 'ready') {
          gateway.update({ kind: 'ready', http: event.result.ready.http ?? null });
        }
      },
      spawn: (opts: SpawnFunctionsChildOptions) => {
        if (opts.codebase === 'api') {
          apiSpawnCount += 1;
          if (apiSpawnCount === 1) {
            return createHttpChildStub({
              exportName: 'apiFn',
              port: portApiV1,
              token: 'tok-api-1',
              captureCrash: (fn) => {
                triggerApiCrash = fn;
              },
            });
          }
          return createHttpChildStub({ exportName: 'apiFn', port: portApiV2, token: 'tok-api-2' });
        }
        return createHttpChildStub({ exportName: 'adminFn', port: portAdmin, token: 'tok-admin-1' });
      },
    });

    const hostServer = createServer((req, res) => {
      void gateway.handle(req, res, () => true).then((handled) => {
        if (!handled) res.writeHead(404).end('not handled');
      });
    });
    openServers.push(hostServer);
    await new Promise<void>((resolveListen) => hostServer.listen(0, '127.0.0.1', resolveListen));
    const hostPort = (hostServer.address() as AddressInfo).port;

    try {
      const started = await runtime.start();
      expect(started.kind).toBe('ready');
      if (started.kind !== 'ready') throw new Error('expected ready');
      gateway.update({ kind: 'ready', http: started.ready.http ?? null });

      const firstApi = await fetch(`http://127.0.0.1:${hostPort}/demo-crash/us-central1/apiFn`);
      expect(await firstApi.json()).toEqual({ backend: 'api-v1', target: 'apiFn', url: '/' });

      // Crash ONLY the api codebase; crash-restart controller schedules a restart and merges fresh port/token.
      triggerApiCrash!(1);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !events.some((e) => e.type === 'restarted')) {
        await Bun.sleep(25);
      }
      expect(events.some((e) => e.type === 'restarted')).toBe(true);

      const restartedApi = await fetch(`http://127.0.0.1:${hostPort}/demo-crash/us-central1/apiFn`);
      expect(await restartedApi.json()).toEqual({ backend: 'api-v2', target: 'apiFn', url: '/' });

      const unaffectedAdmin = await fetch(
        `http://127.0.0.1:${hostPort}/demo-crash/us-central1/adminFn`,
      );
      expect(await unaffectedAdmin.json()).toEqual({
        backend: 'admin-v1',
        target: 'adminFn',
        url: '/',
      });
    } finally {
      await runtime.close();
    }
  });

  test('evicts crashed sibling backend from merged ready and tears down all children on restart export collision', async () => {
    const events: FunctionsDevelopmentEvent[] = [];
    const stopped: string[] = [];
    let apiSpawn = 0;
    let adminSpawn = 0;
    let crashApi: ((code: number) => void) | null = null;
    let crashAdmin: ((code: number) => void) | null = null;
    let resolveAdminRestartReady: ((value: unknown) => void) | null = null;

    const makeStubChild = (
      label: string,
      exportName: string,
      port: number,
      readyPromise?: Promise<unknown>,
      captureCrash?: (fn: (code: number) => void) => void,
    ): FunctionsChildHandle =>
      createHttpChildStub({
        exportName,
        port,
        token: `tok-${label}`,
        readyPromise,
        captureCrash,
        onStop: () => stopped.push(label),
      });

    const runtime = createFunctionsDevelopmentRuntime({
      sourceDir: '/tmp/api',
      entry: '/tmp/api/index.js',
      codebases: [
        { codebase: 'api', sourceDir: '/tmp/api', entry: '/tmp/api/index.js' },
        { codebase: 'admin', sourceDir: '/tmp/admin', entry: '/tmp/admin/index.js' },
      ],
      baseEnv: {},
      serveUrl: 'http://127.0.0.1:4100',
      registerUrl: 'file:///register.js',
      instance: 'demo-default-rtdb',
      location: 'us-central1',
      projectId: 'demo-crash-evict',
      readiness: { wait: () => Promise.resolve(true) },
      onEvent: (event) => events.push(event),
      spawn: (opts: SpawnFunctionsChildOptions) => {
        if (opts.codebase === 'api') {
          apiSpawn += 1;
          if (apiSpawn === 1) {
            return makeStubChild('api-1', 'apiFn', 7101, undefined, (fn) => {
              crashApi = fn;
            });
          }
          if (apiSpawn === 2) {
            return makeStubChild('api-2', 'apiFn', 7102, undefined, (fn) => {
              crashApi = fn;
            });
          }
          // Third spawn introduces a duplicate export collision with `adminFn`.
          return makeStubChild('api-3', 'adminFn', 7103);
        }
        adminSpawn += 1;
        if (adminSpawn === 1) {
          return makeStubChild('admin-1', 'adminFn', 7201, undefined, (fn) => {
            crashAdmin = fn;
          });
        }
        const pendingReady = new Promise((res) => {
          resolveAdminRestartReady = res;
        });
        return makeStubChild('admin-2', 'adminFn', 7202, pendingReady);
      },
    });

    try {
      const started = await runtime.start();
      expect(started.kind).toBe('ready');

      // Crash BOTH admin (slow restart) and api (fast restart): when api finishes
      // restarting first, admin's stale dead port 7201 must NOT be merged back in.
      crashAdmin!(1);
      crashApi!(1);
      const deadline1 = Date.now() + 5_000;
      while (Date.now() < deadline1 && !events.some((e) => e.type === 'restarted')) {
        await Bun.sleep(25);
      }
      const firstRestart = events.find(
        (e): e is Extract<FunctionsDevelopmentEvent, { type: 'restarted' }> => e.type === 'restarted',
      );
      expect(firstRestart?.result.kind).toBe('ready');
      if (firstRestart?.result.kind === 'ready') {
        expect(firstRestart.result.ready.http?.backends?.map((b) => [b.codebase, b.port])).toEqual([
          ['api', 7102],
        ]);
      }

      // Now let admin-2 finish starting so both codebases are live again.
      resolveAdminRestartReady!({
        triggerCount: 0,
        unsupportedTriggers: [],
        exportNames: ['adminFn'],
        http: {
          port: 7202,
          token: 'tok-admin-2',
          functions: [
            {
              exportName: 'adminFn',
              regions: ['us-central1'],
              platform: 'gcfv2',
              privateInvoker: false,
              timeoutSeconds: null,
            },
          ],
        },
      });
      const deadline2 = Date.now() + 5_000;
      while (
        Date.now() < deadline2 &&
        events.filter((e) => e.type === 'restarted').length < 2
      ) {
        await Bun.sleep(25);
      }

      // Now crash api-2 so api-3 comes back exporting `adminFn` (collision):
      // all active children must be stopped and a failed restart emitted.
      crashApi!(1);
      const deadline3 = Date.now() + 5_000;
      while (
        Date.now() < deadline3 &&
        events.filter((e) => e.type === 'restarted').length < 3
      ) {
        await Bun.sleep(25);
      }
      const collisionEvent = events.filter(
        (e): e is Extract<FunctionsDevelopmentEvent, { type: 'restarted' }> => e.type === 'restarted',
      )[2];
      expect(collisionEvent?.result.kind).toBe('failed');
      if (collisionEvent?.result.kind === 'failed') {
        expect(collisionEvent.result.error.message).toContain('"adminFn"');
        expect(collisionEvent.result.error.message).toContain('"api"');
        expect(collisionEvent.result.error.message).toContain('"admin"');
      }
      expect(stopped).toContain('api-3');
      expect(stopped).toContain('admin-2');
    } finally {
      await runtime.close();
    }
  });

  test('publishPubSub fans out one shared messageId and publishTime across all codebases', async () => {
    const receivedByCodebase: Record<string, { messageId?: string; publishTime?: string; attributes?: Record<string, string> }> = {};

    const makePubSubChild = (codebase: string): FunctionsChildHandle => {
      const child = new EventEmitter() as unknown as ChildProcess & {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        connected: boolean;
        stdout: PassThrough;
        stderr: PassThrough;
        send: (msg: Record<string, unknown>, cb?: (err: Error | null) => void) => boolean;
      };
      child.exitCode = null;
      child.signalCode = null;
      child.connected = true;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.send = (msg, cb) => {
        cb?.(null);
        if (msg.type === 'publish-pubsub') {
          receivedByCodebase[codebase] = {
            messageId: msg.messageId as string | undefined,
            publishTime: msg.publishTime as string | undefined,
            attributes: msg.attributes as Record<string, string> | undefined,
          };
          queueMicrotask(() => {
            child.emit('message', {
              type: 'publish-pubsub-result',
              requestId: msg.requestId,
              outcome: 'ok',
              result: {
                topic: 'projects/demo-pubsub/topics/orders',
                messageId: msg.messageId,
                publishTime: msg.publishTime,
                deliveries: [
                  {
                    exportName: `${codebase}Subscriber`,
                    subscription: `sub-${codebase}`,
                    status: 'fulfilled',
                  },
                ],
              },
            });
          });
        }
        return true;
      };
      let resolveExit: (code: number) => void = () => undefined;
      const exited = new Promise<number>((res) => {
        resolveExit = res;
      });
      return {
        child,
        ready: Promise.resolve({
          triggerCount: 1,
          unsupportedTriggers: [],
          exportNames: [`${codebase}Subscriber`],
        }),
        exited,
        async stop(): Promise<number> {
          child.connected = false;
          resolveExit(0);
          return exited;
        },
      };
    };

    const runtime = createFunctionsDevelopmentRuntime({
      sourceDir: '/tmp/a',
      entry: '/tmp/a/index.js',
      codebases: [
        { codebase: 'a', sourceDir: '/tmp/a', entry: '/tmp/a/index.js' },
        { codebase: 'b', sourceDir: '/tmp/b', entry: '/tmp/b/index.js' },
      ],
      baseEnv: {},
      serveUrl: 'http://127.0.0.1:4100',
      registerUrl: 'file:///register.js',
      instance: 'demo-default-rtdb',
      location: 'us-central1',
      projectId: 'demo-pubsub',
      readiness: { wait: () => Promise.resolve(true) },
      spawn: (opts: SpawnFunctionsChildOptions) => makePubSubChild(opts.codebase ?? 'unknown'),
    });

    try {
      const started = await runtime.start();
      expect(started.kind).toBe('ready');

      const published = await runtime.publishPubSub('orders', { id: 1 }, { env: 'staging' });
      expect(receivedByCodebase.a?.messageId).toBeString();
      expect(receivedByCodebase.a?.messageId).toBe(receivedByCodebase.b?.messageId);
      expect(receivedByCodebase.a?.publishTime).toBe(receivedByCodebase.b?.publishTime);
      expect(receivedByCodebase.a?.attributes).toEqual({ env: 'staging' });
      expect(receivedByCodebase.b?.attributes).toEqual({ env: 'staging' });
      expect(published.messageId).toBe(receivedByCodebase.a!.messageId!);
      expect(published.publishTime).toBe(receivedByCodebase.a!.publishTime!);
      expect(published.deliveries).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });
});
