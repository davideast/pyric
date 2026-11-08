import 'fake-indexeddb/auto';
import { once } from 'node:events';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { getFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import * as ip from 'pyric/storage';
import { getAdminStorageSandbox, getStorageService } from 'pyric/storage/internal';
import {
  deleteApp as deleteAdminApp,
  getApps as getAdminApps,
  initializeApp as initializeAdminApp,
} from 'pyric-admin/app';
import { getStorage as getAdminStorage } from 'pyric-admin/storage';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../src/bridge/protocol.js';
import { createBridge } from '../../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../src/bridge/server/peer.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../../src/remote/index.js';
import { UploadOffsetError } from '../../../src/serve/hosted/persistence/storage.js';
import { createStorageByteRoute } from '../../../src/serve/hosted/storage-byte-route.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { uploadTokenOf } from '../../../src/serve/worker/host/storage.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { OPEN_STORAGE_RULES } from './permissive-services.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

let seq = 0;
function nextStorageDb(prefix: string): string {
  return `storage-parity-${prefix}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('Cross-plane Storage SDK and Admin Storage parity', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(async () => {
    restoreSW();
    await Promise.all(getAdminApps().map((app) => deleteAdminApp(app)));
  });

  async function setupPlanes() {
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

    const served = await import('../../../src/serve/entries/storage.js');
    const servedApp = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage', storageBucket: 'demo-storage.appspot.com' },
      `served-storage-${++seq}`,
    );
    const servedStorage = served.getStorage(servedApp);

    const ipSandbox = initializeSandbox();
    const ipStorage = ip.getStorageSandbox(ipSandbox, {
      dbName: nextStorageDb('ip'),
      bucket: 'demo-storage.appspot.com',
      rules: OPEN_STORAGE_RULES,
    });

    return {
      ctx,
      served,
      servedApp,
      servedStorage,
      ipSandbox,
      ipStorage,
      cleanup: async () => {
        await deleteApp(servedApp);
      },
    };
  }

  it('populates optional metadata on resumable initial/progress snapshots and binds observer objects across planes', async () => {
    const { served, servedStorage, ipStorage, cleanup } = await setupPlanes();
    try {
      const payload = new Uint8Array([10, 20, 30, 40]);
      const settable = {
        contentType: 'text/plain',
        cacheControl: 'public, max-age=300',
        contentDisposition: 'attachment; filename="report.txt"',
        contentEncoding: 'gzip',
        contentLanguage: 'en-US',
        customMetadata: { owner: 'user-1', kind: 'summary' },
      };

      const ipSnapshots: Array<{
        state: string;
        bytesTransferred: number;
        cacheControl?: string;
        contentDisposition?: string;
        contentEncoding?: string;
        contentLanguage?: string;
        customMetadata?: Record<string, string>;
      }> = [];
      let ipCompletedWithPrefix = '';

      const ipObserver = {
        prefix: 'ip:',
        next(snap: ip.UploadTaskSnapshot) {
          ipSnapshots.push({
            state: `${this.prefix}${snap.state}`,
            bytesTransferred: snap.bytesTransferred,
            cacheControl: snap.metadata.cacheControl,
            contentDisposition: snap.metadata.contentDisposition,
            contentEncoding: snap.metadata.contentEncoding,
            contentLanguage: snap.metadata.contentLanguage,
            customMetadata: snap.metadata.customMetadata,
          });
        },
        complete() {
          ipCompletedWithPrefix = `${this.prefix}done`;
        },
      };

      const ipTask = ip.uploadBytesResumable(
        ip.ref(ipStorage, 'files/user-1/report.txt'),
        payload,
        settable,
      );
      expect(ipTask.snapshot.metadata.cacheControl).toBe(settable.cacheControl);
      expect(ipTask.snapshot.metadata.contentDisposition).toBe(settable.contentDisposition);
      expect(ipTask.snapshot.metadata.contentEncoding).toBe(settable.contentEncoding);
      expect(ipTask.snapshot.metadata.contentLanguage).toBe(settable.contentLanguage);
      expect(ipTask.snapshot.metadata.customMetadata).toEqual(settable.customMetadata);
      ipTask.on('state_changed', ipObserver);
      await ipTask;

      const servedSnapshots: typeof ipSnapshots = [];
      let servedCompletedWithPrefix = '';
      const servedObserver = {
        prefix: 'served:',
        next(snap: ip.UploadTaskSnapshot) {
          servedSnapshots.push({
            state: `${this.prefix}${snap.state}`,
            bytesTransferred: snap.bytesTransferred,
            cacheControl: snap.metadata.cacheControl,
            contentDisposition: snap.metadata.contentDisposition,
            contentEncoding: snap.metadata.contentEncoding,
            contentLanguage: snap.metadata.contentLanguage,
            customMetadata: snap.metadata.customMetadata,
          });
        },
        complete() {
          servedCompletedWithPrefix = `${this.prefix}done`;
        },
      };

      const servedTask = served.uploadBytesResumable(
        served.ref(servedStorage, 'files/user-1/report.txt'),
        payload,
        settable,
      );
      expect(servedTask.snapshot.metadata.cacheControl).toBe(settable.cacheControl);
      expect(servedTask.snapshot.metadata.contentDisposition).toBe(settable.contentDisposition);
      expect(servedTask.snapshot.metadata.contentEncoding).toBe(settable.contentEncoding);
      expect(servedTask.snapshot.metadata.contentLanguage).toBe(settable.contentLanguage);
      expect(servedTask.snapshot.metadata.customMetadata).toEqual(settable.customMetadata);
      servedTask.on('state_changed', servedObserver);
      await servedTask;

      expect(ipCompletedWithPrefix).toBe('ip:done');
      expect(servedCompletedWithPrefix).toBe('served:done');
      expect(ipSnapshots.length).toBeGreaterThanOrEqual(2);
      expect(servedSnapshots.length).toBeGreaterThanOrEqual(2);
      for (const snap of servedSnapshots) {
        expect(snap.cacheControl).toBe(settable.cacheControl);
        expect(snap.contentDisposition).toBe(settable.contentDisposition);
        expect(snap.contentEncoding).toBe(settable.contentEncoding);
        expect(snap.contentLanguage).toBe(settable.contentLanguage);
        expect(snap.customMetadata).toEqual(settable.customMetadata);
      }

      // Also verify error binding on observer object when canceled
      let ipErrorPrefix = '';
      const cancelIpTask = ip.uploadBytesResumable(ip.ref(ipStorage, 'files/user-1/cancel.txt'), payload);
      cancelIpTask.on('state_changed', {
        prefix: 'ip-err:',
        error(err) {
          ipErrorPrefix = `${this.prefix}${(err as { code?: string }).code}`;
        },
      });
      cancelIpTask.cancel();
      await cancelIpTask.catch(() => {});
      expect(ipErrorPrefix).toBe('ip-err:storage/canceled');

      let servedErrorPrefix = '';
      const cancelServedTask = served.uploadBytesResumable(
        served.ref(servedStorage, 'files/user-1/cancel.txt'),
        payload,
      );
      cancelServedTask.on('state_changed', {
        prefix: 'served-err:',
        error(err) {
          servedErrorPrefix = `${this.prefix}${(err as { code?: string }).code}`;
        },
      });
      cancelServedTask.cancel();
      await cancelServedTask.catch(() => {});
      expect(servedErrorPrefix).toBe('served-err:storage/canceled');
    } finally {
      await cleanup();
    }
  });

  it('falls back to Blob.type (or default contentType) when metadata.contentType is empty string across planes', async () => {
    const { served, servedStorage, ipStorage, cleanup } = await setupPlanes();
    try {
      const typedBlob = new Blob(['hello'], { type: 'text/csv' });
      const untypedBytes = new Uint8Array([1, 2, 3]);

      const ipBytesRes = await ip.uploadBytes(ip.ref(ipStorage, 'files/user-1/a.csv'), typedBlob, {
        contentType: '',
      });
      const servedBytesRes = await served.uploadBytes(
        served.ref(servedStorage, 'files/user-1/a.csv'),
        typedBlob,
        { contentType: '' },
      );
      expect(ipBytesRes.metadata.contentType).toBe('text/csv');
      expect(servedBytesRes.metadata.contentType).toBe('text/csv');

      const ipResumable = ip.uploadBytesResumable(
        ip.ref(ipStorage, 'files/user-1/b.csv'),
        typedBlob,
        { contentType: '' },
      );
      const servedResumable = served.uploadBytesResumable(
        served.ref(servedStorage, 'files/user-1/b.csv'),
        typedBlob,
        { contentType: '' },
      );
      expect(ipResumable.snapshot.metadata.contentType).toBe('text/csv');
      expect(servedResumable.snapshot.metadata.contentType).toBe('text/csv');
      expect((await ipResumable).metadata.contentType).toBe('text/csv');
      expect((await servedResumable).metadata.contentType).toBe('text/csv');

      const ipFallback = await ip.uploadBytes(ip.ref(ipStorage, 'files/user-1/raw.bin'), untypedBytes, {
        contentType: '',
      });
      const servedFallback = await served.uploadBytes(
        served.ref(servedStorage, 'files/user-1/raw.bin'),
        untypedBytes,
        { contentType: '' },
      );
      expect(ipFallback.metadata.contentType).toBe('application/octet-stream');
      expect(servedFallback.metadata.contentType).toBe('application/octet-stream');

      const ipStr = await ip.uploadString(ip.ref(ipStorage, 'files/user-1/note.txt'), 'note', 'raw', {
        contentType: '',
      });
      const servedStr = await served.uploadString(
        served.ref(servedStorage, 'files/user-1/note.txt'),
        'note',
        'raw',
        { contentType: '' },
      );
      expect(ipStr.metadata.contentType).toBe('application/octet-stream');
      expect(servedStr.metadata.contentType).toBe(ipStr.metadata.contentType);
    } finally {
      await cleanup();
    }
  });

  it('rejects root references ("", "///") with storage/invalid-root-operation while allowing whitespace path (" ") across planes', async () => {
    const { ctx, served, servedStorage, ipStorage, cleanup } = await setupPlanes();
    try {
      for (const slashRoot of ['', '///']) {
        await expect(
          ip.uploadBytes(ip.ref(ipStorage, slashRoot), new Uint8Array([1])),
        ).rejects.toMatchObject({ code: 'storage/invalid-root-operation' });
        await expect(
          served.uploadBytes(served.ref(servedStorage, slashRoot), new Uint8Array([1])),
        ).rejects.toMatchObject({ code: 'storage/invalid-root-operation' });
      }

      // Host storage.beginUpload must also reject '///' as root and allow ' ' as valid object name
      const slashBegin = await new Promise<ResMessage>((resolve) => {
        void handleMessage(
          ctx,
          { postMessage: (m) => m.t === 'res' && resolve(m) },
          { t: 'op', id: 'begin-slashes', method: 'storage.beginUpload', path: '///', size: 4 },
        );
      });
      expect(slashBegin.ok).toBe(false);
      if (!slashBegin.ok) {
        expect(slashBegin.error.code).toBe('storage/invalid-root-operation');
      }

      const spaceBegin = await new Promise<ResMessage>((resolve) => {
        void handleMessage(
          ctx,
          { postMessage: (m) => m.t === 'res' && resolve(m) },
          { t: 'op', id: 'begin-space', method: 'storage.beginUpload', path: ' ', size: 4 },
        );
      });
      expect(spaceBegin.ok).toBe(true);

      const ipSpace = await ip.uploadBytes(ip.ref(ipStorage, ' '), new Uint8Array([7, 8]));
      const servedSpace = await served.uploadBytes(served.ref(servedStorage, ' '), new Uint8Array([7, 8]));
      expect(ipSpace.metadata.fullPath).toBe(' ');
      expect(servedSpace.metadata.fullPath).toBe(' ');
    } finally {
      await cleanup();
    }
  });

  it('defensively clones customMetadata on write and read across planes', async () => {
    const { served, servedStorage, ipStorage, cleanup } = await setupPlanes();
    try {
      const ipInput = { stage: 'initial' };
      const ipRef = ip.ref(ipStorage, 'files/user-1/meta.bin');
      const ipUploaded = await ip.uploadBytes(ipRef, new Uint8Array([1]), { customMetadata: ipInput });
      ipInput.stage = 'mutated-caller-input';
      ipUploaded.metadata.customMetadata!.stage = 'mutated-upload-return';

      const ipRead1 = await ip.getMetadata(ipRef);
      expect(ipRead1.customMetadata).toEqual({ stage: 'initial' });
      ipRead1.customMetadata!.stage = 'mutated-get-return';

      const ipRead2 = await ip.getMetadata(ipRef);
      expect(ipRead2.customMetadata).toEqual({ stage: 'initial' });

      const ipResumableInput = { stage: 'initial' };
      const ipResumableRef = ip.ref(ipStorage, 'files/user-1/meta-resumable.bin');
      const ipResumableTask = ip.uploadBytesResumable(ipResumableRef, new Uint8Array([1]), {
        customMetadata: ipResumableInput,
      });
      ipResumableInput.stage = 'mutated-caller-input';
      expect(ipResumableTask.snapshot.metadata.customMetadata).toEqual({ stage: 'initial' });
      ipResumableTask.snapshot.metadata.customMetadata!.stage = 'mutated-snapshot';
      const ipResumableDone = await ipResumableTask;
      expect(ipResumableDone.metadata.customMetadata).toEqual({ stage: 'initial' });

      const servedInput = { stage: 'initial' };
      const servedRef = served.ref(servedStorage, 'files/user-1/meta.bin');
      const servedTask = served.uploadBytesResumable(servedRef, new Uint8Array([1]), {
        customMetadata: servedInput,
      });
      servedInput.stage = 'mutated-caller-input';
      expect(servedTask.snapshot.metadata.customMetadata).toEqual({ stage: 'initial' });
      servedTask.snapshot.metadata.customMetadata!.stage = 'mutated-snapshot';
      const servedDone = await servedTask;
      expect(servedDone.metadata.customMetadata).toEqual({ stage: 'initial' });
    } finally {
      await cleanup();
    }
  });

  it('normalizes leading, doubled, and trailing slashes across pyric-admin SandboxFile and byte-routed RemoteFile', async () => {
    async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks);
    }

    // 1. In-process SandboxFile
    const sandbox = initializeSandbox();
    ip.getStorageSandbox(sandbox, {
      dbName: nextStorageDb('admin'),
      rules: OPEN_STORAGE_RULES,
    });
    const adminApp = initializeAdminApp(
      { sandbox, projectId: 'demo-storage', storageBucket: 'demo-storage.appspot.com' },
      `admin-storage-${++seq}`,
    );
    const bucket = getAdminStorage(adminApp).bucket();

    const unnormalized = bucket.file('/files//user-1/doc.txt/');
    await unnormalized.save('normalized-payload');

    expect(await unnormalized.exists()).toEqual([true]);
    const [downloaded] = await unnormalized.download();
    expect(downloaded.toString('utf8')).toBe('normalized-payload');
    expect((await collectStream(unnormalized.createReadStream())).toString('utf8')).toBe('normalized-payload');
    expect(await bucket.file('files/user-1/doc.txt').exists()).toEqual([true]);

    // 2. Byte-routed RemoteFile (ctx.byteRoute = true so frame reads/writes are refused)
    const remoteSandbox = initializeSandbox();
    await remoteSandbox.enablePersistence({
      key: `admin-byte-route-${++seq}`,
      injectedBackend: createMemoryBackend(),
    });
    ip.getStorageSandbox(remoteSandbox, {
      dbName: nextStorageDb('admin-byte-route'),
      rules: OPEN_STORAGE_RULES,
    });
    const ctx: HostCtx = {
      db: getFirestore(remoteSandbox),
      sandbox: remoteSandbox,
      instanceId: 'admin-byte-route-parity',
      subs: new Map(),
      byteRoute: true,
    };

    const tempRoot = mkdtempSync(join(tmpdir(), 'pyric-storage-parity-'));
    const tempFiles: string[] = [];
    const uploads = new Map<string, number[]>();
    const declaredSizes = new Map<string, number>();
    const pendingUploadSizes = new Map<string, number>();
    let tempFileSeq = 0;
    const sessionToken = 'byte-route-session-token';

    let server: Server | undefined;
    let remoteHandle: ReturnType<typeof createRemoteSandboxHandle> | undefined;
    try {
      const route = createStorageByteRoute({
        sessionToken,
        uploadToken: (id) => uploadTokenOf(ctx, id),
        storage: {
          async objectFile(_bucketName, objectPath) {
            const service = await getStorageService(getAdminStorageSandbox(remoteSandbox));
            const stored = await service.backend.getObject(objectPath).catch(() => undefined);
            if (stored === undefined) return undefined;
            const bytes = new Uint8Array(await stored.blob.arrayBuffer());
            const filePath = join(tempRoot, `obj-${++tempFileSeq}.bin`);
            writeFileSync(filePath, bytes);
            tempFiles.push(filePath);
            return {
              file: filePath,
              size: bytes.byteLength,
              mime: stored.metadata.contentType ?? 'application/octet-stream',
              metadata: stored.metadata,
            };
          },
          async uploadProgress(id) {
            const size = declaredSizes.get(id);
            if (size === undefined) return undefined;
            const buf = uploads.get(id) ?? [];
            return { received: buf.length, size };
          },
          async appendUpload(id, offset, bytes) {
            const size = declaredSizes.get(id) ?? bytes.byteLength;
            const buf = uploads.get(id) ?? [];
            if (offset !== buf.length) throw new UploadOffsetError(buf.length);
            buf.push(...bytes);
            uploads.set(id, buf);
            const service = await getStorageService(getAdminStorageSandbox(remoteSandbox));
            await service.backend.putPart!(id, 0, Uint8Array.from(buf));
            return { received: buf.length, size };
          },
        },
      });

      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        void route(req, res, url).then((handled) => {
          if (!handled) res.writeHead(404).end();
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');

      const overWire = <T>(frame: T): T => JSON.parse(JSON.stringify(frame)) as T;
      const bridge = createBridge({ mode: 'sandbox', version: 'test' });
      let generation = 0;
      const tab: PortLike = {
        postMessage(raw: unknown) {
          const message = raw as OutboundMessage;
          if (message.t !== 'res') return;
          const size = pendingUploadSizes.get(message.id);
          pendingUploadSizes.delete(message.id);
          if (size !== undefined && message.ok) {
            const uploadId = (message.value as { uploadId?: string } | undefined)?.uploadId;
            if (uploadId !== undefined) declaredSizes.set(uploadId, size);
          }
          const reply = message.ok
            ? { type: 'worker-res', id: message.id, ok: true, value: message.value }
            : { type: 'worker-res', id: message.id, ok: false, error: message.error };
          bridge.handleSandboxMessage(overWire(reply) as BridgeMessage, generation);
        },
      };
      bridge.registerSandboxPeer(
        (message: BridgeMessage) => {
          if (generation === 0) generation = bridge.peerGeneration();
          const wire = overWire(message);
          if (wire.type === 'worker-op') {
            if (wire.op.method === 'storage.beginUpload' && typeof wire.op.size === 'number') {
              pendingUploadSizes.set(wire.id, wire.op.size);
            }
            void handleMessage(ctx, tab, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
          }
        },
        [],
        'fake-tab',
        [WORKER_RELAY_CAPABILITY],
      );
      let deliver: (message: BridgeMessage) => void = () => {};
      const session = createConsumerSession(bridge, (message) => deliver(overWire(message)));
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const core = createRemoteSandboxCore(
        { send: (message) => session.handleMessage(overWire(message)) },
        { serveUrl: baseUrl },
      );
      deliver = core.handleMessage;
      core.start();
      remoteHandle = createRemoteSandboxHandle({
        serveUrl: baseUrl,
        channel: {
          ...core.channel,
          byteRoute: async () => ({ baseUrl, sessionToken: async () => sessionToken }),
        },
        close: () => core.dispose('closed'),
      });

      const remoteApp = initializeAdminApp(
        { sandbox: remoteHandle, projectId: 'demo-storage', storageBucket: 'demo-storage.appspot.com' },
        `admin-remote-storage-${++seq}`,
      );
      const remoteBucket = getAdminStorage(remoteApp).bucket();
      const remoteUnnormalized = remoteBucket.file('/files//user-1/doc.txt/');

      await remoteUnnormalized.save('remote-byte-route-payload');
      expect(await remoteUnnormalized.exists()).toEqual([true]);

      const [remoteDownloaded] = await remoteUnnormalized.download();
      expect(remoteDownloaded.toString('utf8')).toBe('remote-byte-route-payload');

      const remoteStreamed = await collectStream(remoteUnnormalized.createReadStream());
      expect(remoteStreamed.toString('utf8')).toBe('remote-byte-route-payload');
    } finally {
      remoteHandle?.close();
      if (server !== undefined) {
        const activeServer = server;
        await new Promise<void>((resolve) => activeServer.close(() => resolve()));
      }
      for (const filePath of tempFiles) {
        try {
          unlinkSync(filePath);
        } catch {
          // ignore if already removed
        }
      }
      try {
        rmdirSync(tempRoot);
      } catch {
        // ignore if already removed
      }
    }
  });
});
