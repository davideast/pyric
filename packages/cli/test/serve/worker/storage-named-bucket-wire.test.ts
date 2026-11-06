/**
 * A worker-backed Storage handle on a named bucket sends that bucket with
 * every object op, so the host serves the bucket's own objects and rules
 * (#1313). Before, `getStorage(app, 'gs://media-bucket')` on the SharedWorker
 * and Node host planes sent no bucket, and the host served the default
 * bucket. A handle on the default bucket still sends none.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getAuth } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { getMetadata as adminMetadata, ref as adminRef } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';

import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import type { ClientDb, ClientPort } from '../../../src/serve/worker/client/handles.js';
import { installServedStorageRules } from '../../../src/serve/storage-rules-install.js';

const OPEN = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} {
      allow read, write: if true;
    }
  }
}`;

let seq = 0;

/** A worker client attached to a host whose project deploys open rules to both buckets; records each op it sends. */
async function connect() {
  const { portPair } = await import('./integration-support.js');
  const client = await import('../../../src/serve/worker/client.js');
  const storageClient = await import('../../../src/serve/worker/client/storage.js');
  const sandbox = initializeSandbox();
  installServedStorageRules(sandbox, {
    storageRules: OPEN,
    projectKey: `/named-bucket-wire-${++seq}-${Math.random()}`,
    storageBucketRules: { 'media-bucket': { rules: OPEN, rulesHash: 'm' } },
  });
  getAuth(sandbox);
  const ctx: HostCtx = {
    db: getFirestore(sandbox), sandbox, instanceId: 'named-bucket-wire', subs: new Map(),
    sessionMode: 'LOCAL', sessionBackend: createMemoryBackend(),
  };
  const { a: clientPort, b: hostPort } = portPair();
  const toClient: PortLike = { postMessage: (message) => hostPort.postMessage(message) };
  const sent: InboundMessage[] = [];
  hostPort.onmessage = (event) => {
    const message = event.data as InboundMessage;
    sent.push(message);
    void handleMessage(ctx, toClient, message);
  };
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };
  const db = client.getFirestore(`worker://named-bucket-wire-${seq}`);
  return { sandbox, sent, storageClient, db };
}

/** The bucket each storage op named, by method, in send order. */
function bucketsByMethod(sent: readonly InboundMessage[]): Array<[string, string | undefined]> {
  return sent
    .filter((message): message is InboundMessage & { t: 'op'; method: string } =>
      message.t === 'op' && String((message as { method?: unknown }).method).startsWith('storage.'))
    .map((message) => [message.method, (message as { bucket?: string }).bucket]);
}

describe('worker client ops on a named bucket', () => {
  it('name the bucket on listAll, getMetadata, getDownloadURL and deleteObject', async () => {
    const { sandbox, sent, storageClient, db } = await connect();
    const media = storageClient.getStorage(db, undefined, 'media-bucket', true);
    const object = storageClient.ref(media, 'uploads/a.txt');
    await storageClient.uploadString(object, 'media');
    const stored = await adminMetadata(adminRef(getAdminStorageSandbox(sandbox, { bucket: 'media-bucket' }), 'uploads/a.txt'));
    expect(stored.size).toBe(5);
    sent.length = 0;

    await storageClient.listAll(storageClient.ref(media, 'uploads'));
    await storageClient.getMetadata(object);
    await storageClient.getDownloadURL(object);
    await storageClient.deleteObject(object);

    expect(bucketsByMethod(sent)).toEqual([
      ['storage.listAll', 'media-bucket'],
      ['storage.getMetadata', 'media-bucket'],
      // Without a byte route, getDownloadURL reads the object for a data: URL.
      ['storage.getBytes', 'media-bucket'],
      ['storage.deleteObject', 'media-bucket'],
    ]);
  });

  it('name the bucket on getDownloadURL over the byte route', async () => {
    const { wirePort } = await import('../../../src/serve/worker/client/core.js');
    const storageClient = await import('../../../src/serve/worker/client/storage.js');
    const sent: InboundMessage[] = [];
    const port: ClientPort = {
      onmessage: null,
      postMessage(message) {
        sent.push(message);
        if (message.t !== 'op') return;
        queueMicrotask(() => port.onmessage?.(new MessageEvent('message', {
          data: { t: 'res', id: message.id, ok: true, value: { path: '/v0/b/media-bucket/o/uploads%2Fa.txt' } },
        })));
      },
      start() {},
      close() {},
      byteRoute: { baseUrl: 'http://127.0.0.1:1/', sessionToken: async () => null },
    };
    wirePort(port);
    const media = storageClient.getStorage({ __kind: 'client-db', port } as ClientDb, undefined, 'media-bucket', true);
    await storageClient.getDownloadURL(storageClient.ref(media, 'uploads/a.txt'));
    expect(bucketsByMethod(sent)).toEqual([['storage.getDownloadURL', 'media-bucket']]);
  });

  it('name no bucket on the default bucket', async () => {
    const { sent, storageClient, db } = await connect();
    const storage = storageClient.getStorage(db, undefined, 'demo-app.appspot.com');
    const object = storageClient.ref(storage, 'uploads/a.txt');
    await storageClient.uploadString(object, 'default');
    await storageClient.getMetadata(object);
    await storageClient.deleteObject(object);
    expect(bucketsByMethod(sent).every(([, bucket]) => bucket === undefined)).toBe(true);
  });
});
