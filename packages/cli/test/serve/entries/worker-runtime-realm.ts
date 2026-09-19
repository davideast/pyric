import { build } from 'esbuild';
import { dirname } from 'node:path';
import type { ServiceWorkerChannelMessage } from '../../../src/serve/worker/service-worker-channel.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
const entry = new URL('../../../src/serve/entries/worker-runtime.ts', import.meta.url).pathname;

// Browser transports are the I/O boundary. The bundled entry and its clients
// run unchanged in a fresh realm for each case.
export async function runtimeRealm(options: { sharedWorker?: boolean; blockedWorker?: boolean; serviceWorker?: boolean; forceInPage?: boolean; pageSdk?: boolean; hosted?: boolean } = {}) {
  const { runInNewContext, createContext, SourceTextModule } = await import('node:vm');
  const { JSDOM } = await import('jsdom');
  const page = options.pageSdk && !options.serviceWorker ? new JSDOM('<html><head><meta name="pyric-runtime-chip" content="off"></head><body></body></html>', { url: 'https://app.example/' }) : undefined;
  const result = await build({
    stdin: { contents: (options.pageSdk ? `export * as firestore from './firestore.js';
      export * as auth from './auth.js';
      export * as database from './database.js';
      export * as app from './app.js';` : '') + `export * from './worker-runtime.js';
      export { registerActiveAuth } from './active-auth.js';
      export { getAuth } from '../worker/client.js';`, resolveDir: dirname(entry) },
    bundle: true, platform: 'browser', format: options.pageSdk ? 'esm' : 'iife',
    globalName: 'entry', target: options.pageSdk ? 'es2022' : 'es2020', write: false, logLevel: 'silent',
  });
  const connections: string[] = [];
  const messages: InboundMessage[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let respond!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { respond = resolve; });
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
  const globals = {
    console, TextEncoder, TextDecoder, URL, AbortController, MessageEvent,
    crypto, performance, queueMicrotask,
    location: new URL('https://app.example/'),
    fetch: (url: string) => url === '/__pyric/init.json' ? response : Promise.resolve(new Response()),
    setTimeout: (callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms); timers.add(timer); return timer;
    },
    setInterval: (callback: () => void, ms: number) => {
      const timer = setInterval(callback, ms); timers.add(timer); return timer;
    },
    clearTimeout, clearInterval,
    __PYRIC_WORKER_INIT__: options.serviceWorker ? undefined : { hosted: options.hosted ?? false, projectKey: options.hosted ? 'orbit' : null, bridgeUrl: options.hosted ? '/__pyric/sandbox' : null },
    __PYRIC_FORCE_INPAGE__: options.forceInPage,
    ...(options.serviceWorker ? { ServiceWorkerGlobalScope: class {}, registration: { scope: '/' }, clients: {} } : { window: page?.window ?? {} }),
    ...(page ? { document: page.window.document, HTMLElement: page.window.HTMLElement, CustomEvent: page.window.CustomEvent, MutationObserver: page.window.MutationObserver, localStorage: page.window.localStorage } : {}),
    ...(options.sharedWorker ? { SharedWorker: class {
      port = new Port();
      constructor() {
        if (options.blockedWorker) throw new Error('Blocked by browser policy');
        connections.push('shared-worker');
      }
      addEventListener() {}
    } } : {}),
    WebSocket: class {
      static OPEN = 1;
      readyState = 0;
      listeners = new Map<string, (event: MessageEvent<string>) => void>();
      backend = new Port();
      constructor(url: string) {
        connections.push(url);
        this.backend.onmessage = event => this.receive({ type: 'worker-message-result', message: event.data });
        if (options.pageSdk) queueMicrotask(() => { this.readyState = 1; this.listeners.get('open')?.(new MessageEvent('open')); });
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
    BroadcastChannel: class {
      onmessage: ((event: MessageEvent<ServiceWorkerChannelMessage>) => void) | null = null;
      backend = new Port();
      constructor() { connections.push('service-worker-relay'); }
      postMessage(envelope: ServiceWorkerChannelMessage) {
        if (envelope.direction !== 'host' || envelope.phase !== 'message') return;
        this.backend.onmessage = event => this.onmessage?.(new MessageEvent('message', { data: { direction: 'client', clientId: envelope.clientId, sessionId: envelope.sessionId, message: event.data } }));
        this.backend.postMessage(envelope.message);
      }
      close() {}
    },
  };
  const context = createContext(globals);
  let evaluation: Promise<void> = Promise.resolve();
  let exports: unknown;
  if (options.pageSdk) {
    const module = new SourceTextModule(result.outputFiles[0]!.text, { context });
    await module.link(() => { throw new Error('The SDK realm must be bundled.'); });
    evaluation = module.evaluate();
    exports = module.namespace;
  } else {
    runInNewContext(result.outputFiles[0]!.text, context);
    exports = runInNewContext('entry', context);
  }
  const runtime = exports as typeof import('../../../src/serve/entries/worker-runtime.js');
  return {
    runtime, connections, messages, evaluation,
    sdk: exports as { firestore: typeof import('../../../src/serve/entries/firestore.js'); auth: typeof import('../../../src/serve/entries/auth.js'); database: typeof import('../../../src/serve/entries/database.js'); app: typeof import('../../../src/serve/entries/app.js') },
    registerAuth: (): (() => void) => runInNewContext('entry.registerActiveAuth(entry.getAuth(entry.workerDb))', globals),
    status: () => runInNewContext('__pyricRuntime.getSnapshot()', globals),
    respond: (payload: object) => respond(Response.json(payload)),
    dispose() {
      runtime.presenceSession?.stop();
      runtime.workerDb?.port.close();
      page?.window.close();
      for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    },
  };
}

