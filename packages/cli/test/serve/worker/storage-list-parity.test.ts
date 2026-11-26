/**
 * Served-entry + SharedWorker + Node-hosted WebSocket parity tests for
 * paginated `firebase/storage` `list(ref, options?)` (`storage#78`).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { deleteApp, FirebaseError } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { createMemoryBackend } from 'pyric/sandbox';
import { recordCheckpointBackend } from 'pyric/sandbox/checkpoints';
import { deployStorageBucketRules, replaceStorageRules, type StoredMetadata } from 'pyric/storage/internal';
import {
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
  type WorkerResFrame,
} from '../../../src/bridge/protocol.js';
import { createBridge } from '../../../src/bridge/server/bridge.js';
import { attachPeer } from '../../../src/bridge/server/peer.js';
import type { HostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import type { ClientDb, ClientPort } from '../../../src/serve/worker/client/handles.js';
import {
  getStorage as workerGetStorage,
  list as workerList,
  ref as workerRef,
  uploadBytes as workerUploadBytes,
} from '../../../src/serve/worker/client/storage.js';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../../..');

const AUTH_SCOPED_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /public/{allPaths=**} {
      allow read, write: if true;
    }
    match /private/{allPaths=**} {
      allow write: if true;
      allow list: if request.auth != null;
    }
  }
}`;

let appSeq = 0;

async function captureErrorCode(fn: () => Promise<unknown>): Promise<{
  code: string | null;
  isFirebaseError: boolean;
}> {
  try {
    await fn();
  } catch (err) {
    let code: string | null = null;
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'string') {
      code = rawCode;
    }
    return { code, isFirebaseError: err instanceof FirebaseError };
  }
  throw new Error('Expected operation to throw');
}

function makeMemoryHostedPersistence(): HostedPersistence {
  const objects = new Map<string, { blob: Blob; metadata: StoredMetadata }>();
  const uploads = new Map<
    string,
    { bucket: string; path: string; size: number; mime: string; chunks: Uint8Array[]; received: number }
  >();
  let uploadSeq = 0;

  const keyOf = (bucket: string, path: string): string => `${bucket}\0${path}`;

  const makeScoped = (defaultBucket: string) => ({
    scoped: (bucket: string) => makeScoped(bucket),
    reset: async (bucket?: string) => {
      if (bucket === undefined) {
        objects.clear();
        return;
      }
      const prefix = `${bucket}\0`;
      for (const key of Array.from(objects.keys())) {
        if (key.startsWith(prefix)) objects.delete(key);
      }
    },
    close: () => {},
    put: async (path: string, blob: Blob, metadata: StoredMetadata) => {
      const targetBucket = metadata.bucket || defaultBucket;
      const key = keyOf(targetBucket, path);
      const prior = objects.get(key);
      objects.set(key, { blob, metadata: { ...metadata, bucket: targetBucket } });
      return prior;
    },
    putMetadata: async (path: string, metadata: StoredMetadata, bucket?: string) => {
      const key = keyOf(bucket ?? defaultBucket, path);
      const existing = objects.get(key);
      if (existing) objects.set(key, { blob: existing.blob, metadata });
    },
    listByPrefix: async (prefix: string, bucket?: string) => {
      const targetBucket = bucket ?? defaultBucket;
      const matched: StoredMetadata[] = [];
      for (const entry of objects.values()) {
        if (entry.metadata.bucket === targetBucket && entry.metadata.fullPath.startsWith(prefix)) {
          matched.push(entry.metadata);
        }
      }
      matched.sort((a, b) => {
        if (a.fullPath < b.fullPath) return -1;
        if (a.fullPath > b.fullPath) return 1;
        return 0;
      });
      return matched;
    },
    buckets: async () => {
      const names = new Set<string>();
      for (const entry of objects.values()) names.add(entry.metadata.bucket);
      return Array.from(names);
    },
    getBlob: async (path: string, bucket?: string) => objects.get(keyOf(bucket ?? defaultBucket, path))?.blob,
    getMetadata: async (path: string, bucket?: string) => objects.get(keyOf(bucket ?? defaultBucket, path))?.metadata,
    getObject: async (path: string, bucket?: string) => objects.get(keyOf(bucket ?? defaultBucket, path)),
    delete: async (path: string, bucket?: string) => {
      objects.delete(keyOf(bucket ?? defaultBucket, path));
    },
    objectFile: async () => undefined,
    beginUpload: async (bucket: string | undefined, path: string, size: number, mime = 'application/octet-stream') => {
      uploadSeq += 1;
      const id = `mem-upload-${uploadSeq}`;
      uploads.set(id, { bucket: bucket || defaultBucket, path, size, mime, chunks: [], received: 0 });
      return id;
    },
    uploadProgress: async (uploadId: string) => {
      const upload = uploads.get(uploadId);
      if (!upload) return undefined;
      return { received: upload.received, size: upload.size };
    },
    appendUpload: async (uploadId: string, _offset: number, bytes: Uint8Array) => {
      const upload = uploads.get(uploadId);
      if (!upload) throw new Error(`Unknown upload ${uploadId}`);
      upload.chunks.push(bytes.slice());
      upload.received += bytes.byteLength;
      return { received: upload.received, size: upload.size };
    },
    readUpload: async (uploadId: string) => {
      const upload = uploads.get(uploadId);
      if (!upload) throw new Error(`Unknown upload ${uploadId}`);
      return new Blob(upload.chunks, { type: upload.mime });
    },
    abortUpload: async (uploadId: string) => {
      uploads.delete(uploadId);
    },
  });

  const storageStub = makeScoped('default-bucket');
  return {
    backend: createMemoryBackend(),
    storage: storageStub,
    checkpoints: recordCheckpointBackend(createMemoryBackend()),
    state: { seed: async () => false },
    seed: async () => false,
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close: () => {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy: () => {},
  } as unknown as HostedPersistence;
}

describe('served entry + SharedWorker list(ref, options?) parity (storage#78)', () => {
  let restoreSharedWorker: () => void = () => {};

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSharedWorker = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => {
    restoreSharedWorker();
  });

  async function setupServedStorage() {
    const ctx = await makeHostCtx();

    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
        };
        this.port = clientPort;
      }
    };

    const servedStorage = await import('../../../src/serve/entries/storage.js');
    const servedAuth = await import('../../../src/serve/entries/auth.js');
    const app = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage-list', storageBucket: 'buckets-default' },
      `served-list-${++appSeq}`,
    );
    const storage = servedStorage.getStorage(app);
    const auth = servedAuth.getAuth(app);

    return {
      ctx,
      app,
      servedStorage,
      servedAuth,
      storage,
      auth,
      cleanup: async () => {
        await deleteApp(app);
        ctx.sandbox.dispose();
      },
    };
  }

  test('paginates mixed items and prefixes, handles exact boundaries, and preserves multi-bucket identity', async () => {
    const session = await setupServedStorage();
    try {
      const { servedStorage, storage, app, ctx } = session;
      deployStorageBucketRules(ctx.sandbox, 'buckets-media', AUTH_SCOPED_RULES);
      await replaceStorageRules(ctx.sandbox, AUTH_SCOPED_RULES);

      for (const path of [
        'public/foo/child.txt',
        'public/foo-bar',
        'public/a.txt',
        'public/b/sub.txt',
        'public/z.txt',
      ]) {
        await servedStorage.uploadBytes(servedStorage.ref(storage, path), new Uint8Array([1]));
      }

      const publicRef = servedStorage.ref(storage, 'public');
      const p1 = await servedStorage.list(publicRef, { maxResults: 2 });
      expect(p1.items.map((r) => r.name)).toEqual(['a.txt']);
      expect(p1.prefixes.map((r) => r.name)).toEqual(['b']);
      expect(typeof p1.nextPageToken).toBe('string');

      const p2 = await servedStorage.list(publicRef, { maxResults: 2, pageToken: p1.nextPageToken });
      expect(p2.items.map((r) => r.name)).toEqual(['foo-bar']);
      expect(p2.prefixes.map((r) => r.name)).toEqual(['foo']);
      expect(typeof p2.nextPageToken).toBe('string');

      const p3 = await servedStorage.list(publicRef, { maxResults: 2, pageToken: p2.nextPageToken });
      expect(p3.items.map((r) => r.name)).toEqual(['z.txt']);
      expect(p3.prefixes).toEqual([]);
      expect(Object.prototype.hasOwnProperty.call(p3, 'nextPageToken')).toBe(false);

      const exact = await servedStorage.list(publicRef, { maxResults: 5 });
      expect(exact.items.map((r) => r.name)).toEqual(['a.txt', 'foo-bar', 'z.txt']);
      expect(exact.prefixes.map((r) => r.name)).toEqual(['b', 'foo']);
      expect(Object.prototype.hasOwnProperty.call(exact, 'nextPageToken')).toBe(false);

      // Multi-bucket list() isolation
      const mediaStorage = servedStorage.getStorage(app, 'gs://buckets-media');
      await servedStorage.uploadBytes(servedStorage.ref(mediaStorage, 'public/m1.png'), new Uint8Array([2]));
      await servedStorage.uploadBytes(servedStorage.ref(mediaStorage, 'public/m2.png'), new Uint8Array([3]));

      const m1 = await servedStorage.list(servedStorage.ref(mediaStorage, 'public'), { maxResults: 1 });
      expect(m1.items.map((r) => r.name)).toEqual(['m1.png']);
      expect(m1.items[0]?.bucket).toBe('buckets-media');
      const m2 = await servedStorage.list(servedStorage.ref(mediaStorage, 'public'), {
        maxResults: 1,
        pageToken: m1.nextPageToken,
      });
      expect(m2.items.map((r) => r.name)).toEqual(['m2.png']);
      expect(m2.items[0]?.bucket).toBe('buckets-media');
      expect(Object.prototype.hasOwnProperty.call(m2, 'nextPageToken')).toBe(false);
    } finally {
      await session.cleanup();
    }
  });

  test('validates maxResults and pageToken and enforces method: list rules over SharedWorker', async () => {
    const session = await setupServedStorage();
    try {
      const { servedStorage, servedAuth, storage, auth, ctx } = session;
      await replaceStorageRules(ctx.sandbox, AUTH_SCOPED_RULES);
      await servedStorage.uploadBytes(servedStorage.ref(storage, 'private/secret.txt'), new Uint8Array([9]));

      for (const badMax of [0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1001]) {
        const res = await captureErrorCode(() =>
          servedStorage.list(servedStorage.ref(storage, 'public'), { maxResults: badMax }),
        );
        expect(res).toEqual({ code: 'storage/invalid-argument', isFirebaseError: true });
      }

      // Signed out caller denied before pageToken decoding.
      const denied = await captureErrorCode(() =>
        servedStorage.list(servedStorage.ref(storage, 'private'), { pageToken: 'bad-token' }),
      );
      expect(denied).toEqual({ code: 'storage/unauthorized', isFirebaseError: true });

      // Signed in caller succeeds on valid page and gets invalid-argument on malformed token.
      await servedAuth.signInAnonymously(auth);
      const allowed = await servedStorage.list(servedStorage.ref(storage, 'private'), { maxResults: 10 });
      expect(allowed.items.map((r) => r.name)).toEqual(['secret.txt']);

      const badToken = await captureErrorCode(() =>
        servedStorage.list(servedStorage.ref(storage, 'private'), { pageToken: 'not-valid' }),
      );
      expect(badToken).toEqual({ code: 'storage/invalid-argument', isFirebaseError: true });
    } finally {
      await session.cleanup();
    }
  });
});

describe('Node-hosted WebSocket HostedRuntime list(ref, options?) parity (storage#78)', () => {
  test('paginates over JSON WebSocket bridge and preserves NaN/Infinity validation and rules denial', async () => {
    const bridge = createBridge({
      mode: 'sandbox',
      project: 'demo-storage-hosted',
      projectKey: REPO_ROOT,
      version: '0.0.0-test',
    });
    const sockets = new Set<Socket>();
    const wss = new WebSocketServer({ noServer: true });
    let baseOrigin = 'http://127.0.0.1:0';
    const hostedRuntime = await createHostedRuntime(
      {
        rules: null,
        rulesHash: null,
        databaseRules: null,
        databaseRulesHash: null,
        databaseInstances: {
          defaultInstance: 'demo-storage-hosted-default-rtdb',
          projectId: 'demo-storage-hosted',
          rules: {},
        },
        storageRules: AUTH_SCOPED_RULES,
        storageRulesHash: 'storage-list-test',
        bridgeUrl: null,
        seed: null,
        capture: false,
        hosted: true,
        projectKey: REPO_ROOT,
        permissive: false,
      },
      () => baseOrigin,
      (message) => bridge.handleSandboxMessage(message),
      REPO_ROOT,
      { persistence: makeMemoryHostedPersistence(), record: false },
    );

    const unregisterPeer = bridge.registerSandboxPeer(
      (inbound) => hostedRuntime.receive(inbound),
      [...hostedRuntime.toolNames],
      hostedRuntime.instanceId,
      [WORKER_RELAY_CAPABILITY, WORKER_PORT_CAPABILITY],
    );
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', baseOrigin);
      const handled = await hostedRuntime.storageHttp(req, res, url);
      if (!handled) {
        res.writeHead(404).end();
      }
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (req, socket, head) => {
      if (req.url === '/__pyric/sandbox') {
        wss.handleUpgrade(req, socket, head, (ws) => attachPeer(bridge, ws, false));
        return;
      }
      socket.destroy();
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
    const port = (server.address() as AddressInfo).port;
    baseOrigin = `http://127.0.0.1:${port}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__pyric/sandbox`);
    try {
      await new Promise<void>((resolveOpen, rejectOpen) => {
        ws.once('open', () => resolveOpen());
        ws.once('error', rejectOpen);
      });
      let resolveAck = (): void => {};
      const ack = new Promise<void>((r) => {
        resolveAck = r;
      });
      const clientPort: ClientPort = {
        onmessage: null,
        byteRoute: {
          baseUrl: baseOrigin,
          sessionToken: async () => null,
        },
        postMessage(msg: InboundMessage) {
          if (msg.t === 'op') {
            const { t: _t, id, ...rest } = msg;
            ws.send(JSON.stringify({ type: 'worker-op', id, op: rest } as BridgeMessage));
          }
        },
        start() {},
        close() {},
      };
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as BridgeMessage;
        if (frame.type === 'attach-ack') {
          resolveAck();
          return;
        }
        if (frame.type === 'worker-res') {
          const reply = frame as WorkerResFrame;
          let outbound: OutboundMessage;
          if (reply.ok) {
            outbound = { t: 'res', id: reply.id, ok: true, value: reply.value };
          } else {
            outbound = {
              t: 'res',
              id: reply.id,
              ok: false,
              error: {
                code: reply.error?.code ?? 'internal',
                message: reply.error?.message ?? 'error',
              },
            };
          }
          clientPort.onmessage?.({ data: outbound } as MessageEvent<OutboundMessage>);
        }
      });
      ws.send(
        JSON.stringify({
          type: 'attach',
          protocol: 1,
          clientSessionId: 'storage-list-hosted-peer',
          clientInfo: { platform: 'node' },
        } satisfies BridgeMessage),
      );
      await ack;
      wirePort(clientPort);

      const clientDb: ClientDb = { __kind: 'client-db', port: clientPort };
      const storage = workerGetStorage(clientDb, undefined, 'demo-storage-hosted.appspot.com');
      await workerUploadBytes(workerRef(storage, 'public/1.txt'), new Uint8Array([1]));
      await workerUploadBytes(workerRef(storage, 'public/2.txt'), new Uint8Array([2]));
      await workerUploadBytes(workerRef(storage, 'public/folder/3.txt'), new Uint8Array([3]));

      const page1 = await workerList(workerRef(storage, 'public'), { maxResults: 2 });
      expect(page1.items.map((r) => r.name)).toEqual(['1.txt', '2.txt']);
      expect(page1.prefixes).toEqual([]);
      expect(typeof page1.nextPageToken).toBe('string');

      const page2 = await workerList(workerRef(storage, 'public'), {
        maxResults: 2,
        pageToken: page1.nextPageToken,
      });
      expect(page2.items).toEqual([]);
      expect(page2.prefixes.map((r) => r.name)).toEqual(['folder']);
      expect(Object.prototype.hasOwnProperty.call(page2, 'nextPageToken')).toBe(false);

      // NaN / Infinity must be rejected client-side before JSON.stringify turns them into null.
      expect(
        await captureErrorCode(() => workerList(workerRef(storage, 'public'), { maxResults: Number.NaN })),
      ).toEqual({ code: 'storage/invalid-argument', isFirebaseError: true });
      expect(
        await captureErrorCode(() =>
          workerList(workerRef(storage, 'public'), { maxResults: Number.POSITIVE_INFINITY }),
        ),
      ).toEqual({ code: 'storage/invalid-argument', isFirebaseError: true });

      // Unauthorized path denied over WebSocket bridge.
      expect(await captureErrorCode(() => workerList(workerRef(storage, 'private')))).toEqual({
        code: 'storage/unauthorized',
        isFirebaseError: true,
      });
    } finally {
      ws.terminate();
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
      server.close();
      unregisterPeer();
      await hostedRuntime.close();
    }
  });
});
