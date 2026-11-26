import { build } from 'esbuild';
import { dirname } from 'node:path';
import { createContext, runInNewContext, SourceTextModule } from 'node:vm';
import { JSDOM } from 'jsdom';
import type { ServiceWorkerChannelMessage } from '../../../src/serve/worker/service-worker-channel.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
const entry = new URL('../../../src/serve/entries/worker-runtime.ts', import.meta.url).pathname;

function formatConsoleArg(arg: unknown): string {
  if (arg instanceof Error) return arg.message;
  return String(arg);
}

const bundledCodeCache = new Map<string, Promise<string>>();

function bundleWorkerRuntimeRealm(
  pageSdk: boolean,
  define: Record<string, string>,
): Promise<string> {
  const key = JSON.stringify({ pageSdk, define });
  const cached = bundledCodeCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let pageSdkExports = '';
  if (pageSdk) {
    pageSdkExports = `export * as firestore from './firestore.js';
      export * as auth from './auth.js';
      export * as database from './database.js';
      export * as app from './app.js';`;
  }
  const pending = build({
    stdin: {
      contents: `${pageSdkExports}export * from './worker-runtime.js';
      export { registerActiveAuth } from './active-auth.js';
      export { getAuth } from '../worker/client.js';
      export { callerFrameFromStack } from 'pyric/sandbox/internal';`,
      resolveDir: dirname(entry),
    },
    bundle: true,
    platform: 'browser',
    format: pageSdk ? 'esm' : 'iife',
    globalName: 'entry',
    target: pageSdk ? 'es2022' : 'es2020',
    write: false,
    logLevel: 'silent',
    define,
  }).then(
    (result) => {
      const code = result.outputFiles?.[0]?.text;
      if (typeof code !== 'string') {
        throw new Error('esbuild produced no bundled output for worker-runtime.');
      }
      return code;
    },
    (error: unknown) => {
      bundledCodeCache.delete(key);
      throw error;
    },
  );
  bundledCodeCache.set(key, pending);
  return pending;
}

// Browser transports are the I/O boundary. The bundled entry and its clients
// run unchanged in a fresh realm for each case.
export async function runtimeRealm(options: {
  sharedWorker?: boolean;
  blockedWorker?: boolean;
  broadcastChannel?: boolean;
  serviceWorker?: boolean;
  forceInPage?: boolean;
  pageSdk?: boolean;
  hosted?: boolean;
  hostedWithoutIdentity?: boolean;
  unstamped?: boolean;
  inlinedSelection?: object;
  stamped?: boolean;
  failedSockets?: number;
  owners?: { skip?: string[]; frames?: number };
  captureConsoleErrors?: boolean;
  captureConsoleWarnings?: boolean;
} = {}) {
  const needsPage = Boolean(
    options.pageSdk || options.inlinedSelection || options.unstamped || options.hostedWithoutIdentity,
  ) && !options.serviceWorker;
  let hostMeta = '';
  if (options.hostedWithoutIdentity) {
    hostMeta = '<meta name="pyric-sandbox-host" content="node" data-pyric-serve>';
  }
  let page: JSDOM | undefined;
  if (needsPage) {
    page = new JSDOM(
      `<html><head>${hostMeta}<meta name="pyric-runtime-chip" content="off"></head><body></body></html>`,
      { url: 'https://app.example/' },
    );
  }
  const define: Record<string, string> = {};
  if (options.inlinedSelection) {
    // As `withPyric` has Next inline it (next/runtime-env.ts).
    define['process.env.NEXT_PUBLIC_PYRIC_WORKER_INIT'] = JSON.stringify(
      JSON.stringify(options.inlinedSelection),
    );
  }
  const bundledCode = await bundleWorkerRuntimeRealm(Boolean(options.pageSdk), define);

  const connections: string[] = [];
  let socketsToFail = options.failedSockets ?? 0;
  const messages: InboundMessage[] = [];
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  let initFetchCount = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let resolveInitResponse: ((res: Response) => void) | null = null;
  const response = new Promise<Response>((resolve) => {
    resolveInitResponse = resolve;
  });
  class Port {
    onmessage: ((event: MessageEvent) => void) | null = null;
    postMessage(message: InboundMessage) {
      messages.push(message);
      if (!options.pageSdk) return;
      if (message.t !== 'op' && message.t !== 'disconnect') return;
      let value: unknown = {};
      if (message.t === 'op' && message.method === 'getRuntimeEpoch') value = { version: 'dev' };
      if (message.t === 'op' && message.method === 'getDoc') value = { id: 'example', path: message.path, exists: false };
      queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: { t: 'res', id: message.id, ok: true, value } })));
    }
    start() {}
    close() {}
  }
  let workerInitGlobal: Record<string, unknown> | undefined;
  const omitWorkerInit = Boolean(options.serviceWorker || options.unstamped || (options.inlinedSelection && !options.stamped));
  if (!omitWorkerInit) {
    if (options.hostedWithoutIdentity) {
      workerInitGlobal = { hosted: true, projectKey: null, bridgeUrl: null };
    } else {
      workerInitGlobal = {
        hosted: options.hosted ?? false,
        projectKey: options.hosted ? 'orbit' : null,
        bridgeUrl: options.hosted ? '/__pyric/sandbox' : null,
      };
      if (options.owners) workerInitGlobal.owners = options.owners;
    }
  }
  const realmConsole: Console = {
    ...console,
    error: (...args: unknown[]) => {
      if (options.captureConsoleErrors) {
        consoleErrors.push(args.map(formatConsoleArg).join(' '));
        return;
      }
      console.error(...args);
    },
    warn: (...args: unknown[]) => {
      if (options.captureConsoleWarnings) {
        consoleWarnings.push(args.map(formatConsoleArg).join(' '));
        return;
      }
      console.warn(...args);
    },
  };
  const globals: Record<string, unknown> = {
    console: realmConsole, TextEncoder, TextDecoder, URL, AbortController, MessageEvent,
    crypto, performance, queueMicrotask,
    location: new URL('https://app.example/'),
    fetch: (url: string) => {
      if (url === '/__pyric/init.json') {
        initFetchCount += 1;
        return response;
      }
      return Promise.resolve(new Response());
    },
    setTimeout: (callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms); timers.add(timer); return timer;
    },
    setInterval: (callback: () => void, ms: number) => {
      const timer = setInterval(callback, ms); timers.add(timer); return timer;
    },
    clearTimeout, clearInterval,
    __PYRIC_WORKER_INIT__: workerInitGlobal,
    __PYRIC_FORCE_INPAGE__: options.forceInPage,
    WebSocket: class {
      static OPEN = 1;
      readyState = 0;
      listeners = new Map<string, (event: MessageEvent<string>) => void>();
      backend = new Port();
      constructor(url: string) {
        connections.push(url);
        const failsToOpen = socketsToFail > 0;
        if (failsToOpen) {
          socketsToFail -= 1;
          queueMicrotask(() => {
            this.readyState = 3;
            this.listeners.get('close')?.(Object.assign(new MessageEvent('close'), { code: 1006 }));
          });
          return;
        }
        this.backend.onmessage = event => this.receive({ type: 'worker-message-result', message: event.data });
        if (options.pageSdk || options.failedSockets !== undefined) queueMicrotask(() => { this.readyState = 1; this.listeners.get('open')?.(new MessageEvent('open')); });
      }
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
      receive(message: BridgeMessage) {
        queueMicrotask(() => this.listeners.get('message')?.(new MessageEvent('message', { data: JSON.stringify(message) })));
      }
      send(encoded: string) {
        const message = JSON.parse(encoded) as BridgeMessage;
        if (message.type === 'attach') this.receive({ type: 'attach-ack', protocol: 1, bridgeVersion: 'dev', peerConnected: true, clientSessionId: 'test-client', projectKey: 'orbit', capabilities: ['worker-port'] });
        if (message.type === 'worker-message') this.backend.postMessage(message.message);
      }
      close() { this.listeners.clear(); }
    },
  };
  if (options.serviceWorker) {
    globals.ServiceWorkerGlobalScope = class {};
    globals.registration = { scope: '/' };
    globals.clients = {};
  } else {
    globals.window = page?.window ?? {};
  }
  if (page) {
    globals.document = page.window.document;
    globals.HTMLElement = page.window.HTMLElement;
    globals.CustomEvent = page.window.CustomEvent;
    globals.MutationObserver = page.window.MutationObserver;
    globals.localStorage = page.window.localStorage;
  }
  if (options.sharedWorker) {
    globals.SharedWorker = class {
      port = new Port();
      constructor() {
        if (options.blockedWorker) throw new Error('Blocked by browser policy');
        connections.push('shared-worker');
      }
      addEventListener() {}
    };
  }
  const includeBroadcastChannel = options.broadcastChannel !== false;
  if (includeBroadcastChannel) {
    globals.BroadcastChannel = class {
      onmessage: ((event: MessageEvent<ServiceWorkerChannelMessage>) => void) | null = null;
      backend = new Port();
      constructor() { connections.push('service-worker-relay'); }
      postMessage(envelope: ServiceWorkerChannelMessage) {
        if (envelope.direction !== 'host' || envelope.phase !== 'message') return;
        this.backend.onmessage = event => this.onmessage?.(new MessageEvent('message', { data: { direction: 'client', clientId: envelope.clientId, sessionId: envelope.sessionId, message: event.data } }));
        this.backend.postMessage(envelope.message);
      }
      close() {}
    };
  }
  const context = createContext(globals);
  let evaluation: Promise<void> = Promise.resolve();
  let exports: unknown;
  if (options.pageSdk) {
    const module = new SourceTextModule(bundledCode, { context });
    await module.link(() => { throw new Error('The SDK realm must be bundled.'); });
    evaluation = module.evaluate();
    exports = module.namespace;
  } else {
    runInNewContext(bundledCode, context);
    exports = runInNewContext('entry', context);
  }
  const runtime = exports as typeof import('../../../src/serve/entries/worker-runtime.js') & Pick<typeof import('pyric/sandbox/internal'), 'callerFrameFromStack'>;
  const authExports = exports as {
    registerActiveAuth: (auth: unknown) => () => void;
    getAuth: (db: unknown) => unknown;
    workerDb: unknown;
  };
  return {
    runtime, connections, messages, evaluation, consoleErrors, consoleWarnings,
    sdk: exports as { firestore: typeof import('../../../src/serve/entries/firestore.js'); auth: typeof import('../../../src/serve/entries/auth.js'); database: typeof import('../../../src/serve/entries/database.js'); app: typeof import('../../../src/serve/entries/app.js') },
    registerAuth: (): (() => void) => authExports.registerActiveAuth(authExports.getAuth(authExports.workerDb)),
    status: () => runInNewContext('__pyricRuntime.getSnapshot()', globals),
    respond: (payload: object) => resolveInitResponse?.(Response.json(payload)),
    respondRaw: (res: Response) => resolveInitResponse?.(res),
    initFetches: () => initFetchCount,
    document: page?.window.document,
    workerInit: () => (context as { __PYRIC_WORKER_INIT__?: unknown }).__PYRIC_WORKER_INIT__,
    dispose() {
      runtime.presenceSession?.stop();
      runtime.workerDb?.port.close();
      page?.window.close();
      for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    },
  };
}
