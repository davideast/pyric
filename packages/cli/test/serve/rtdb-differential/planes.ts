/**
 * The three planes a sequence runs on:
 *
 * - `sandbox`: the in-page sandbox, `pyric/database` and `pyric/auth` on an
 *   app over a local sandbox;
 * - `worker`: the served entries over a port to the SharedWorker host
 *   dispatch, on a context built as the SharedWorker builds it;
 * - `node`: the served entries over the hosted transport to the Node host,
 *   with its SQLite persistence. This plane runs under Node.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTANCE_URLS, PROJECT_ID } from './sequence.js';
import type { PlaneSession } from './interpreter.js';
import { openServedPlane, portPair, tick, type PagePort, type ServedHost } from './served-plane.js';

export type PlaneName = 'sandbox' | 'worker' | 'node';

let sandboxApps = 0;

export async function openSandboxPlane(): Promise<PlaneSession> {
  const { initializeSandbox } = await import('pyric/sandbox');
  const { createAppForSandbox } = await import('pyric/app/internal');
  const { deleteApp } = await import('pyric/app');
  const database = await import('pyric/database');
  const auth = await import('pyric/auth');
  const sandbox = initializeSandbox();
  const app = createAppForSandbox(sandbox, { projectId: PROJECT_ID }, `diff-sandbox-${++sandboxApps}`);
  const handle = (db: number) => {
    const url = INSTANCE_URLS[db];
    return url === undefined ? database.getDatabase(app) : database.getDatabase(app, url);
  };
  return {
    database: database as never,
    auth: auth as never,
    app,
    async setRules(db, rules) { database.sandbox.setRules(handle(db), rules); },
    async dump(db) { return database.sandbox.snapshotState(handle(db)); },
    async settle() { for (let i = 0; i < 4; i++) await tick(); },
    async close() {
      await deleteApp(app);
      sandbox.dispose?.();
    },
  };
}

type OutboundLike = { t: string; id?: string; ok?: boolean; value?: unknown; error?: { message?: string } };

/** Send one operation to a host port and wait for its reply. */
function hostCall(
  send: (message: Record<string, unknown>) => void,
  replies: Map<string, (message: OutboundLike) => void>,
  message: Record<string, unknown>,
): Promise<unknown> {
  const id = `control-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    replies.set(id, (reply) => {
      replies.delete(id);
      if (reply.ok) resolve(reply.value);
      else reject(new Error(reply.error?.message ?? 'host call failed'));
    });
    send({ ...message, t: 'op', id });
  });
}

let workerContexts = 0;

export async function openWorkerPlane(): Promise<PlaneSession> {
  const { createMemoryBackend } = await import('pyric/sandbox');
  const { buildWorkerCtx } = await import('../../../src/serve/worker/serve-init.js');
  const { handleMessage } = await import('../../../src/serve/worker/host.js');
  const { setDatabaseRules } = await import('../../../src/serve/worker/host/rules.js');
  const ctx = await buildWorkerCtx({
    fetch: (async () => new Response('null', { status: 404 })) as unknown as typeof fetch,
    idb: createMemoryBackend(),
    persistenceKey: `diff-worker-${++workerContexts}`,
    makeEventSource: null,
  });
  const replies = new Map<string, (message: OutboundLike) => void>();
  const control = {
    postMessage(message: OutboundLike) {
      if (message.t === 'res' && message.id) replies.get(message.id)?.(message);
    },
  };
  const host: ServedHost = {
    connect(): PagePort {
      const { page, host: hostEnd } = portPair();
      const hostPort = { postMessage: (message: unknown) => hostEnd.postMessage(message) };
      hostEnd.onmessage = (event) => { void handleMessage(ctx, hostPort as never, event.data as never); };
      return page;
    },
    async setRules(instance, rules) {
      const result = setDatabaseRules(ctx, instance, rules);
      if (!result.ok) throw new Error(result.messages.map((message) => message.text).join('; '));
    },
    dump: (instance) => hostCall(
      (message) => { void handleMessage(ctx, control as never, message as never); },
      replies,
      { method: 'rtdb.adminSnapshot', ...(instance === undefined ? {} : { instance }) },
    ),
    async close() { ctx.sandbox.dispose(); },
  };
  return openServedPlane(host);
}

let nodeSessions = 0;

export async function openNodePlane(): Promise<PlaneSession> {
  const { createHostedRuntime } = await import('../../../src/serve/hosted/runtime.js');
  const directory = mkdtempSync(join(tmpdir(), 'pyric-rtdb-diff-'));
  const payload = {
    rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
    bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory,
  };
  const pages = new Map<string, PagePort>();
  const replies = new Map<string, (message: OutboundLike) => void>();
  const CONTROL = 'diff-control';
  const runtime = await createHostedRuntime(payload as never, 'http://127.0.0.1:1', (frame) => {
    if (frame.type !== 'worker-message-result') return;
    // The hosted transport carries JSON.
    const message = JSON.parse(JSON.stringify(frame.message)) as OutboundLike;
    if (frame.clientSessionId === CONTROL) {
      if (message.t === 'res' && message.id) replies.get(message.id)?.(message);
      return;
    }
    const page = pages.get(frame.clientSessionId!);
    setTimeout(() => page?.onmessage?.({ data: message }), 0);
  }, directory);
  const receive = (clientSessionId: string, message: unknown) => {
    runtime.receive({ type: 'worker-message', clientSessionId, message: JSON.parse(JSON.stringify(message)) } as never);
  };
  const host: ServedHost = {
    connect(): PagePort {
      const clientSessionId = `diff-page-${++nodeSessions}`;
      const page: PagePort = {
        onmessage: null,
        postMessage(message) { setTimeout(() => receive(clientSessionId, message), 0); },
        start() {},
        close() { runtime.receive({ type: 'worker-client-disconnect', clientSessionId } as never); },
        addEventListener() {},
      };
      pages.set(clientSessionId, page);
      return page;
    },
    async setRules(instance, rules) {
      await runtime.deployRules('database', JSON.stringify(rules), instance);
    },
    dump: (instance) => hostCall(
      (message) => receive(CONTROL, message),
      replies,
      { method: 'rtdb.adminSnapshot', actAs: { mode: 'admin' }, ...(instance === undefined ? {} : { instance }) },
    ),
    async close() {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return openServedPlane(host);
}

export function openPlane(name: PlaneName): Promise<PlaneSession> {
  if (name === 'sandbox') return openSandboxPlane();
  if (name === 'worker') return openWorkerPlane();
  return openNodePlane();
}
