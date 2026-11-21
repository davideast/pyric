import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { FirebaseError } from 'pyric/app';
import { createMemoryBackend } from 'pyric/sandbox';
import {
  DEFAULT_BUCKET, assertPriorAt, higherGeneration, raisedMark,
  type GenerationIssuer, type StoredMetadata, type StoredObject,
} from 'pyric/storage/internal';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from '../../../../scripts/lib/private-job-tmpdir.ts';
import {
  STORAGE_BYTE_ROUTE_CAPABILITY, WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY,
  type BridgeMessage, type WorkerResFrame,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import {
  UploadOffsetError, type ScopedStorageBackend, type StorageGenerationMark, type StorageWrites,
} from '../../src/serve/hosted/persistence/storage.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import {
  SWIFT_LIVE_HOST_SCRATCH_SUBPATH, SWIFT_LIVE_HOST_TEST_TIMEOUT_MS, SWIFT_TEST_TIMEOUT_MS,
  buildSwiftLiveHostTests, collectProcessEnv, formatSubprocessFailure, runManagedSubprocess,
} from './swift-live-host-subprocess.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const SWIFT_CLIENT_DIR = resolve(REPO_ROOT, 'packages/swift-client');
const PROJECT_ID = 'demo-swift-storage';
const DEFAULT_STORAGE_BUCKET = 'demo-swift-storage.appspot.com';
const IOS_APP_ID = '1:424242424242:ios:swiftstorageapp';

const STORAGE_RULES = `rules_version = '2';
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

interface InMemoryStagedUpload {
  readonly size: number;
  readonly mime: string;
  readonly chunks: Uint8Array[];
  received: number;
}

function makeInMemoryHostedStorage(scratchDir: string): ScopedStorageBackend {
  const blobs = new Map<string, Blob>();
  const metadataMap = new Map<string, StoredMetadata>();
  const highWater = new Map<string, string>();
  const stagedUploads = new Map<string, InMemoryStagedUpload>();
  let fileSeq = 0;

  const keyOf = (bucket: string, path: string): string => `${bucket}\u0000${path}`;
  const objectAt = (key: string): StoredObject | undefined => {
    const blob = blobs.get(key);
    const meta = metadataMap.get(key);
    if (blob === undefined || meta === undefined) {
      return undefined;
    }
    return { blob, metadata: meta };
  };

  function view(scope?: string): ScopedStorageBackend {
    let defaultBucket = DEFAULT_BUCKET;
    if (scope !== undefined) {
      defaultBucket = scope;
    }
    const resolveBucket = (candidate?: string): string => {
      if (candidate !== undefined && candidate !== '') {
        return candidate;
      }
      return defaultBucket;
    };

    const writes: StorageWrites = {
      bytes(path, bytes, mime, metadata) {
        const bucket = resolveBucket(metadata.bucket);
        const key = keyOf(bucket, path);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        blobs.set(key, new Blob([copy], { type: mime }));
        metadataMap.set(key, { ...metadata, bucket });
        highWater.set(key, raisedMark(highWater.get(key), metadata.generation));
      },
      file() {
        throw new Error('Unexpected file seed in memory storage test stub.');
      },
    };

    return {
      async put(path: string, blob: Blob, value: StoredMetadata, issue?: GenerationIssuer) {
        const bucket = resolveBucket(value.bucket);
        value.bucket = bucket;
        const key = keyOf(bucket, path);
        const replaced = objectAt(key);
        const mark = highWater.get(key);
        if (issue !== undefined) {
          value.generation = issue(higherGeneration(replaced?.metadata.generation, mark));
        }
        blobs.set(key, blob);
        metadataMap.set(key, { ...value });
        highWater.set(key, raisedMark(mark, value.generation));
        return replaced;
      },
      async deleteIfGeneration(path: string, generation: string, bucket?: string) {
        const key = keyOf(resolveBucket(bucket), path);
        const current = metadataMap.get(key);
        if (current === undefined || current.generation !== generation) {
          return false;
        }
        blobs.delete(key);
        metadataMap.delete(key);
        return true;
      },
      async replaceIfGeneration(path: string, generation: string, prior: StoredObject | undefined, bucket?: string) {
        const target = resolveBucket(bucket);
        if (prior !== undefined) {
          assertPriorAt(prior, target, path);
        }
        const key = keyOf(target, path);
        const current = metadataMap.get(key);
        if (current === undefined || current.generation !== generation) {
          return false;
        }
        blobs.delete(key);
        metadataMap.delete(key);
        if (prior !== undefined) {
          blobs.set(key, prior.blob);
          metadataMap.set(key, prior.metadata);
        }
        return true;
      },
      async mutate<T>(work: (w: StorageWrites) => T): Promise<T> {
        return work(writes);
      },
      async raiseMarks(marks: readonly StorageGenerationMark[]) {
        for (const item of marks) {
          const key = keyOf(item.bucket, item.path);
          highWater.set(key, raisedMark(highWater.get(key), item.generation));
        }
      },
      async getBlob(path: string, bucket?: string) {
        return blobs.get(keyOf(resolveBucket(bucket), path));
      },
      async getMetadata(path: string, bucket?: string) {
        const found = metadataMap.get(keyOf(resolveBucket(bucket), path));
        return found === undefined ? undefined : { ...found };
      },
      async getObject(path: string, bucket?: string) {
        return objectAt(keyOf(resolveBucket(bucket), path));
      },
      async putMetadata(path: string, value: StoredMetadata, bucket?: string) {
        const target = resolveBucket(bucket ?? value.bucket);
        const key = keyOf(target, path);
        if (metadataMap.has(key)) {
          metadataMap.set(key, { ...value, bucket: target });
        }
      },
      async delete(path: string, bucket?: string) {
        const key = keyOf(resolveBucket(bucket), path);
        blobs.delete(key);
        metadataMap.delete(key);
      },
      async listByPrefix(prefix: string, bucket?: string) {
        const targetPrefix = `${resolveBucket(bucket)}\u0000`;
        const matches: StoredMetadata[] = [];
        for (const [key, meta] of metadataMap.entries()) {
          if (key.startsWith(targetPrefix) && meta.fullPath.startsWith(prefix)) {
            matches.push({ ...meta });
          }
        }
        matches.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
        return matches;
      },
      async reset(bucket?: string) {
        if (bucket === undefined) {
          blobs.clear();
          metadataMap.clear();
          return;
        }
        const prefix = `${bucket}\u0000`;
        for (const key of [...blobs.keys()]) {
          if (key.startsWith(prefix)) {
            blobs.delete(key);
            metadataMap.delete(key);
          }
        }
      },
      async beginUpload(_bucket: string, _path: string, size: number, mime?: string) {
        const uploadId = randomUUID();
        let resolvedMime = 'application/octet-stream';
        if (mime !== undefined && mime !== '') {
          resolvedMime = mime;
        }
        stagedUploads.set(uploadId, { size, mime: resolvedMime, chunks: [], received: 0 });
        return uploadId;
      },
      async readUpload(uploadId: string) {
        const staged = stagedUploads.get(uploadId);
        if (staged === undefined) {
          throw new FirebaseError('storage/object-not-found', `Upload '${uploadId}' not found.`);
        }
        if (staged.received !== staged.size) {
          throw new FirebaseError('storage/invalid-argument', 'Uploaded byte count mismatch.');
        }
        const merged = new Uint8Array(staged.size);
        let pos = 0;
        for (const chunk of staged.chunks) {
          merged.set(chunk, pos);
          pos += chunk.byteLength;
        }
        return new Blob([merged], { type: staged.mime });
      },
      async abortUpload(uploadId: string) {
        stagedUploads.delete(uploadId);
      },
      async appendUpload(uploadId: string, offset: number, bytes: Uint8Array) {
        const staged = stagedUploads.get(uploadId);
        if (staged === undefined) {
          throw new FirebaseError('storage/object-not-found', `Upload '${uploadId}' not found.`);
        }
        if (offset !== staged.received) {
          throw new UploadOffsetError(staged.received);
        }
        if (staged.received + bytes.byteLength > staged.size) {
          throw new FirebaseError('storage/invalid-argument', 'Upload exceeded declared size.');
        }
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        staged.chunks.push(copy);
        staged.received += copy.byteLength;
        return { received: staged.received, size: staged.size };
      },
      async uploadProgress(uploadId: string) {
        const staged = stagedUploads.get(uploadId);
        return staged === undefined ? undefined : { received: staged.received, size: staged.size };
      },
      async objectFile(bucket: string, path: string) {
        const stored = objectAt(keyOf(resolveBucket(bucket), path));
        if (stored === undefined) {
          return undefined;
        }
        const bytes = new Uint8Array(await stored.blob.arrayBuffer());
        fileSeq += 1;
        const filePath = join(scratchDir, `obj-${fileSeq}.bin`);
        writeFileSync(filePath, bytes);
        let mime = 'application/octet-stream';
        if (stored.metadata.contentType !== undefined && stored.metadata.contentType !== '') {
          mime = stored.metadata.contentType;
        }
        return { file: filePath, size: bytes.byteLength, mime, metadata: stored.metadata };
      },
      async references() {
        return [];
      },
      async putReference() {
        throw new Error('Unexpected putReference in memory storage test stub.');
      },
      close() {},
      scoped: view,
    };
  }

  return view();
}

interface ObservedSwiftStorageTraffic {
  rpcMethods: string[];
  httpRequests: Array<{ method: string; pathname: string }>;
}

async function startLiveSwiftStorageBridgeHost() {
  const scratchDir = createPrivateJobTmpDir('swift-storage-live');
  const storageBackend = makeInMemoryHostedStorage(scratchDir);
  const bridge = createBridge({ serverLabel: 'swift-storage-live-host' });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';
  const traffic: ObservedSwiftStorageTraffic = { rpcMethods: [], httpRequests: [] };

  const hostedRuntime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      databaseRules: null,
      databaseRulesHash: null,
      storageRules: STORAGE_RULES,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: false,
      hosted: true,
      projectKey: 'swift-storage-live-host',
      permissive: false,
      appOptions: {
        projectId: PROJECT_ID,
        appId: IOS_APP_ID,
        storageBucket: DEFAULT_STORAGE_BUCKET,
      },
    },
    () => baseOrigin,
    (message) => {
      bridge.handleSandboxMessage(message);
    },
    REPO_ROOT,
    {
      persistence: {
        backend: createMemoryBackend(),
        storage: storageBackend,
        checkpoints: {},
        state: { seed: async () => false },
        repairedObjects: [],
        sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
        close: () => {},
        status: () => ({ state: 'healthy' as const }),
        onFailure: () => () => {},
        markUnhealthy: () => {},
        seed: async () => false,
      },
      record: false,
    },
  );

  await hostedRuntime.deployRules('storage', STORAGE_RULES);

  const unregisterPeer = bridge.registerSandboxPeer(
    (inbound) => {
      if (inbound.type === 'worker-op') {
        const opRecord = inbound.op as Record<string, unknown>;
        if (typeof opRecord.method === 'string') {
          traffic.rpcMethods.push(opRecord.method);
        }
      }
      hostedRuntime.receive(inbound);
    },
    [],
    'swift-storage-sandbox-peer',
    [WORKER_RELAY_CAPABILITY, WORKER_PORT_CAPABILITY, STORAGE_BYTE_ROUTE_CAPABILITY],
    undefined,
    hostedRuntime.instanceId,
  );

  const server = createServer((req, res) => {
    let reqUrl = '/';
    if (req.url !== undefined) {
      reqUrl = req.url;
    }
    const parsed = new URL(reqUrl, baseOrigin);
    let method = 'GET';
    if (req.method !== undefined) {
      method = req.method;
    }
    traffic.httpRequests.push({ method, pathname: parsed.pathname });
    void hostedRuntime.storageHttp(req, res, parsed).then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    });
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
    baseOrigin,
    bridgeUrl,
    traffic,
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
      removePrivateJobTmpDir(scratchDir);
    },
  };
}

function detectRunnableSwiftBinary(): string | null {
  const swiftBin = Bun.which('swift');
  if (swiftBin === null) {
    return null;
  }
  const probe = spawnSync(swiftBin, ['test', '--version'], { encoding: 'utf8' });
  if (probe.error !== undefined || probe.status !== 0) {
    return null;
  }
  return swiftBin;
}

const requireSwiftLive = process.env.PYRIC_REQUIRE_SWIFT_LIVE === '1';
const isGenericCiShard = process.env.CI === 'true' && !requireSwiftLive;
const detectedSwiftBinary = detectRunnableSwiftBinary();
const shouldSkipSwiftSubprocess =
  !requireSwiftLive && (isGenericCiShard || detectedSwiftBinary === null);

describe('native Swift Cloud Storage live-host conformance', () => {
  test('enforces Storage Rules, byte-route upload/download, and downloadURL over WebSocket + HTTP', async () => {
    const host = await startLiveSwiftStorageBridgeHost();
    const socket = new WebSocket(host.bridgeUrl);

    try {
      const replies = new Map<string, (frame: WorkerResFrame) => void>();
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as BridgeMessage;
        if (frame.type === 'worker-res') {
          const handler = replies.get(frame.id);
          if (handler !== undefined) {
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
          clientSessionId: 'swift-storage-smoke',
          clientInfo: { platform: 'swift' },
        } satisfies BridgeMessage),
      );
      await ackPromise;

      let seq = 0;
      const sendOp = async (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `swift-storage-op-${seq}`;
        const replyPromise = new Promise<WorkerResFrame>((resolveReply) => {
          replies.set(id, resolveReply);
        });
        socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
        return replyPromise;
      };

      const deniedRes = await sendOp({
        method: 'storage.beginUpload',
        path: 'users/uid-1/hello.txt',
        size: 5,
      });
      expect(deniedRes.ok).toBe(false);
      if (!deniedRes.ok) {
        expect(deniedRes.error.code).toBe('storage/unauthorized');
      }

      const payload = new TextEncoder().encode('swift-storage-smoke-payload');
      const beginRes = await sendOp({
        method: 'storage.beginUpload',
        path: 'users/uid-1/hello.txt',
        size: payload.byteLength,
        contentType: 'text/plain',
        metadata: { customMetadata: { sdk: 'swift' } },
        actAs: { mode: 'as', uid: 'uid-1' },
      });
      expect(beginRes.ok).toBe(true);
      if (!beginRes.ok) {
        throw new Error('Expected storage.beginUpload to succeed');
      }
      const begun = beginRes.value as { uploadId: string; uploadUrl: string };
      const putHttp = await fetch(new URL(begun.uploadUrl, host.baseOrigin), {
        method: 'PUT',
        headers: { 'content-range': `bytes 0-${payload.byteLength - 1}/${payload.byteLength}` },
        body: payload,
      });
      expect(putHttp.status).toBe(200);

      const finishRes = await sendOp({
        method: 'storage.finishUpload',
        uploadId: begun.uploadId,
        actAs: { mode: 'as', uid: 'uid-1' },
      });
      expect(finishRes.ok).toBe(true);

      const urlRes = await sendOp({
        method: 'storage.getDownloadURL',
        path: 'users/uid-1/hello.txt',
        actAs: { mode: 'as', uid: 'uid-1' },
      });
      expect(urlRes.ok).toBe(true);
      if (!urlRes.ok) {
        throw new Error('Expected storage.getDownloadURL to succeed');
      }
      const downloadPath = (urlRes.value as { path: string }).path;
      const fetched = await fetch(new URL(downloadPath, host.baseOrigin));
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toBe('swift-storage-smoke-payload');
    } finally {
      socket.terminate();
      await host.close();
    }
  });

  test.skipIf(shouldSkipSwiftSubprocess)(
    'runs packages/swift-client PyricStorageTests over live HostedRuntime WebSocket + HTTP byte route',
    async () => {
      if (detectedSwiftBinary === null) {
        throw new Error('PYRIC_REQUIRE_SWIFT_LIVE=1 requires a runnable swift test toolchain.');
      }
      const swiftScratchDir = join(SWIFT_CLIENT_DIR, SWIFT_LIVE_HOST_SCRATCH_SUBPATH);
      const baseEnv = collectProcessEnv();
      const buildRun = await buildSwiftLiveHostTests({
        swiftBinary: detectedSwiftBinary,
        repoRoot: REPO_ROOT,
        swiftPackageDir: SWIFT_CLIENT_DIR,
        swiftScratchDir,
        env: baseEnv,
      });
      const buildDetails = formatSubprocessFailure('build', buildRun.attempt, buildRun.result);
      expect(buildRun.result.timedOut, buildDetails).toBe(false);
      expect(buildRun.result.exitCode, buildDetails).toBe(0);

      const host = await startLiveSwiftStorageBridgeHost();
      try {
        const childEnv: Record<string, string> = {
          ...baseEnv,
          PYRIC_LIVE_STORAGE_BRIDGE_URL: host.bridgeUrl,
        };

        const testResult = await runManagedSubprocess({
          command: detectedSwiftBinary,
          args: [
            'test', '--skip-build', '--disable-xctest', '--disable-index-store',
            '-Xswiftc', '-gnone', '--no-parallel',
            '--package-path', SWIFT_CLIENT_DIR,
            '--scratch-path', swiftScratchDir,
            '--filter', 'PyricStorageTests',
          ],
          cwd: REPO_ROOT,
          env: childEnv,
          timeoutMs: SWIFT_TEST_TIMEOUT_MS,
        });
        const combined = `${testResult.stdout}\n${testResult.stderr}`;
        const testDetails = formatSubprocessFailure('test', 1, testResult);
        expect(testResult.timedOut, testDetails).toBe(false);
        expect(testResult.exitCode, testDetails).toBe(0);
        expect(combined, testDetails).not.toContain('with 0 tests');

        expect(host.traffic.rpcMethods).toContain('storage.beginUpload');
        expect(host.traffic.rpcMethods).toContain('storage.finishUpload');
        expect(host.traffic.rpcMethods).toContain('storage.getMetadata');
        expect(host.traffic.rpcMethods).toContain('storage.getDownloadURL');
        expect(host.traffic.rpcMethods).toContain('storage.setMetadata');
        expect(host.traffic.rpcMethods).toContain('storage.listAll');
        expect(host.traffic.rpcMethods).toContain('storage.deleteObject');
        expect(host.traffic.httpRequests.some((r) => r.method === 'PUT')).toBe(true);
        expect(host.traffic.httpRequests.some((r) => r.method === 'GET')).toBe(true);
      } finally {
        await host.close();
      }
    },
    SWIFT_LIVE_HOST_TEST_TIMEOUT_MS,
  );
});
