/**
 * Served-entry + SharedWorker + in-process conformance for Slice 11
 * (`storage#3, #41, #47, #48, #49, #50, #86, #91`):
 *   - `storage-getstorage-handle-and-md5` (`storage#3, #91`)
 *   - `storage-uploadstring-base64url-roundtrip` (`storage#41`)
 *   - `storage-uploadbytesresumable-progress-and-controls` (`storage#47..50`)
 *   - `storage-updatemetadata-undefined-and-null-clear` (`storage#86`)
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { FirebaseError, deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as ip from 'pyric/storage';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

function loadBehavior(name: string): Record<string, unknown> {
  const fileUrl = new URL(
    `../../../../conformance/observations/storage/${name}.json`,
    import.meta.url,
  );
  const parsed = JSON.parse(readFileSync(fileUrl, 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return parsed.behavior;
}

function projectWritableMetadata(meta: ip.FullMetadata): Record<string, unknown> {
  let contentType: string | null = null;
  if (meta.contentType !== undefined) {
    contentType = meta.contentType;
  }
  let cacheControl: string | null = null;
  if (meta.cacheControl !== undefined) {
    cacheControl = meta.cacheControl;
  }
  let contentDisposition: string | null = null;
  if (meta.contentDisposition !== undefined) {
    contentDisposition = meta.contentDisposition;
  }
  let contentLanguage: string | null = null;
  if (meta.contentLanguage !== undefined) {
    contentLanguage = meta.contentLanguage;
  }
  let customMetadata: Record<string, string> | null = null;
  if (meta.customMetadata !== undefined) {
    customMetadata = meta.customMetadata;
  }
  return {
    contentType,
    cacheControl,
    contentDisposition,
    contentLanguage,
    customMetadata,
  };
}

function buildResumablePayload(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = i % 251;
  }
  return out;
}

let appSeq = 0;

describe('served entry + SharedWorker Slice 11 Storage parity (storage#3, #41, #47..50, #86, #91)', () => {
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
          const inbound = event.data as InboundMessage;
          void handleMessage(ctx, hostPortLike, inbound);
        };
        this.port = clientPort;
      }
    };

    const served = await import('../../../src/serve/entries/storage.js');
    const app = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage-s11', storageBucket: 'buckets-default' },
      `served-s11-primary-${++appSeq}`,
    );
    const secondaryApp = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage-s11', storageBucket: 'buckets-default' },
      `served-s11-secondary-${++appSeq}`,
    );
    const storage = served.getStorage(app);
    const ipStorage = ip.getStorageSandbox(ctx.sandbox);

    return {
      ctx,
      app,
      secondaryApp,
      served,
      storage,
      ipStorage,
      cleanup: async () => {
        await deleteApp(secondaryApp);
        await deleteApp(app);
        ctx.sandbox.dispose();
      },
    };
  }

  test('replays storage-getstorage-handle-and-md5 across served getStorage(app), uploadBytes, and getMetadata (storage#3, #91)', async () => {
    const obs = loadBehavior('storage-getstorage-handle-and-md5');
    const { app, secondaryApp, served, storage, cleanup } = await setupServedStorage();
    try {
      const first = served.getStorage(app);
      const second = served.getStorage(app);
      const secondaryStorage = served.getStorage(secondaryApp);

      const defaultMaxOperationRetryTime = first.maxOperationRetryTime;
      const defaultMaxUploadRetryTime = first.maxUploadRetryTime;
      first.maxOperationRetryTime = 45000;
      first.maxUploadRetryTime = 180000;
      const updatedMaxOperationRetryTime = first.maxOperationRetryTime;
      const updatedMaxUploadRetryTime = first.maxUploadRetryTime;
      first.maxOperationRetryTime = defaultMaxOperationRetryTime;
      first.maxUploadRetryTime = defaultMaxUploadRetryTime;

      const emptyRef = served.ref(storage, 'pyric_oracle/getstorage-md5/empty.bin');
      const emptyUp = await served.uploadBytes(emptyRef, new Uint8Array([]), {
        contentType: 'application/octet-stream',
      });
      const emptyMeta = await served.getMetadata(emptyRef);

      const fourRef = served.ref(storage, 'pyric_oracle/getstorage-md5/four.bin');
      const fourUp = await served.uploadBytes(fourRef, new Uint8Array([1, 2, 3, 4]), {
        contentType: 'application/octet-stream',
      });
      const fourMeta = await served.getMetadata(fourRef);
      const fourBuf = await served.getBytes(fourRef);

      expect({
        sameAppIdentityStable: first === second && first === storage,
        differentAppDistinctHandle: first !== secondaryStorage,
        appPropertyMatches: first.app === app,
        defaultMaxOperationRetryTime,
        defaultMaxUploadRetryTime,
        updatedMaxOperationRetryTime,
        updatedMaxUploadRetryTime,
        emptyPayloadMd5OnUpload: emptyUp.metadata.md5Hash ?? null,
        emptyPayloadMd5OnGetMetadata: emptyMeta.md5Hash ?? null,
        emptyPayloadMd5MatchesUploadAndGet:
          emptyUp.metadata.md5Hash !== undefined &&
          emptyUp.metadata.md5Hash === emptyMeta.md5Hash,
        fourBytePayloadMd5OnUpload: fourUp.metadata.md5Hash ?? null,
        fourBytePayloadMd5OnGetMetadata: fourMeta.md5Hash ?? null,
        fourBytePayloadMd5MatchesUploadAndGet:
          fourUp.metadata.md5Hash !== undefined &&
          fourUp.metadata.md5Hash === fourMeta.md5Hash,
        roundtripBytes: [...new Uint8Array(fourBuf)],
      }).toEqual(obs);
    } finally {
      await cleanup();
    }
  });

  test('replays storage-uploadstring-base64url-roundtrip and synchronous storage/unknown throw (storage#41)', async () => {
    const obs = loadBehavior('storage-uploadstring-base64url-roundtrip');
    const { served, storage, cleanup } = await setupServedStorage();
    try {
      const r1 = served.ref(storage, 'pyric_oracle/uploadstring-base64url/unpadded.bin');
      const up1 = await served.uploadString(r1, '-_8BAg', 'base64url');
      const b1 = [...new Uint8Array(await served.getBytes(r1))];

      const r2 = served.ref(storage, 'pyric_oracle/uploadstring-base64url/padded.bin');
      const up2 = await served.uploadString(r2, '-_8=', 'base64url');
      const b2 = [...new Uint8Array(await served.getBytes(r2))];

      let threw = false;
      let threwSynchronously = false;
      let caught: unknown = null;
      try {
        void served.uploadString(
          served.ref(storage, 'pyric_oracle/uploadstring-base64url/unknown.bin'),
          'hello',
          'not-a-valid-format' as unknown as 'raw',
        );
      } catch (err) {
        threw = true;
        threwSynchronously = true;
        caught = err;
      }

      expect({
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
      }).toEqual(obs);
    } finally {
      await cleanup();
    }
  });

  test('replays storage-uploadbytesresumable-progress-and-controls over SharedWorker (storage#47..50)', async () => {
    const obs = loadBehavior('storage-uploadbytesresumable-progress-and-controls');
    const { served, storage, cleanup } = await setupServedStorage();
    try {
      const payload = buildResumablePayload(obs.payloadByteLength as number);

      const completeRef = served.ref(storage, 'pyric_oracle/resumable/complete.bin');
      const task = served.uploadBytesResumable(completeRef, payload, {
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
      const storedArr = new Uint8Array(await served.getBytes(completeRef));
      expect(typeof finalSnap.metadata.md5Hash).toBe('string');

      const pauseRef = served.ref(storage, 'pyric_oracle/resumable/pause-resume.bin');
      const pauseTask = served.uploadBytesResumable(pauseRef, payload, {
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
      const pausedRead = await served.getBytes(pauseRef);

      const cancelRef = served.ref(storage, 'pyric_oracle/resumable/cancel.bin');
      const cancelTask = served.uploadBytesResumable(cancelRef, payload, {
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
        await served.getMetadata(cancelRef);
      } catch (err) {
        postCancelGetMetadataCode = String((err as { code?: unknown }).code);
      }

      expect({
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
      }).toEqual(obs);
    } finally {
      await cleanup();
    }
  });

  test('replays storage-updatemetadata-undefined-and-null-clear and reads back cleared metadata over SharedWorker (storage#86)', async () => {
    const obs = loadBehavior('storage-updatemetadata-undefined-and-null-clear');
    const { served, storage, ipStorage, cleanup } = await setupServedStorage();
    try {
      const path = 'pyric_oracle/updatemetadata-undefined-null/item.txt';
      const servedRef = served.ref(storage, path);
      const ipRef = ip.ref(ipStorage, path);

      const up = await served.uploadBytes(servedRef, new Uint8Array([104, 105]), {
        contentType: 'text/plain',
        cacheControl: 'public, max-age=60',
        contentDisposition: 'inline',
        contentLanguage: 'en',
        customMetadata: { keep: 'yes', drop: 'soon' },
      });
      const seeded = projectWritableMetadata(up.metadata);

      const afterUndefinedFields = projectWritableMetadata(
        await ip.updateMetadata(
          ipRef,
          {
            cacheControl: undefined,
            contentDisposition: undefined,
            contentLanguage: 'fr',
            customMetadata: undefined,
          } as unknown as ip.SettableMetadata,
        ),
      );
      const readAfterUndefined = projectWritableMetadata(await served.getMetadata(servedRef));

      const afterNullScalarAndKeyClear = projectWritableMetadata(
        await ip.updateMetadata(
          ipRef,
          {
            cacheControl: null,
            contentDisposition: null,
            customMetadata: { keep: 'yes', drop: null },
          } as unknown as ip.SettableMetadata,
        ),
      );
      const readAfterNullScalarAndKeyClear = projectWritableMetadata(
        await served.getMetadata(servedRef),
      );

      const afterNullCustomMetadataMap = projectWritableMetadata(
        await ip.updateMetadata(ipRef, { customMetadata: null } as unknown as ip.SettableMetadata),
      );
      const readAfterNullCustomMetadataMap = projectWritableMetadata(
        await served.getMetadata(servedRef),
      );

      expect({
        seeded,
        afterUndefinedFields,
        readAfterUndefined,
        afterNullScalarAndKeyClear,
        readAfterNullScalarAndKeyClear,
        afterNullCustomMetadataMap,
        readAfterNullCustomMetadataMap,
      }).toEqual(obs);
    } finally {
      await cleanup();
    }
  });
});
