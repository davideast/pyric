/**
 * Worker-client resumable upload observer parity tests for `#1963` and `#1964`:
 *   - `#1963`: `next` never receives the terminal `success` snapshot (`[running, ..., complete]`),
 *     and a late observer attached after completion fires `complete` only (`[complete]`).
 *   - `#1964`: observer callbacks are deferred to a microtask via `Promise.resolve().then(...)`
 *     so `const unsub = task.on('state_changed', () => unsub())` fires once rather than
 *     running synchronously inside `task.on()` before `unsub` is assigned.
 *
 * Exercises both worker-client upload paths: MessagePort frame RPC and the HTTP byte route.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getAuth } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';
import { getStorageService } from 'pyric/storage/internal';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { uploadTokenOf } from '../../../src/serve/worker/host/storage.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { portPair } from './integration-support.js';
import { OPEN_STORAGE_RULES } from './permissive-services.js';

let seq = 0;

async function openFrameWorkerSession() {
  const client = await import('../../../src/serve/worker/client.js');
  const storageClient = await import('../../../src/serve/worker/client/storage.js');
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, {
    dbName: `pyric-worker-obs-${++seq}-${crypto.randomUUID()}`,
    rules: OPEN_STORAGE_RULES,
  });
  getAuth(sandbox);
  await sandbox.enablePersistence({
    key: `pyric-worker-obs-persist-${seq}`,
    injectedBackend: createMemoryBackend(),
  });
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: `worker-obs-${seq}`,
    subs: new Map(),
    sessionMode: 'LOCAL',
    sessionBackend: createMemoryBackend(),
  };
  const { a: clientPort, b: hostPort } = portPair();
  const toClient: PortLike = {
    postMessage: (msg: OutboundMessage) => hostPort.postMessage(msg),
  };
  hostPort.onmessage = (event) => {
    void handleMessage(ctx, toClient, event.data as InboundMessage);
  };
  const previousSharedWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };
  const storage = storageClient.getStorage(client.getFirestore(`worker://obs-${seq}`));
  return {
    storage,
    storageClient,
    dispose: () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previousSharedWorker;
      sandbox.dispose();
    },
  };
}

async function openByteRouteWorkerSession() {
  const client = await import('../../../src/serve/worker/client.js');
  const storageClient = await import('../../../src/serve/worker/client/storage.js');
  const sandbox = initializeSandbox();
  const hostStorage = getStorageSandbox(sandbox, {
    dbName: `pyric-byte-route-obs-${++seq}-${crypto.randomUUID()}`,
    rules: OPEN_STORAGE_RULES,
  });
  const service = await getStorageService(hostStorage);
  getAuth(sandbox);
  await sandbox.enablePersistence({
    key: `pyric-byte-obs-persist-${seq}`,
    injectedBackend: createMemoryBackend(),
  });

  const sessionToken = 'session-tok-obs-test';
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: `byte-route-obs-${seq}`,
    subs: new Map(),
    storageByteRoute: true,
    sessionMode: 'LOCAL',
    sessionBackend: createMemoryBackend(),
  };

  const partCounts = new Map<string, number>();
  const { a: clientPort, b: hostPort } = portPair();
  clientPort.byteRoute = {
    baseUrl: 'http://byte-route.local',
    sessionToken: async () => sessionToken,
    fetch: async (input, init) => {
      let rawUrl: string;
      if (typeof input === 'string') {
        rawUrl = input;
      } else if (input instanceof URL) {
        rawUrl = input.href;
      } else {
        rawUrl = input.url;
      }
      const parsed = new URL(rawUrl);
      const uploadId = parsed.searchParams.get('upload_id') ?? '';
      const uploadToken = parsed.searchParams.get('upload_token') ?? '';
      if (uploadId === '' || uploadToken !== uploadTokenOf(ctx, uploadId)) {
        return new Response('forbidden', { status: 403 });
      }
      let sliceBytes = new Uint8Array(0);
      if (init?.body instanceof Blob) {
        sliceBytes = new Uint8Array(await init.body.arrayBuffer());
      } else if (init?.body instanceof Uint8Array) {
        sliceBytes = init.body;
      }
      const nextIndex = partCounts.get(uploadId) ?? 0;
      partCounts.set(uploadId, nextIndex + 1);
      if (service.backend.putPart !== undefined) {
        await service.backend.putPart(uploadId, nextIndex, sliceBytes);
      }
      return new Response('', { status: 200 });
    },
  };
  const toClient: PortLike = {
    postMessage: (msg: OutboundMessage) => hostPort.postMessage(msg),
  };
  hostPort.onmessage = (event) => {
    void handleMessage(ctx, toClient, event.data as InboundMessage);
  };
  const previousSharedWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };
  const storage = storageClient.getStorage(client.getFirestore(`worker://byte-obs-${seq}`));
  return {
    storage,
    storageClient,
    dispose: () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previousSharedWorker;
      sandbox.dispose();
    },
  };
}

describe.each([
  ['frame RPC', openFrameWorkerSession],
  ['HTTP byte route', openByteRouteWorkerSession],
] as const)('worker client resumable observers over %s (#1963, #1964)', (_mode, openSession) => {
  it('delivers running snapshots to next, suppresses terminal success on next, and delivers complete only to late observers (#1963)', async () => {
    const session = await openSession();
    try {
      const targetRef = session.storageClient.ref(session.storage, 'items/trace.bin');
      const task = session.storageClient.uploadBytesResumable(
        targetRef,
        new Uint8Array([1, 2, 3, 4]),
      );

      const events: string[] = [];
      let syncFiredInsideOn = false;
      let inRegistration = true;
      task.on(
        'state_changed',
        (snap) => {
          if (inRegistration) syncFiredInsideOn = true;
          events.push(`next:${snap.state}`);
        },
        (err) => {
          events.push(`error:${err.message}`);
        },
        () => {
          events.push('complete');
        },
      );
      inRegistration = false;
      expect(syncFiredInsideOn).toBe(false);
      expect(events).toEqual([]);

      const finalSnapshot = await task;
      expect(finalSnapshot.state).toBe('success');
      expect(events).toEqual(['next:running', 'next:running', 'complete']);

      const lateEvents: string[] = [];
      let lateSyncFired = false;
      let inLateRegistration = true;
      task.on(
        'state_changed',
        (snap) => {
          if (inLateRegistration) lateSyncFired = true;
          lateEvents.push(`next:${snap.state}`);
        },
        (err) => {
          lateEvents.push(`error:${err.message}`);
        },
        () => {
          if (inLateRegistration) lateSyncFired = true;
          lateEvents.push('complete');
        },
      );
      inLateRegistration = false;
      expect(lateSyncFired).toBe(false);
      expect(lateEvents).toEqual([]);

      await Promise.resolve();
      expect(lateEvents).toEqual(['complete']);
    } finally {
      session.dispose();
    }
  });

  it('defers observer delivery so self-unsubscribing task.on(() => unsub()) fires once (#1964)', async () => {
    const session = await openSession();
    try {
      const targetRef = session.storageClient.ref(session.storage, 'items/self-unsub.bin');
      const task = session.storageClient.uploadBytesResumable(
        targetRef,
        new Uint8Array([10, 20, 30, 40]),
      );

      let selfUnsubCalls = 0;
      const unsub = task.on('state_changed', () => {
        selfUnsubCalls += 1;
        unsub();
      });
      expect(selfUnsubCalls).toBe(0);

      await task;
      expect(selfUnsubCalls).toBe(1);
    } finally {
      session.dispose();
    }
  });
});
