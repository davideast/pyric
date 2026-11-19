/**
 * The served page client's `ref(storage, url)`, replayed against production's
 * `client-storage-ref-urls` capture, plus end-to-end SharedWorker cross-bucket
 * wire routing and per-bucket Security Rules isolation.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getAuth } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { installServedStorageRules } from '../../../src/serve/storage-rules-install.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import {
  deleteObject,
  getBytes,
  getDownloadURL,
  getMetadata,
  getStorage,
  listAll,
  ref,
  uploadString,
  type ClientFirebaseStorage,
} from '../../../src/serve/worker/client/storage.js';
import { portPair } from './integration-support.js';

interface RefCase {
  input: string;
  parent?: string;
  threw: boolean;
  bucket?: string;
  fullPath?: string;
  name?: string;
  code?: string;
}

const observation = JSON.parse(
  readFileSync(
    new URL('../../../../conformance/observations/storage/client-storage-ref-urls.json', import.meta.url),
    'utf8',
  ),
) as { behavior: Record<string, RefCase> };
const cases = observation.behavior;

const fakeDb = { __kind: 'client-db' as const, port: {} as never };

function requireCase(name: string): RefCase {
  const entry = cases[name];
  if (entry === undefined) {
    throw new Error(`missing observation case: ${name}`);
  }
  return entry;
}

function call(storage: ClientFirebaseStorage, recorded: RefCase) {
  if (recorded.parent === undefined) {
    return ref(storage, recorded.input);
  }
  return ref(ref(storage, recorded.parent), recorded.input);
}

/** Replay one recorded `ref()` call and assert its bucket + path fields or its error code. */
function expectRefCase(storage: ClientFirebaseStorage, recorded: RefCase): void {
  if (recorded.threw) {
    expect(() => call(storage, recorded)).toThrow(expect.objectContaining({ code: recorded.code }));
    return;
  }
  const made = call(storage, recorded);
  expect({
    bucket: made.bucket,
    fullPath: made.fullPath,
    name: made.name,
  }).toEqual({
    bucket: recorded.bucket,
    fullPath: recorded.fullPath,
    name: recorded.name,
  });
}

const DEFAULT_DENY_ANON_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /public/{path=**} {
      allow read, write: if true;
    }
    match /uploads/{path=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const MEDIA_OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} {
      allow read, write: if bucket == 'media-bucket';
    }
  }
}`;

let seq = 0;

async function connectWorkerBuckets() {
  seq += 1;
  const client = await import('../../../src/serve/worker/client.js');
  const sandbox = initializeSandbox();
  const sessionBackend = createMemoryBackend();
  await sandbox.enablePersistence({ backend: sessionBackend });
  installServedStorageRules(sandbox, {
    storageRules: DEFAULT_DENY_ANON_RULES,
    projectKey: `/ref-url-cross-bucket-${seq}-${Math.random()}`,
    storageBucketRules: {
      'demo-app.appspot.com': { rules: DEFAULT_DENY_ANON_RULES, rulesHash: 'd' },
      'media-bucket': { rules: MEDIA_OPEN_RULES, rulesHash: 'm' },
    },
  });
  getAuth(sandbox);
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: `ref-url-cross-bucket-${seq}`,
    subs: new Map(),
    sessionMode: 'LOCAL',
    sessionBackend,
    appOptions: {
      projectId: 'demo-app',
      storageBucket: 'demo-app.appspot.com',
    },
  };
  const { a: clientPort, b: hostPort } = portPair();
  const toClient: PortLike = { postMessage: (message) => hostPort.postMessage(message) };
  const sent: InboundMessage[] = [];
  hostPort.onmessage = (event) => {
    const message = event.data as InboundMessage;
    sent.push(message);
    void handleMessage(ctx, toClient, message);
  };
  const globalScope = globalThis as { SharedWorker?: unknown };
  const hadSharedWorker = 'SharedWorker' in globalScope;
  const previousSharedWorker = globalScope.SharedWorker;
  globalScope.SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };
  const restoreSharedWorker = () => {
    if (hadSharedWorker) {
      globalScope.SharedWorker = previousSharedWorker;
      return;
    }
    delete globalScope.SharedWorker;
  };
  const db = client.getFirestore(`worker://ref-url-cross-bucket-${seq}`);
  return { sandbox, sent, db, restoreSharedWorker };
}

function bucketsByMethod(sent: readonly InboundMessage[]): Array<[string, string | undefined]> {
  return sent
    .filter((message): message is InboundMessage & { t: 'op'; method: string } =>
      message.t === 'op' && String((message as { method?: unknown }).method).startsWith('storage.'))
    .map((message) => [message.method, (message as { bucket?: string }).bucket]);
}

describe('served client ref(storage, url)', () => {
  const storage = getStorage(fakeDb, undefined, 'b');

  test('storage#110: a gs:// URL gives the reference at its path', () => {
    const plain = requireCase('plainPath');
    const gsDefault = requireCase('gsDefaultBucket');
    expectRefCase(storage, plain);
    expectRefCase(storage, gsDefault);
    expectRefCase(storage, requireCase('gsPathNotDecoded'));
    expectRefCase(storage, requireCase('gsBucketRoot'));
    expectRefCase(storage, requireCase('gsNoBucket'));
    expect(ref(storage, gsDefault.input).bucket).toBe(ref(storage, plain.input).bucket);
  });

  test('storage#111: a download URL gives the reference at its decoded path', () => {
    expectRefCase(storage, requireCase('firebaseDownloadUrl'));
    expectRefCase(storage, requireCase('firebaseDownloadUrlEncoded'));
    expectRefCase(storage, requireCase('cloudStorageUrl'));
    expectRefCase(storage, requireCase('firebaseUrlNoObject'));
  });

  test('storage#112: a URL on another host throws storage/invalid-url', () => {
    expectRefCase(storage, requireCase('otherHostUrl'));
  });

  test("storage#113: the Node host's download URL (KNOWN DIVERGENCE)", () => {
    const pyricHost = requireCase('pyricHostUrl');
    const firebaseDl = requireCase('firebaseDownloadUrl');
    expect(pyricHost.code).toBe('storage/invalid-url');
    const made = ref(storage, pyricHost.input);
    expect({
      bucket: made.bucket,
      fullPath: made.fullPath,
      name: made.name,
    }).toEqual({
      bucket: firebaseDl.bucket,
      fullPath: firebaseDl.fullPath,
      name: firebaseDl.name,
    });
  });

  test("storage#114: ref(storage, url) places the reference on the URL's bucket", () => {
    for (const key of ['gsOtherBucket', 'firebaseDownloadUrlOtherBucket']) {
      const recorded = requireCase(key);
      expectRefCase(storage, recorded);
      const made = ref(storage, recorded.input);
      expect(made.storage).toBe(storage);
      expect(made.toString()).toBe('gs://other-bucket/media/take.wav');
      expect(made.parent?.bucket).toBe('other-bucket');
      expect(made.parent?.storage).toBe(storage);
      expect(made.root.bucket).toBe('other-bucket');
      expect(made.root.storage).toBe(storage);
      const child = ref(made, 'nested.wav');
      expect(child.bucket).toBe('other-bucket');
      expect(child.storage).toBe(storage);
    }
  });

  test('storage#114: cross-bucket ref(defaultStorage, url) routes wire RPCs, data, and per-bucket rules on SharedWorker', async () => {
    const { sandbox, sent, db, restoreSharedWorker } = await connectWorkerBuckets();
    try {
      const defaultStorage = getStorage(db, undefined, 'demo-app.appspot.com', false, 'demo-app.appspot.com');
      const mediaStorage = getStorage(db, undefined, 'media-bucket', true, 'demo-app.appspot.com');

      // Anonymous upload to uploads/a.txt is denied on default bucket, allowed on media-bucket via cross-bucket URL.
      await expect(
        uploadString(ref(defaultStorage, 'uploads/a.txt'), 'denied'),
      ).rejects.toMatchObject({ code: 'storage/unauthorized' });

      sent.length = 0;
      const crossGs = ref(defaultStorage, 'gs://media-bucket/uploads/a.txt');
      const crossDownload = ref(
        defaultStorage,
        'https://firebasestorage.googleapis.com/v0/b/media-bucket/o/uploads%2Fa.txt?alt=media&token=t',
      );
      const uploaded = await uploadString(crossGs, 'cross-media');
      expect(uploaded.metadata.bucket).toBe('media-bucket');

      let listTarget = crossGs.root;
      if (crossGs.parent !== null) {
        listTarget = crossGs.parent;
      }
      const listed = await listAll(listTarget);
      expect(listed.items.map((i) => ({ path: i.fullPath, bucket: i.bucket, sameStorage: i.storage === defaultStorage }))).toEqual([
        { path: 'uploads/a.txt', bucket: 'media-bucket', sameStorage: true },
      ]);

      const meta = await getMetadata(crossDownload);
      expect(meta.bucket).toBe('media-bucket');

      const textViaMediaHandle = new TextDecoder().decode(
        new Uint8Array(await getBytes(ref(mediaStorage, 'uploads/a.txt'))),
      );
      expect(textViaMediaHandle).toBe('cross-media');

      const dataUrl = await getDownloadURL(crossDownload);
      expect(dataUrl.startsWith('data:')).toBe(true);

      await deleteObject(crossDownload);

      expect(bucketsByMethod(sent)).toEqual([
        ['storage.putBytes', 'media-bucket'],
        ['storage.listAll', 'media-bucket'],
        ['storage.getMetadata', 'media-bucket'],
        ['storage.getBytes', 'media-bucket'],
        ['storage.getBytes', 'media-bucket'],
        ['storage.deleteObject', 'media-bucket'],
      ]);

      // Referencing the default bucket by URL from mediaStorage sends no named bucket on the wire.
      sent.length = 0;
      const backToDefault = ref(mediaStorage, 'gs://demo-app.appspot.com/public/note.txt');
      expect(backToDefault.bucket).toBe('demo-app.appspot.com');
      expect(backToDefault.storage).toBe(mediaStorage);
      await uploadString(backToDefault, 'shared-default');
      const readOnDefault = new TextDecoder().decode(
        new Uint8Array(await getBytes(ref(defaultStorage, 'public/note.txt'))),
      );
      expect(readOnDefault).toBe('shared-default');
      expect(bucketsByMethod(sent)).toEqual([
        ['storage.putBytes', undefined],
        ['storage.getBytes', undefined],
      ]);

      // Undeployed cross-bucket URL fails closed.
      await expect(
        uploadString(ref(defaultStorage, 'gs://undeployed-bucket/public/x.txt'), 'locked'),
      ).rejects.toMatchObject({ code: 'storage/unauthorized' });
    } finally {
      restoreSharedWorker();
      sandbox.dispose();
    }
  });

  test('storage#115: a data: URI (KNOWN DIVERGENCE)', () => {
    const dataUri = requireCase('dataUri');
    expect(dataUri.fullPath).toBe(dataUri.input);
    expect(() => ref(storage, dataUri.input)).toThrow(expect.objectContaining({ code: 'storage/invalid-url' }));
  });

  test('storage#116: ref(reference, url) throws storage/invalid-argument', () => {
    expectRefCase(storage, requireCase('childRefWithUrl'));
  });
});
