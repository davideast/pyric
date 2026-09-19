import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Server } from 'node:http';
import type { ViteDevServer } from 'vite';
import type {
  FunctionsDevelopmentRuntime,
  FunctionsDevelopmentRuntimeOptions,
} from '../../src/functions-rtdb/development-runtime.js';
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
      watcher: watcher as unknown as ViteDevServer['watcher'],
      logger: {
        info: (message) => info.push(message),
        warn: (message) => warnings.push(message),
        error: (message) => errors.push(message),
      } as unknown as ViteDevServer['config']['logger'],
      bridge: { sandboxConnected: () => true } as unknown as BridgeMount,
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
    expect(info.some((message) => message.includes('1 onValueCreated trigger'))).toBe(true);

    watcher.emit('change', '/elsewhere/index.js');
    watcher.emit('add', path.join(sourceDir, 'node_modules/pkg/index.js'));
    watcher.emit('unlink', path.join(sourceDir, 'index.js'));
    watcher.emit('change', path.join(sourceDir, 'other.js'));
    await Bun.sleep(350);
    expect(reloads).toBe(1);
    expect(info.some((message) => message.includes('functions reloaded (2 triggers)'))).toBe(true);

    runtimeOptions?.onEvent?.({ type: 'output', stream: 'stderr', line: '[functions] warning\n' });
    runtimeOptions?.onEvent?.({ type: 'unexpected-exit', code: 7 });
    expect(warnings).toContain('[functions] warning');
    expect(errors.some((message) => message.includes('exited unexpectedly (code 7)'))).toBe(true);

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
      watcher: watcher as unknown as ViteDevServer['watcher'],
      logger: { info() {}, warn() {}, error() {} } as unknown as ViteDevServer['config']['logger'],
      bridge: { sandboxConnected: () => false } as unknown as BridgeMount,
      baseEnv: {},
      registerUrl: 'file:///register.js',
    });

    expect(watcher.added).toHaveLength(0);
    expect(watcher.eventNames()).toHaveLength(0);
    await attachment.close();
  });
});
