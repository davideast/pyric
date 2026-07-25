import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'bun:test';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import {
  createViteSandboxGeneration,
  type ViteSandboxGenerationDependencies,
  type ViteSandboxGenerationInput,
} from '../../src/serve/vite-sandbox-generation.js';
import type { BridgeMount } from '../../src/serve/bridge-mount.js';
import { SandboxSeedError, type SandboxSession } from '../../src/serve/sandbox-session.js';

type Middleware = (
  req: IncomingMessage & { originalUrl?: string },
  res: ServerResponse,
  next: () => void,
) => void;

function harness(options: { functions?: boolean; rulesFile?: string | null; databaseRulesFile?: string | null } = {}) {
  const events: string[] = [];
  const warnings: string[] = [];
  const watcher = new EventEmitter() as EventEmitter & { add(path: string): void };
  watcher.add = (file) => { events.push(`watch:${file}`); };
  const httpServer = new EventEmitter() as EventEmitter & Pick<HttpServer, 'address'>;
  httpServer.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 5173 });
  let middleware: Middleware | null = null;
  let handled = 0;

  const session: SandboxSession = {
    summary: {
      rules: {
        firestore: { sourcePath: options.rulesFile ?? null, hash: null },
        database: { sourcePath: options.databaseRulesFile ?? null, hash: null },
        storage: { sourcePath: null, hash: null },
      },
      persistence: null,
      capturePath: null,
      seedLabel: null,
      seedStaged: false,
      studioMounted: false,
    },
    payload: () => ({}) as ReturnType<SandboxSession['payload']>,
    handle: () => { handled += 1; return false; },
    reloadFirestoreRules: async () => ({ kind: 'not-configured' }),
    reloadDatabaseRules: async () => ({ kind: 'not-configured' }),
    close: async () => { events.push('close:session'); },
  };
  const bridgeAttachment = { close: async () => { events.push('close:bridge-host'); } };
  const bridge: BridgeMount = {
    instanceId: 'bridge-id',
    project: 'demo-project',
    handler: async () => false,
    attachHost: () => bridgeAttachment,
    close: async () => { events.push('close:bridge'); },
    sandboxConnected: () => false,
    wsUrl: ({ host, port }) => `ws://${host}:${port}/__pyric/sandbox`,
    mcpUrl: ({ host, port }) => `http://${host}:${port}/__pyric/mcp`,
  };

  const dependencies: Partial<ViteSandboxGenerationDependencies> = {
    readFirebaseJson: async () => null,
    readFirebaseRc: async () => ({ projects: { default: 'demo-project' } }),
    resolveRulesConfig: () => null,
    prepareWorker: async () => {},
    workerStatus: () => ({ sdkDir: '/sdk', ready: true, epoch: 'worker-v1' }),
    discoverFunctionsProject: () => options.functions
      ? ({ sourceDir: '/project/functions', entry: '/project/functions/index.js' } as never)
      : null,
    resolveSiteUiDir: () => '/site',
    createBridge: () => bridge,
    createSession: async () => session,
    attachFunctions: () => ({ close: async () => { events.push('close:functions'); } }),
    registerModuleUrl: () => 'file:///register.js',
    fileExists: () => false,
  };

  const input: ViteSandboxGenerationInput = {
    server: {
      config: {
        root: '/project',
        server: { host: 'localhost', allowedHosts: [] },
        logger: {
          info: (message: string) => { events.push(`info:${message}`); },
          warn: (message: string) => { warnings.push(message); },
          error: () => {},
        },
      },
      middlewares: {
        use(route: string, handler: Middleware) {
          if (route === '/__pyric') middleware = handler;
        },
      },
      watcher,
      httpServer,
    } as never,
    projectDir: '/project',
    cliRoot: '/cli',
    workerRuntime: {
      prepare: async () => {},
      status: () => ({ sdkDir: '/sdk', ready: true, epoch: 'worker-v1' }),
      headTag: () => '',
    },
    options: {
      bridge: options.functions ? null : {},
      ui: false,
      functions: options.functions ? {} : false,
    },
    ai: { engineWire: undefined, proxyUpstream: undefined },
  };

  return {
    input,
    dependencies,
    events,
    warnings,
    watcher,
    httpServer,
    middleware: () => middleware,
    handled: () => handled,
  };
}

describe('active Vite sandbox generation', () => {
  it('owns one generation and closes every resource once in dependency order', async () => {
    const h = harness({ functions: true, rulesFile: '/project/firestore.rules' });
    const generation = await createViteSandboxGeneration(h.input, h.dependencies);

    expect(h.watcher.listenerCount('change')).toBe(1);
    expect(h.httpServer.listenerCount('close')).toBe(1);
    const firstClose = generation.close();
    expect(generation.close()).toBe(firstClose);
    await firstClose;

    expect(h.events.filter((event) => event.startsWith('close:'))).toEqual([
      'close:functions',
      'close:bridge-host',
      'close:bridge',
      'close:session',
    ]);
    expect(h.watcher.listenerCount('change')).toBe(0);
    expect(h.httpServer.listenerCount('close')).toBe(0);
  });

  it('deactivates its permanent Connect layer when the generation closes', async () => {
    const h = harness();
    const generation = await createViteSandboxGeneration(h.input, h.dependencies);
    const middleware = h.middleware();
    if (!middleware) throw new Error('generation did not mount middleware');
    await generation.close();

    let nextCalls = 0;
    middleware(
      { headers: { host: 'localhost:5173' }, url: '/init.json' } as IncomingMessage,
      {} as ServerResponse,
      () => { nextCalls += 1; },
    );
    expect(nextCalls).toBe(1);
    expect(h.handled()).toBe(0);
  });

  it('rolls back already-created resources when a later attachment fails', async () => {
    const h = harness({ functions: true, rulesFile: '/project/firestore.rules' });
    h.dependencies.attachFunctions = () => { throw new Error('functions attach failed'); };

    await expect(createViteSandboxGeneration(h.input, h.dependencies)).rejects.toThrow(
      'functions attach failed',
    );
    expect(h.events.filter((event) => event.startsWith('close:'))).toEqual([
      'close:bridge-host',
      'close:bridge',
      'close:session',
    ]);
    expect(h.watcher.listenerCount('change')).toBe(0);
    expect(h.httpServer.listenerCount('close')).toBe(0);
  });

  it('converges HTTP close and explicit close on the same idempotent cleanup', async () => {
    const h = harness({ functions: true });
    const generation = await createViteSandboxGeneration(h.input, h.dependencies);

    h.httpServer.emit('close');
    await generation.close();
    expect(h.events.filter((event) => event.startsWith('close:'))).toEqual([
      'close:functions',
      'close:bridge-host',
      'close:bridge',
      'close:session',
    ]);
  });

  it('warns and continues with an in-page fallback when worker preparation fails', async () => {
    const h = harness();
    h.dependencies.prepareWorker = async () => { throw new Error('bundle failed'); };

    const generation = await createViteSandboxGeneration(h.input, h.dependencies);
    expect(h.warnings).toEqual([
      '  ⚠ [pyric] SharedWorker bundle failed — using the in-page sandbox (single-tab, ephemeral): bundle failed',
    ]);
    await generation.close();
  });

  it('preserves the Vite adapter seed-error messages while rolling back the bridge', async () => {
    const readFailure = harness();
    readFailure.dependencies.createSession = async () => {
      throw new SandboxSeedError('read', '/project/seed.json', 'permission denied');
    };
    await expect(
      createViteSandboxGeneration(readFailure.input, readFailure.dependencies),
    ).rejects.toThrow(
      '@pyric/cli/vite: failed to read seed /project/seed.json: permission denied',
    );
    expect(readFailure.events).toContain('close:bridge');

    const shapeFailure = harness();
    shapeFailure.dependencies.createSession = async () => {
      throw new SandboxSeedError('shape', '/project/seed.json', 'array');
    };
    await expect(
      createViteSandboxGeneration(shapeFailure.input, shapeFailure.dependencies),
    ).rejects.toThrow(
      '@pyric/cli/vite: seed must be a JSON object of "collection/doc" → fields',
    );
    expect(shapeFailure.events).toContain('close:bridge');
  });

  it('watches the configured Realtime Database rules file in Vite dev server', async () => {
    const h = harness({ databaseRulesFile: '/project/database.rules.json' });
    const generation = await createViteSandboxGeneration(h.input, h.dependencies);
    expect(h.events).toContain('watch:/project/database.rules.json');
    await generation.close();
  });
});
