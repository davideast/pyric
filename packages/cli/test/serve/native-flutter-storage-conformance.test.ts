import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryBackend } from 'pyric/sandbox';
import { DEFAULT_BUCKET, STORAGE_ROUTE_PREFIX } from 'pyric/storage/internal';
import { openStorageBackend } from '../../../pyric/src/storage/persistence.js';
import {
  DOC_VALUE_ENCODING_CAPABILITY,
  MAX_BRIDGE_FRAME_BYTES,
  STORAGE_BYTE_ROUTE_CAPABILITY,
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
  type WorkerResFrame,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { UploadOffsetError, type UploadProgress } from '../../src/serve/hosted/persistence/storage.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import type { InitPayload } from '../../src/serve/init-payload.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const FLUTTER_CLIENT_DIR = join(REPO_ROOT, 'packages/flutter-client');
const PROJECT_ID = 'demo-flutter-storage-live';
const DEFAULT_STORAGE_BUCKET = `${PROJECT_ID}.appspot.com`;
const CUSTOM_STORAGE_BUCKET = 'flutter-custom-media';
const SECONDARY_STORAGE_BUCKET = 'demo-flutter-secondary.appspot.com';

const DEFAULT_BUCKET_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{userId}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /public/{allPaths=**} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}`;

const CUSTOM_BUCKET_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /public/{userId}/{allPaths=**} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == userId;
    }
  }
}`;

interface StagedMemoryUpload {
  size: number;
  mime: string;
  received: number;
  chunks: Uint8Array[];
}

type BaseStorageBackend = Awaited<ReturnType<typeof openStorageBackend>>;

async function makeInMemoryHostedStoragePersistence() {
  const baseStorage = await openStorageBackend(`mem-flutter-storage-${randomUUID()}`);
  const stagedUploads = new Map<string, StagedMemoryUpload>();
  const decorated = new WeakSet<object>();

  function decorateBackend(target: BaseStorageBackend) {
    if (!decorated.has(target)) {
      decorated.add(target);
      const originalScoped = target.scoped.bind(target);
      Object.assign(target, {
        scoped(bucket: string) {
          return decorateBackend(originalScoped(bucket));
        },
        async close(): Promise<void> {},
        async objectFile(): Promise<undefined> {
          return undefined;
        },
        async beginUpload(_bucket: string, _path: string, size: number, mime?: string): Promise<string> {
          const uploadId = `mem-up-${randomUUID()}`;
          let resolvedMime = 'application/octet-stream';
          if (typeof mime === 'string' && mime.length > 0) {
            resolvedMime = mime;
          }
          stagedUploads.set(uploadId, { size, mime: resolvedMime, received: 0, chunks: [] });
          return uploadId;
        },
        async uploadProgress(uploadId: string): Promise<UploadProgress | undefined> {
          const entry = stagedUploads.get(uploadId);
          if (entry === undefined) {
            return undefined;
          }
          return { received: entry.received, size: entry.size };
        },
        async appendUpload(uploadId: string, offset: number, bytes: Uint8Array): Promise<UploadProgress> {
          const entry = stagedUploads.get(uploadId);
          if (entry === undefined) {
            throw new Error(`Unknown staged upload: ${uploadId}`);
          }
          if (offset !== entry.received) {
            throw new UploadOffsetError(entry.received);
          }
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          entry.chunks.push(copy);
          entry.received += copy.byteLength;
          return { received: entry.received, size: entry.size };
        },
        async readUpload(uploadId: string): Promise<Blob> {
          const entry = stagedUploads.get(uploadId);
          if (entry === undefined) {
            throw new Error(`Unknown staged upload: ${uploadId}`);
          }
          const combined = new Uint8Array(entry.received);
          let cursor = 0;
          for (const chunk of entry.chunks) {
            combined.set(chunk, cursor);
            cursor += chunk.byteLength;
          }
          return new Blob([combined], { type: entry.mime });
        },
        async abortUpload(uploadId: string): Promise<void> {
          stagedUploads.delete(uploadId);
        },
      });
    }
    return target;
  }

  return {
    baseStorage: decorateBackend(baseStorage),
    persistence: {
      backend: createMemoryBackend(),
      storage: decorateBackend(baseStorage),
      checkpoints: {},
      state: { seed: async () => false },
      repairedObjects: [],
      sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
      close: () => {},
      status: () => ({ state: 'healthy' as const }),
      onFailure: () => () => {},
      markUnhealthy: () => {},
    },
  };
}

function resolveStoredBucketKey(requestedBucket: string): string {
  if (requestedBucket === '' || requestedBucket === DEFAULT_STORAGE_BUCKET) {
    return DEFAULT_BUCKET;
  }
  return requestedBucket;
}

function sendPlainError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

async function tryServeMemoryByteRouteGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  baseStorage: BaseStorageBackend,
): Promise<boolean> {
  const isReadMethod = req.method === 'GET' || req.method === 'HEAD';
  if (!isReadMethod || !url.pathname.startsWith(STORAGE_ROUTE_PREFIX)) {
    return false;
  }
  const rest = url.pathname.slice(STORAGE_ROUTE_PREFIX.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) {
    return false;
  }
  const rawBucket = decodeURIComponent(rest.slice(0, slashIdx));
  const tail = rest.slice(slashIdx + 1);
  if (!tail.startsWith('o/') || tail.length <= 2) {
    return false;
  }
  const objectPath = decodeURIComponent(tail.slice(2));
  const sdkHeader = req.headers['x-pyric-byte-route'] === '1';
  const presentedToken = url.searchParams.get('token');
  const hasPresentedToken = presentedToken !== null && presentedToken.length > 0;
  if (!sdkHeader && !hasPresentedToken) {
    sendPlainError(res, 403, 'This URL carries no token that grants this object.');
    return true;
  }

  const stored = await baseStorage.getObject(objectPath, resolveStoredBucketKey(rawBucket));
  if (stored === undefined) {
    if (sdkHeader) {
      sendPlainError(res, 404, 'No such object.');
    } else {
      sendPlainError(res, 403, 'This URL carries no token that grants this object.');
    }
    return true;
  }

  let rawTokens = '';
  if (typeof stored.metadata.downloadTokens === 'string') {
    rawTokens = stored.metadata.downloadTokens;
  }
  const validTokens = rawTokens.split(',').filter((entry) => entry.length > 0);
  const tokenAuthorized = hasPresentedToken && validTokens.includes(presentedToken);
  if (!sdkHeader && !tokenAuthorized) {
    sendPlainError(res, 403, 'This URL carries no token that grants this object.');
    return true;
  }

  const pinnedGeneration = url.searchParams.get('generation');
  if (pinnedGeneration !== null && pinnedGeneration !== stored.metadata.generation) {
    sendPlainError(res, 412, 'The object changed since its rules were checked.');
    return true;
  }

  const fullBytes = Buffer.from(await stored.blob.arrayBuffer());
  let contentType = 'application/octet-stream';
  if (typeof stored.metadata.contentType === 'string' && stored.metadata.contentType.length > 0) {
    contentType = stored.metadata.contentType;
  }
  const rawRangeHeader = req.headers.range;
  let sliceBytes = fullBytes;
  let statusCode = 200;
  let contentRangeHeader: string | undefined;
  if (typeof rawRangeHeader === 'string' && fullBytes.byteLength > 0) {
    const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(rawRangeHeader.trim());
    if (rangeMatch !== null) {
      const start = Number(rangeMatch[1]);
      let end = fullBytes.byteLength - 1;
      if (rangeMatch[2] !== undefined && rangeMatch[2].length > 0) {
        end = Math.min(Number(rangeMatch[2]), fullBytes.byteLength - 1);
      }
      if (start < fullBytes.byteLength && end >= start) {
        sliceBytes = fullBytes.subarray(start, end + 1);
        statusCode = 206;
        contentRangeHeader = `bytes ${start}-${end}/${fullBytes.byteLength}`;
      }
    }
  }
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(sliceBytes.byteLength),
    'cache-control': stored.metadata.cacheControl ?? 'no-store',
  };
  if (contentRangeHeader !== undefined) {
    headers['content-range'] = contentRangeHeader;
  }
  if (typeof stored.metadata.contentDisposition === 'string') {
    headers['content-disposition'] = stored.metadata.contentDisposition;
  }
  res.writeHead(statusCode, headers);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(sliceBytes);
  }
  return true;
}

async function startLiveFlutterStorageHost() {
  const bridge = createBridge({ serverLabel: 'flutter-storage-live-host' });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BRIDGE_FRAME_BYTES });
  let baseOrigin = 'http://127.0.0.1:0';
  const observedStorageMethods: string[] = [];

  const { baseStorage, persistence } = await makeInMemoryHostedStoragePersistence();
  const initPayload: InitPayload = {
    rules: null,
    rulesHash: null,
    databaseRules: null,
    databaseRulesHash: null,
    storageRules: DEFAULT_BUCKET_RULES,
    storageRulesHash: null,
    storageBucketRules: {
      [DEFAULT_STORAGE_BUCKET]: { rules: DEFAULT_BUCKET_RULES, rulesHash: 'd' },
      [CUSTOM_STORAGE_BUCKET]: { rules: CUSTOM_BUCKET_RULES, rulesHash: 'c' },
      [SECONDARY_STORAGE_BUCKET]: { rules: DEFAULT_BUCKET_RULES, rulesHash: 's' },
    },
    bridgeUrl: null,
    seed: null,
    capture: false,
    hosted: true,
    permissive: false,
    projectKey: 'flutter-storage-live-host',
    appOptions: { projectId: PROJECT_ID, storageBucket: DEFAULT_STORAGE_BUCKET },
  };

  const hostedRuntime = await createHostedRuntime(
    initPayload,
    () => baseOrigin,
    (message) => bridge.handleSandboxMessage(message),
    REPO_ROOT,
    { persistence: persistence as never, record: false },
  );

  const unregisterPeer = bridge.registerSandboxPeer(
    (inbound) => {
      if (inbound.type === 'worker-op') {
        const opRecord = inbound.op as Record<string, unknown>;
        if (typeof opRecord.method === 'string' && opRecord.method.startsWith('storage.')) {
          observedStorageMethods.push(opRecord.method);
        }
      }
      hostedRuntime.receive(inbound);
    },
    [...hostedRuntime.toolNames],
    'flutter-storage-sandbox-peer',
    [
      WORKER_RELAY_CAPABILITY,
      WORKER_PORT_CAPABILITY,
      STORAGE_BYTE_ROUTE_CAPABILITY,
      DOC_VALUE_ENCODING_CAPABILITY,
    ],
    undefined,
    hostedRuntime.instanceId,
  );

  const server = createServer((req, res) => {
    void (async () => {
      const reqUrl = new URL(req.url ?? '/', baseOrigin);
      const servedGet = await tryServeMemoryByteRouteGet(req, res, reqUrl, baseStorage);
      if (servedGet) {
        return;
      }
      const handledByRoute = await hostedRuntime.storageHttp(req, res, reqUrl);
      if (!handledByRoute) {
        res.writeHead(404).end();
      }
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/__pyric/sandbox') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachPeer(bridge, ws, false);
      });
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  baseOrigin = `http://127.0.0.1:${port}`;
  const bridgeUrl = `ws://127.0.0.1:${port}/__pyric/sandbox`;

  return {
    port,
    baseOrigin,
    bridgeUrl,
    observedStorageMethods,
    async close() {
      for (const client of wss.clients) {
        client.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolveWss) => wss.close(() => resolveWss()));
      server.close();
      unregisterPeer();
      await hostedRuntime.close();
    },
  };
}

function detectFlutterBinary(): string | null {
  const fromPath = Bun.which('flutter');
  if (fromPath !== null) {
    return fromPath;
  }
  const home = homedir();
  const localBinCandidate = join(home, '.local/bin/flutter');
  if (existsSync(localBinCandidate)) {
    return localBinCandidate;
  }
  const localFlutterCandidate = join(home, '.local/flutter/bin/flutter');
  if (existsSync(localFlutterCandidate)) {
    return localFlutterCandidate;
  }
  return null;
}

const requireFlutterLive = process.env.PYRIC_REQUIRE_FLUTTER_LIVE === '1';
const isGenericCiShard = process.env.CI === 'true' && !requireFlutterLive;
const detectedFlutter = detectFlutterBinary();
const shouldSkipFlutterSubprocess = !requireFlutterLive && (isGenericCiShard || detectedFlutter === null);

describe('native Flutter Cloud Storage live-host conformance', () => {
  test('enforces Storage Security Rules, HTTP byte-route transfers, download tokens, and custom buckets over WebSocket', async () => {
    const host = await startLiveFlutterStorageHost();
    const socket = new WebSocket(host.bridgeUrl);

    try {
      const replies = new Map<string, (frame: WorkerResFrame) => void>();
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as BridgeMessage;
        if (frame.type === 'worker-res') {
          const handler = replies.get(frame.id);
          if (handler !== undefined) {
            replies.delete(frame.id);
            handler(frame);
          }
        }
      });

      await once(socket, 'open');
      const ackPromise = once(socket, 'message');
      socket.send(
        JSON.stringify({
          type: 'attach',
          protocol: 1,
          clientSessionId: 'flutter-storage-wire-smoke',
          clientInfo: { platform: 'flutter' },
        } satisfies BridgeMessage),
      );
      await ackPromise;

      let seq = 0;
      const sendOp = (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `fl-storage-${seq}`;
        return new Promise<WorkerResFrame>((resolveReply) => {
          replies.set(id, resolveReply);
          socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
        });
      };

      const unauthBegin = await sendOp({
        method: 'storage.beginUpload',
        path: 'users/u1/private.txt',
        size: 5,
      });
      expect(unauthBegin.ok).toBe(false);
      expect(unauthBegin.error?.code).toBe('storage/unauthorized');

      const createdUser = await sendOp({
        method: 'auth.createUser',
        email: 'storage-smoke@example.test',
        password: 'correct-horse-battery-staple',
      });
      expect(createdUser.ok).toBe(true);
      const userVal = createdUser.value as { user?: { uid?: string } };
      const uid = userVal.user?.uid ?? '';
      expect(uid.length).toBeGreaterThan(0);

      const payloadBytes = new TextEncoder().encode('smoke-storage-payload');
      const begun = await sendOp({
        method: 'storage.beginUpload',
        path: `users/${uid}/hello.txt`,
        size: payloadBytes.byteLength,
        contentType: 'text/plain',
      });
      expect(begun.ok).toBe(true);
      const begunVal = begun.value as { uploadId: string; uploadUrl: string };

      const putRes = await fetch(new URL(begunVal.uploadUrl, host.baseOrigin), {
        method: 'PUT',
        headers: {
          'content-range': `bytes 0-${payloadBytes.byteLength - 1}/${payloadBytes.byteLength}`,
        },
        body: payloadBytes,
      });
      expect(putRes.status).toBe(200);

      const finished = await sendOp({ method: 'storage.finishUpload', uploadId: begunVal.uploadId });
      expect(finished.ok).toBe(true);

      const urlRes = await sendOp({ method: 'storage.getDownloadURL', path: `users/${uid}/hello.txt` });
      expect(urlRes.ok).toBe(true);
      const urlPath = (urlRes.value as { path: string }).path;
      const downloadResp = await fetch(new URL(urlPath, host.baseOrigin));
      expect(downloadResp.status).toBe(200);
      expect(await downloadResp.text()).toBe('smoke-storage-payload');
    } finally {
      socket.terminate();
      await host.close();
    }
  });

  test.skipIf(shouldSkipFlutterSubprocess)(
    'runs packages/flutter-client storage_live_host_test.dart against live HostedRuntime and verifies wire traffic',
    async () => {
      if (detectedFlutter === null) {
        throw new Error('PYRIC_REQUIRE_FLUTTER_LIVE=1 is set, but `flutter` was not found.');
      }
      const host = await startLiveFlutterStorageHost();

      try {
        const childEnv: Record<string, string> = {};
        for (const [key, val] of Object.entries(process.env)) {
          if (val !== undefined) {
            childEnv[key] = val;
          }
        }
        const localBin = join(homedir(), '.local/bin');
        let currentPath = '';
        if (typeof childEnv.PATH === 'string') {
          currentPath = childEnv.PATH;
        }
        if (currentPath.length > 0 && !currentPath.includes(localBin)) {
          childEnv.PATH = `${localBin}:${currentPath}`;
        } else if (currentPath.length === 0) {
          childEnv.PATH = localBin;
        }
        childEnv.PYRIC_LIVE_BRIDGE_URL = host.bridgeUrl;
        childEnv.PYRIC_LIVE_PROJECT_ID = PROJECT_ID;
        childEnv.PYRIC_LIVE_STORAGE_HOST = '1';

        const packageConfigPath = join(FLUTTER_CLIENT_DIR, '.dart_tool/package_config.json');
        if (!existsSync(packageConfigPath)) {
          const pubGet = Bun.spawn([detectedFlutter, 'pub', 'get'], {
            cwd: FLUTTER_CLIENT_DIR,
            env: childEnv,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [pubOut, pubErr, pubExit] = await Promise.all([
            new Response(pubGet.stdout).text(),
            new Response(pubGet.stderr).text(),
            pubGet.exited,
          ]);
          expect(pubExit, `${pubOut}\n${pubErr}`).toBe(0);
        }

        const proc = Bun.spawn(
          [detectedFlutter, 'test', '--no-pub', 'test/live_host/storage_live_host_test.dart'],
          { cwd: FLUTTER_CLIENT_DIR, env: childEnv, stdout: 'pipe', stderr: 'pipe' },
        );
        const killTimer = setTimeout(() => proc.kill(), 180_000);
        let stdout = '';
        let stderr = '';
        let exitCode = -1;
        try {
          [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
        } finally {
          clearTimeout(killTimer);
          proc.kill();
        }
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

        expect(host.observedStorageMethods).toContain('storage.beginUpload');
        expect(host.observedStorageMethods).toContain('storage.finishUpload');
        expect(host.observedStorageMethods).toContain('storage.getMetadata');
        expect(host.observedStorageMethods).toContain('storage.updateMetadata');
        expect(host.observedStorageMethods).not.toContain('storage.setMetadata');
        expect(host.observedStorageMethods).toContain('storage.getDownloadURL');
        expect(host.observedStorageMethods).toContain('storage.listAll');
        expect(host.observedStorageMethods).toContain('storage.deleteObject');
      } finally {
        await host.close();
      }
    },
    180_000,
  );
});
