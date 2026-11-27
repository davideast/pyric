import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type {
  FunctionsDevelopmentRuntime,
  FunctionsDevelopmentRuntimeOptions,
} from '../../src/functions/development-runtime.js';
import type { BridgeMount } from '../../src/serve/bridge-mount.js';
import { attachViteFunctionsDevelopment } from '../../src/serve/vite-functions-development.js';

class FakeHttpServer extends EventEmitter {
  listening = false;

  address(): { port: number } {
    return { port: 5173 };
  }
}

class FakeWatcher extends EventEmitter {
  added: string[] = [];

  add(file: string): this {
    this.added.push(file);
    return this;
  }
}

describe('Vite Functions development adapter', () => {
  it('adapts listening, watcher events, logging, and explicit disposal', async () => {
    const sourceDir = path.resolve('/project/functions');
    const httpServer = new FakeHttpServer();
    const watcher = new FakeWatcher();
    const info: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    let runtimeOptions: FunctionsDevelopmentRuntimeOptions | undefined;
    let starts = 0;
    let reloads = 0;
    let closes = 0;
    const runtime: FunctionsDevelopmentRuntime = {
      async start() {
        starts += 1;
        return { kind: 'ready', ready: { triggerCount: 1, unsupportedTriggers: [] } };
      },
      async reload() {
        reloads += 1;
        return { kind: 'ready', ready: { triggerCount: 2, unsupportedTriggers: [] } };
      },
      async close() { closes += 1; },
    };

    const attachment = attachViteFunctionsDevelopment({
      cwd: '/project',
      project: { sourceDir, entry: path.join(sourceDir, 'index.js') },
      projectId: 'demo-project',
      host: 'localhost',
      httpServer: httpServer as unknown as Server,
      middlewares: { use: () => undefined },
      isAllowedRequest: () => true,
      allowsAppOrigin: () => true,
      watcher: watcher as unknown as ViteDevServer['watcher'],
      logger: {
        info: (message) => info.push(message),
        warn: (message) => warnings.push(message),
        error: (message) => errors.push(message),
      } as unknown as ViteDevServer['config']['logger'],
      bridge: { sandboxConnected: () => true, onSandboxPeerConnected: () => () => {} } as unknown as BridgeMount,
      baseEnv: {},
      registerUrl: 'file:///register.js',
      runtimeFactory: (options) => { runtimeOptions = options; return runtime; },
    });

    expect(watcher.added).toEqual([sourceDir]);
    expect(watcher.listenerCount('change')).toBe(1);
    expect(watcher.listenerCount('add')).toBe(1);
    expect(watcher.listenerCount('unlink')).toBe(1);
    expect(httpServer.listenerCount('listening')).toBe(1);
    expect(starts).toBe(0);

    httpServer.listening = true;
    httpServer.emit('listening');
    await Promise.resolve();
    expect(starts).toBe(1);
    expect(runtimeOptions).toMatchObject({
      serveUrl: 'http://localhost:5173',
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
    });
    expect(info.some((message) => message.includes('functions 1 trigger from '))).toBe(true);

    watcher.emit('change', '/elsewhere/index.js');
    watcher.emit('add', path.join(sourceDir, 'node_modules/pkg/index.js'));
    watcher.emit('unlink', path.join(sourceDir, 'index.js'));
    watcher.emit('change', path.join(sourceDir, 'other.js'));
    await Bun.sleep(350);
    expect(reloads).toBe(1);
    expect(info.some((message) => message.includes('functions reloaded (2 triggers)'))).toBe(true);

    runtimeOptions?.onEvent?.({ type: 'output', stream: 'stderr', line: '[functions] warning\n' });
    runtimeOptions?.onEvent?.({ type: 'unexpected-exit', code: 7 });
    runtimeOptions?.onEvent?.({ type: 'starting', mode: 'reload' });
    runtimeOptions?.onEvent?.({
      type: 'restarted',
      result: { kind: 'ready', ready: { triggerCount: 1, unsupportedTriggers: [] } },
    });
    expect(warnings).toContain('[functions] warning');
    expect(errors.some((message) => message.includes('exited unexpectedly (code 7)'))).toBe(true);
    expect(info.some((message) => message.includes('functions restarted'))).toBe(true);

    await attachment.close();
    await attachment.close();
    expect(closes).toBe(1);
    expect(httpServer.listenerCount('listening')).toBe(0);
    expect(watcher.listenerCount('change')).toBe(0);
    expect(watcher.listenerCount('add')).toBe(0);
    expect(watcher.listenerCount('unlink')).toBe(0);
  });

  it('does not register watchers when watch is disabled', async () => {
    const httpServer = new FakeHttpServer();
    const watcher = new FakeWatcher();
    const attachment = attachViteFunctionsDevelopment({
      cwd: '/project',
      project: { sourceDir: '/project/functions', entry: '/project/functions/index.js' },
      projectId: 'demo-project',
      host: 'localhost',
      watch: false,
      httpServer: httpServer as unknown as Server,
      middlewares: { use: () => undefined },
      isAllowedRequest: () => true,
      allowsAppOrigin: () => true,
      watcher: watcher as unknown as ViteDevServer['watcher'],
      logger: { info() {}, warn() {}, error() {} } as unknown as ViteDevServer['config']['logger'],
      bridge: { sandboxConnected: () => false, onSandboxPeerConnected: () => () => {} } as unknown as BridgeMount,
      baseEnv: {},
      registerUrl: 'file:///register.js',
    });

    expect(watcher.added).toHaveLength(0);
    expect(watcher.eventNames()).toHaveLength(0);
    await attachment.close();
  });

  it('normalizes wildcard bind hosts to localhost and brackets bare IPv6 in serveUrl', async () => {
    const cases: Array<{ host: string; expectedServeUrl: string }> = [
      { host: '0.0.0.0', expectedServeUrl: 'http://localhost:5173' },
      { host: '::', expectedServeUrl: 'http://localhost:5173' },
      { host: '[::]', expectedServeUrl: 'http://localhost:5173' },
      { host: '::1', expectedServeUrl: 'http://[::1]:5173' },
    ];
    for (const testCase of cases) {
      const httpServer = new FakeHttpServer();
      const watcher = new FakeWatcher();
      let runtimeOptions: FunctionsDevelopmentRuntimeOptions | undefined;
      const runtime: FunctionsDevelopmentRuntime = {
        async start() {
          return { kind: 'ready', ready: { triggerCount: 0, unsupportedTriggers: [] } };
        },
        async reload() {
          return { kind: 'ready', ready: { triggerCount: 0, unsupportedTriggers: [] } };
        },
        async close() {},
      };
      const attachment = attachViteFunctionsDevelopment({
        cwd: '/project',
        project: { sourceDir: '/project/functions', entry: '/project/functions/index.js' },
        projectId: 'demo-project',
        host: testCase.host,
        watch: false,
        httpServer: httpServer as unknown as Server,
        middlewares: { use: () => undefined },
        isAllowedRequest: () => true,
        allowsAppOrigin: () => true,
        watcher: watcher as unknown as ViteDevServer['watcher'],
        logger: { info() {}, warn() {}, error() {} } as unknown as ViteDevServer['config']['logger'],
        bridge: { sandboxConnected: () => true, onSandboxPeerConnected: () => () => {} } as unknown as BridgeMount,
        baseEnv: {},
        registerUrl: 'file:///register.js',
        runtimeFactory: (options) => {
          runtimeOptions = options;
          return runtime;
        },
      });
      httpServer.listening = true;
      httpServer.emit('listening');
      await Promise.resolve();
      expect(runtimeOptions?.serveUrl, `host=${testCase.host}`).toBe(testCase.expectedServeUrl);
      await attachment.close();
    }
  });
});

it('retries after reconnect even during startup, without duplicate starts or listeners after close', async () => {
  const httpServer = new FakeHttpServer();
  httpServer.listening = true;
  const watcher = new FakeWatcher();
  const connected = new Set<() => void>();
  let finishFirst!: (result: { kind: 'failed'; error: Error }) => void;
  const initial = new Promise<{ kind: 'failed'; error: Error }>(resolve => { finishFirst = resolve; });
  let starts = 0;
  let closes = 0;
  const attachment = attachViteFunctionsDevelopment({
    cwd: '/project',
    project: { sourceDir: '/project/functions', entry: '/project/functions/index.js' },
    projectId: 'demo', host: 'localhost', baseEnv: {}, registerUrl: 'file:///register.js',
    httpServer: httpServer as Server,
    middlewares: { use: () => undefined },
    isAllowedRequest: () => true,
    allowsAppOrigin: () => true,
    watcher: watcher as ViteDevServer['watcher'],
    logger: { info() {}, warn() {}, error() {} } as ViteDevServer['config']['logger'],
    bridge: {
      sandboxConnected: () => true,
      onSandboxPeerConnected(listener: () => void) {
        connected.add(listener);
        return () => connected.delete(listener);
      },
    } as BridgeMount,
    runtimeFactory: () => ({
      async start() {
        starts += 1;
        const firstAttempt = starts === 1;
        if (firstAttempt) return initial;
        return { kind: 'ready', ready: { triggerCount: 1, unsupportedTriggers: [] } };
      },
      async reload() { throw new Error('Not a source reload'); },
      async close() { closes += 1; },
    }),
  });
  try {
    expect(starts).toBe(1);
    for (const listener of connected) { listener(); listener(); }
    expect(starts).toBe(1);
    finishFirst({ kind: 'failed', error: new Error('browser disconnected') });
    await Bun.sleep(0);
    expect(starts).toBe(2);
    for (const listener of connected) listener();
    await Bun.sleep(0);
    expect(starts).toBe(2);
  } finally { await attachment.close(); }
  expect(connected.size).toBe(0);
  expect(closes).toBe(1);
});

it('transitions the HTTP gateway immediately to exited (503) without blocking when rapid crash restarts pause (#1942)', async () => {
  const watcher = new FakeWatcher();
  const errors: string[] = [];
  let runtimeOptions: FunctionsDevelopmentRuntimeOptions | undefined;
  let middleware: ((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void) | undefined;

  const server = createServer((req, res) => {
    if (middleware) {
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end('not handled');
      });
      return;
    }
    res.statusCode = 404;
    res.end('no middleware');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected TCP server address');
  }

  const attachment = attachViteFunctionsDevelopment({
    cwd: '/project',
    project: { sourceDir: '/project/functions', entry: '/project/functions/index.js' },
    projectId: 'demo',
    host: '127.0.0.1',
    watch: false,
    httpServer: server,
    middlewares: {
      use(handler) {
        middleware = handler;
      },
    },
    isAllowedRequest: () => true,
    allowsAppOrigin: () => true,
    watcher: watcher as unknown as ViteDevServer['watcher'],
    logger: {
      info() {},
      warn() {},
      error: (msg) => errors.push(msg),
    } as unknown as ViteDevServer['config']['logger'],
    bridge: { sandboxConnected: () => true, onSandboxPeerConnected: () => () => {} } as unknown as BridgeMount,
    baseEnv: {},
    registerUrl: 'file:///register.js',
    runtimeFactory: (options) => {
      runtimeOptions = options;
      return {
        async start() {
          return {
            kind: 'ready',
            ready: {
              triggerCount: 0,
              unsupportedTriggers: [],
              http: {
                port: 1,
                token: 'token',
                functions: [{
                  exportName: 'hello',
                  regions: ['us-central1'],
                  platform: 'gcfv2',
                  privateInvoker: false,
                  timeoutSeconds: null,
                }],
              },
            },
          };
        },
        async reload() {
          return { kind: 'ready', ready: { triggerCount: 0, unsupportedTriggers: [] } };
        },
        async close() {},
      };
    },
  });

  try {
    await Bun.sleep(10);
    runtimeOptions?.onEvent?.({ type: 'unexpected-exit', code: 1, restarting: false });
    const startedAt = performance.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/demo/us-central1/hello`);
    const elapsedMs = performance.now() - startedAt;
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('The Functions child exited (code 1)');
    expect(elapsedMs).toBeLessThan(1_000);
    expect(errors.some((line) => line.includes('automatic restart paused after repeated rapid exits'))).toBe(true);
  } finally {
    await attachment.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
