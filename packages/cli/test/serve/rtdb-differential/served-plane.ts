/**
 * The page side of a served plane: the served `firebase/app`,
 * `firebase/database` and `firebase/auth` entries, connected to a host through
 * a `SharedWorker` stand-in. The SharedWorker plane and the Node plane differ
 * only in the host the stand-in's port reaches.
 */
import { INSTANCE_NAMES, PROJECT_ID } from './sequence.js';
import type { PlaneSession } from './interpreter.js';

/** The page end of a port, as the served client uses it. */
export interface PagePort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start(): void;
  close(): void;
  addEventListener(type: string, listener: () => void): void;
}

/** One host, opened fresh for one sequence. */
export interface ServedHost {
  /** A new page connection, as a page opening the SharedWorker gets one. */
  connect(): PagePort;
  setRules(instance: string | undefined, rules: { rules: Record<string, unknown> }): Promise<void>;
  /** The instance's tree, read through the host's `rtdb.adminSnapshot` operation. */
  dump(instance: string | undefined): Promise<unknown>;
  close(): Promise<void>;
}

let currentHost: ServedHost | null = null;
let entries: Promise<{
  app: typeof import('../../../src/serve/entries/app.js');
  database: typeof import('../../../src/serve/entries/database.js');
  auth: typeof import('../../../src/serve/entries/auth.js');
  appClient: typeof import('../../../src/serve/entries/app-client.js');
  core: typeof import('../../../src/serve/worker/client/core.js');
}> | null = null;

function loadEntries() {
  if (entries) return entries;
  // The served entries choose the worker transport when they are evaluated,
  // so the stand-in exists before the first import.
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port: PagePort;
    constructor(_url: unknown, _options: unknown) {
      if (currentHost === null) throw new Error('No served host is open.');
      this.port = currentHost.connect();
    }
    addEventListener() {}
  };
  entries = (async () => ({
    app: await import('../../../src/serve/entries/app.js'),
    database: await import('../../../src/serve/entries/database.js'),
    auth: await import('../../../src/serve/entries/auth.js'),
    appClient: await import('../../../src/serve/entries/app-client.js'),
    core: await import('../../../src/serve/worker/client/core.js'),
  }))();
  return entries;
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let appCounter = 0;

export async function openServedPlane(host: ServedHost): Promise<PlaneSession> {
  currentHost = host;
  const loaded = await loadEntries();
  const app = loaded.app.initializeApp({ projectId: PROJECT_ID }, `diff-${++appCounter}`);
  const client = loaded.appClient.workerClientForApp(app);
  let pings = 0;
  return {
    database: loaded.database as never,
    auth: loaded.auth as never,
    app,
    setRules: (db, rules) => host.setRules(INSTANCE_NAMES[db], rules),
    dump: (db) => host.dump(INSTANCE_NAMES[db]),
    async settle() {
      // A reply on the page's own port follows every message the host posted
      // to that port before it.
      await loaded.core.rpc(client.port, { t: 'op', id: `settle-${++pings}`, method: 'sandbox.clock' } as never);
      for (let i = 0; i < 4; i++) await tick();
    },
    async close() {
      await loaded.app.deleteApp(app);
      for (let i = 0; i < 4; i++) await tick();
      await host.close();
      currentHost = null;
    },
  };
}

/** A structured-clone port pair, delivering on a macrotask as MessagePorts do. */
export function portPair(): { page: PagePort; host: PagePort } {
  const page: PagePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  const host: PagePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  page.postMessage = (message) => {
    const copy = structuredClone(message);
    setTimeout(() => host.onmessage?.({ data: copy }), 0);
  };
  host.postMessage = (message) => {
    const copy = structuredClone(message);
    setTimeout(() => page.onmessage?.({ data: copy }), 0);
  };
  return { page, host };
}
