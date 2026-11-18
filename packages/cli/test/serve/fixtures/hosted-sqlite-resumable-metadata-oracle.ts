import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { FirebaseError } from 'pyric/app';
import { getFirestore } from 'pyric/firestore';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import {
  getStorageSandbox,
  ref as ipRef,
  updateMetadata,
  type FullMetadata,
  type SettableMetadata,
} from 'pyric/storage';
import { installStorageBackend, replaceStorageRules } from 'pyric/storage/internal';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { createStorageByteRoute } from '../../../src/serve/hosted/storage-byte-route.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { uploadTokenOf } from '../../../src/serve/worker/host/storage.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';
import {
  getBytes,
  getMetadata,
  getStorage,
  ref,
  uploadBytes,
  uploadBytesResumable,
  uploadString,
} from '../../../src/serve/worker/client/storage.js';

function observation(name: string): Record<string, unknown> {
  const file = new URL(
    `../../../src/../../conformance/observations/storage/${name}.json`,
    import.meta.url,
  );
  return (JSON.parse(readFileSync(file, 'utf8')) as { behavior: Record<string, unknown> }).behavior;
}

function projectWritableMetadata(meta: FullMetadata): Record<string, unknown> {
  let contentType: string | null = null;
  if (meta.contentType !== undefined) contentType = meta.contentType;
  let cacheControl: string | null = null;
  if (meta.cacheControl !== undefined) cacheControl = meta.cacheControl;
  let contentDisposition: string | null = null;
  if (meta.contentDisposition !== undefined) contentDisposition = meta.contentDisposition;
  let contentLanguage: string | null = null;
  if (meta.contentLanguage !== undefined) contentLanguage = meta.contentLanguage;
  let customMetadata: Record<string, string> | null = null;
  if (meta.customMetadata !== undefined) customMetadata = meta.customMetadata;
  return { contentType, cacheControl, contentDisposition, contentLanguage, customMetadata };
}

function buildResumablePayload(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = i % 251;
  return out;
}

const rawRootArg = process.argv[2] ?? '.';
const SESSION = 'session-token-s11-oracle';

const persistence = await createHostedPersistence(join(rawRootArg, 'project'));
const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
installStorageBackend(sandbox, persistence.storage);
await replaceStorageRules(sandbox, `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pyric_oracle/{rest=**} { allow read, write: if true; }
  }
}`);

const ctx: HostCtx = {
  sandbox,
  db: getFirestore(sandbox),
  instanceId: 's11-resumable-metadata-oracle',
  subs: new Map(),
  storageByteRoute: true,
};
const route = createStorageByteRoute({
  storage: persistence.storage,
  sessionToken: SESSION,
  uploadToken: (id) => uploadTokenOf(ctx, id),
});
const server = createServer((request, response) => {
  const rawUrl = request.url ?? '/';
  const parsedUrl = new URL(rawUrl, 'http://localhost');
  void route(request, response, parsedUrl).then((handled) => {
    if (!handled) response.writeHead(404).end();
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

let clientPort: ClientPort;
const hostPort: PortLike = {
  postMessage(message: unknown) {
    queueMicrotask(() => clientPort.onmessage?.(new MessageEvent('message', { data: message })));
  },
};
clientPort = {
  onmessage: null,
  start() {},
  close() {},
  postMessage(message: unknown) {
    void handleMessage(ctx, hostPort, message as InboundMessage);
  },
  byteRoute: { baseUrl: base, sessionToken: async () => SESSION },
};
wirePort(clientPort);
const storage = getStorage({ __kind: 'client-db', port: clientPort } as never);
const ipStorage = getStorageSandbox(sandbox);

try {
  // 1. storage-getstorage-handle-and-md5 (storage#3, #91)
  {
    const obs = observation('storage-getstorage-handle-and-md5');
    assert.equal(storage.maxOperationRetryTime, obs.defaultMaxOperationRetryTime);
    assert.equal(storage.maxUploadRetryTime, obs.defaultMaxUploadRetryTime);
    storage.maxOperationRetryTime = 45000;
    storage.maxUploadRetryTime = 180000;
    assert.equal(storage.maxOperationRetryTime, obs.updatedMaxOperationRetryTime);
    assert.equal(storage.maxUploadRetryTime, obs.updatedMaxUploadRetryTime);
    storage.maxOperationRetryTime = obs.defaultMaxOperationRetryTime as number;
    storage.maxUploadRetryTime = obs.defaultMaxUploadRetryTime as number;

    const emptyRef = ref(storage, 'pyric_oracle/getstorage-md5/empty.bin');
    const emptyUp = await uploadBytes(emptyRef, new Uint8Array([]), {
      contentType: 'application/octet-stream',
    });
    const emptyMeta = await getMetadata(emptyRef);
    assert.equal(emptyUp.metadata.md5Hash, obs.emptyPayloadMd5OnUpload);
    assert.equal(emptyMeta.md5Hash, obs.emptyPayloadMd5OnGetMetadata);

    const fourRef = ref(storage, 'pyric_oracle/getstorage-md5/four.bin');
    const fourUp = await uploadBytes(fourRef, new Uint8Array([1, 2, 3, 4]), {
      contentType: 'application/octet-stream',
    });
    const fourMeta = await getMetadata(fourRef);
    const fourBuf = await getBytes(fourRef);
    assert.equal(fourUp.metadata.md5Hash, obs.fourBytePayloadMd5OnUpload);
    assert.equal(fourMeta.md5Hash, obs.fourBytePayloadMd5OnGetMetadata);
    assert.deepEqual([...new Uint8Array(fourBuf)], obs.roundtripBytes);
  }

  // 2. storage-uploadstring-base64url-roundtrip (storage#41)
  {
    const obs = observation('storage-uploadstring-base64url-roundtrip');
    const r1 = ref(storage, 'pyric_oracle/uploadstring-base64url/unpadded.bin');
    const up1 = await uploadString(r1, '-_8BAg', 'base64url');
    const b1 = [...new Uint8Array(await getBytes(r1))];

    const r2 = ref(storage, 'pyric_oracle/uploadstring-base64url/padded.bin');
    const up2 = await uploadString(r2, '-_8=', 'base64url');
    const b2 = [...new Uint8Array(await getBytes(r2))];

    let threw = false;
    let threwSynchronously = false;
    let caught: unknown = null;
    try {
      void uploadString(
        ref(storage, 'pyric_oracle/uploadstring-base64url/unknown.bin'),
        'hello',
        'not-a-valid-format' as unknown as 'raw',
      );
    } catch (err) {
      threw = true;
      threwSynchronously = true;
      caught = err;
    }
    assert.deepEqual(
      {
        unpaddedUrlSafe: {
          contentType: up1.metadata.contentType ?? null,
          size: up1.metadata.size,
          bytes: b1,
        },
        paddedUrlSafe: {
          contentType: up2.metadata.contentType ?? null,
          size: up2.metadata.size,
          bytes: b2,
        },
        unknownFormat: {
          threw,
          threwSynchronously,
          code: String((caught as { code?: unknown }).code),
          errorName: String((caught as { name?: unknown }).name),
          isFirebaseError: caught instanceof FirebaseError,
        },
      },
      obs,
    );
  }

  // 3. storage-uploadbytesresumable-progress-and-controls (storage#47..50)
  {
    const obs = observation('storage-uploadbytesresumable-progress-and-controls');
    const payload = buildResumablePayload(obs.payloadByteLength as number);

    const completeRef = ref(storage, 'pyric_oracle/resumable/complete.bin');
    const task = uploadBytesResumable(completeRef, payload, {
      contentType: 'application/octet-stream',
      customMetadata: { mode: 'resumable' },
    });
    const snapshots: Array<{ state: string; bytesTransferred: number; totalBytes: number }> = [];
    let completeCalls = 0;
    let errorCalls = 0;
    const unsubscribe = task.on(
      'state_changed',
      (snap) => {
        snapshots.push({
          state: snap.state,
          bytesTransferred: snap.bytesTransferred,
          totalBytes: snap.totalBytes,
        });
      },
      () => {
        errorCalls += 1;
      },
      () => {
        completeCalls += 1;
      },
    );
    const finalSnap = await task;
    unsubscribe();

    let bytesMonotonicNonDecreasing = true;
    for (let i = 1; i < snapshots.length; i += 1) {
      const prev = snapshots[i - 1];
      const curr = snapshots[i];
      if (prev && curr && curr.bytesTransferred < prev.bytesTransferred) {
        bytesMonotonicNonDecreasing = false;
      }
    }
    const storedArr = new Uint8Array(await getBytes(completeRef));
    assert.equal(typeof finalSnap.metadata.md5Hash, 'string');

    const pauseRef = ref(storage, 'pyric_oracle/resumable/pause-resume.bin');
    const pauseTask = uploadBytesResumable(pauseRef, payload, {
      contentType: 'application/octet-stream',
    });
    let sawPausedSnapshot = false;
    let pauseWhilePausedReturnedFalse = false;
    let resumeReturnedTrue = false;
    let pausedHandled = false;
    const unsubPause = pauseTask.on('state_changed', (snap) => {
      if (snap.state === 'paused' && !pausedHandled) {
        pausedHandled = true;
        sawPausedSnapshot = true;
        pauseWhilePausedReturnedFalse = pauseTask.pause() === false;
        resumeReturnedTrue = pauseTask.resume();
      }
    });
    const pauseReturnedTrue = pauseTask.pause();
    const pausedDone = await pauseTask;
    unsubPause();
    const pausedRead = await getBytes(pauseRef);

    const cancelRef = ref(storage, 'pyric_oracle/resumable/cancel.bin');
    const cancelTask = uploadBytesResumable(cancelRef, payload, {
      contentType: 'application/octet-stream',
    });
    let observerErrorCode: string | null = null;
    let completeCalledOnCancel = false;
    const unsubCancel = cancelTask.on(
      'state_changed',
      () => undefined,
      (err) => {
        observerErrorCode = String((err as { code?: unknown }).code);
      },
      () => {
        completeCalledOnCancel = true;
      },
    );
    const cancelReturnedTrue = cancelTask.cancel();
    let taskRejected = false;
    let taskCaught: unknown = null;
    try {
      await cancelTask;
    } catch (err) {
      taskRejected = true;
      taskCaught = err;
    }
    unsubCancel();

    let postCancelGetMetadataCode: string | null = null;
    try {
      await getMetadata(cancelRef);
    } catch (err) {
      postCancelGetMetadataCode = String((err as { code?: unknown }).code);
    }

    assert.deepEqual(
      {
        payloadByteLength: payload.byteLength,
        progressAndComplete: {
          hasPauseMethod: typeof task.pause === 'function',
          hasResumeMethod: typeof task.resume === 'function',
          hasCancelMethod: typeof task.cancel === 'function',
          hasOnMethod: typeof task.on === 'function',
          unsubscribeIsFunction: typeof unsubscribe === 'function',
          sawRunningSnapshot: snapshots.some((s) => s.state === 'running'),
          bytesMonotonicNonDecreasing,
          allTotalBytesMatchPayload: snapshots.every((s) => s.totalBytes === payload.byteLength),
          completeCallbackFiredOnce: completeCalls === 1,
          errorCallbackFired: errorCalls > 0,
          finalSnapshotState: finalSnap.state,
          finalBytesTransferred: finalSnap.bytesTransferred,
          finalTotalBytes: finalSnap.totalBytes,
          metadataContentType: finalSnap.metadata.contentType ?? null,
          storedByteLength: storedArr.byteLength,
          firstFourBytes: [...storedArr.slice(0, 4)],
          lastFourBytes: [...storedArr.slice(storedArr.byteLength - 4)],
        },
        pauseAndResume: {
          pauseReturnedTrue,
          sawPausedSnapshot,
          pauseWhilePausedReturnedFalse,
          resumeReturnedTrue,
          finalSnapshotState: pausedDone.state,
          storedByteLength: pausedRead.byteLength,
        },
        cancelFlow: {
          cancelReturnedTrue,
          taskRejected,
          taskErrorCode: String((taskCaught as { code?: unknown }).code),
          taskErrorIsFirebaseError: taskCaught instanceof FirebaseError,
          observerErrorCode,
          completeCalledOnCancel,
          postCancelGetMetadataCode,
        },
      },
      obs,
    );
  }

  // 4. storage-updatemetadata-undefined-and-null-clear (storage#86)
  {
    const obs = observation('storage-updatemetadata-undefined-and-null-clear');
    const path = 'pyric_oracle/updatemetadata-undefined-null/item.txt';
    const hostedRef = ref(storage, path);
    const localRef = ipRef(ipStorage, path);

    const up = await uploadBytes(hostedRef, new Uint8Array([104, 105]), {
      contentType: 'text/plain',
      cacheControl: 'public, max-age=60',
      contentDisposition: 'inline',
      contentLanguage: 'en',
      customMetadata: { keep: 'yes', drop: 'soon' },
    });
    const seeded = projectWritableMetadata(up.metadata);

    const afterUndefinedFields = projectWritableMetadata(
      await updateMetadata(
        localRef,
        {
          cacheControl: undefined,
          contentDisposition: undefined,
          contentLanguage: 'fr',
          customMetadata: undefined,
        } as unknown as SettableMetadata,
      ),
    );
    const readAfterUndefined = projectWritableMetadata(await getMetadata(hostedRef));

    const afterNullScalarAndKeyClear = projectWritableMetadata(
      await updateMetadata(
        localRef,
        {
          cacheControl: null,
          contentDisposition: null,
          customMetadata: { keep: 'yes', drop: null },
        } as unknown as SettableMetadata,
      ),
    );
    const readAfterNullScalarAndKeyClear = projectWritableMetadata(await getMetadata(hostedRef));

    const afterNullCustomMetadataMap = projectWritableMetadata(
      await updateMetadata(localRef, { customMetadata: null } as unknown as SettableMetadata),
    );
    const readAfterNullCustomMetadataMap = projectWritableMetadata(await getMetadata(hostedRef));

    assert.deepEqual(
      {
        seeded,
        afterUndefinedFields,
        readAfterUndefined,
        afterNullScalarAndKeyClear,
        readAfterNullScalarAndKeyClear,
        afterNullCustomMetadataMap,
        readAfterNullCustomMetadataMap,
      },
      obs,
    );
  }

  console.log('Resumable upload, getStorage, base64url, and metadata oracle replay passed');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await persistence.close();
  sandbox.dispose();
}
