/**
 * In-process (`pyric/storage`) oracle replay cases for Slice 11:
 *   - `storage-getstorage-handle-and-md5` (`storage#3, #91`)
 *   - `storage-uploadstring-base64url-roundtrip` (`storage#41`)
 *   - `storage-uploadbytesresumable-progress-and-controls` (`storage#47, #48, #49, #50`)
 *   - `storage-updatemetadata-undefined-and-null-clear` (`storage#86`)
 */
import { expect, it } from 'bun:test';
import { deleteApp } from '../../src/app/index.js';
import { createAppForSandbox } from '../../src/app/internal.js';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getBytes,
  getMetadata,
  getStorage,
  getStorageSandbox,
  ref,
  updateMetadata,
  uploadBytes,
  uploadBytesResumable,
  uploadString,
  type FirebaseStorage,
  type FullMetadata,
  type SettableMetadata,
} from '../../src/storage/index.js';

const ALLOW_ALL_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

interface ResumableMetadataOracleHarness {
  load(filename: string): Record<string, unknown>;
  freshStorage(label: string, rules?: string): FirebaseStorage;
}

function projectWritableMetadata(meta: FullMetadata): Record<string, unknown> {
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

export function registerOracleResumableMetadataSuite({
  load,
  freshStorage,
}: ResumableMetadataOracleHarness): void {
  it('storage-getstorage-handle-and-md5 (storage#3, #91)', async () => {
    const obs = load('storage-getstorage-handle-and-md5.json');
    const sandbox = initializeSandbox({});
    const app = createAppForSandbox(
      sandbox,
      { projectId: 'demo-s11', storageBucket: 'demo-s11.appspot.com' },
      `s11-primary-${Math.random().toString(36).slice(2, 10)}`,
    );
    const secondaryApp = createAppForSandbox(
      sandbox,
      { projectId: 'demo-s11', storageBucket: 'demo-s11.appspot.com' },
      `s11-secondary-${Math.random().toString(36).slice(2, 10)}`,
    );
    try {
      getStorageSandbox(sandbox, {
        dbName: `pyric-s11-md5-${Math.random().toString(36).slice(2, 10)}`,
        rules: ALLOW_ALL_RULES,
      });
      const first = getStorage(app);
      const second = getStorage(app);
      const secondaryStorage = getStorage(secondaryApp);

      const defaultMaxOperationRetryTime = first.maxOperationRetryTime;
      const defaultMaxUploadRetryTime = first.maxUploadRetryTime;
      first.maxOperationRetryTime = 45000;
      first.maxUploadRetryTime = 180000;
      const updatedMaxOperationRetryTime = first.maxOperationRetryTime;
      const updatedMaxUploadRetryTime = first.maxUploadRetryTime;
      first.maxOperationRetryTime = defaultMaxOperationRetryTime;
      first.maxUploadRetryTime = defaultMaxUploadRetryTime;

      const emptyRef = ref(first, 'pyric_oracle/getstorage-md5/empty.bin');
      const emptyUp = await uploadBytes(emptyRef, new Uint8Array([]), {
        contentType: 'application/octet-stream',
      });
      const emptyMeta = await getMetadata(emptyRef);

      const fourRef = ref(first, 'pyric_oracle/getstorage-md5/four.bin');
      const fourUp = await uploadBytes(fourRef, new Uint8Array([1, 2, 3, 4]), {
        contentType: 'application/octet-stream',
      });
      const fourMeta = await getMetadata(fourRef);
      const fourBuf = await getBytes(fourRef);

      expect({
        sameAppIdentityStable: first === second,
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
      await deleteApp(secondaryApp);
      await deleteApp(app);
      sandbox.dispose();
    }
  });

  it('storage-uploadstring-base64url-roundtrip (storage#41)', async () => {
    const obs = load('storage-uploadstring-base64url-roundtrip.json');
    const storage = freshStorage('uploadstring-base64url-s11');

    const r1 = ref(storage, 'pyric_oracle/uploadstring-base64url/unpadded.bin');
    const up1 = await uploadString(r1, '-_8BAg', 'base64url');
    const b1 = [...new Uint8Array(await getBytes(r1))];

    const r2 = ref(storage, 'pyric_oracle/uploadstring-base64url/padded.bin');
    const up2 = await uploadString(r2, '-_8=', 'base64url');
    const b2 = [...new Uint8Array(await getBytes(r2))];

    expect({
      contentType: up1.metadata.contentType ?? null,
      size: up1.metadata.size,
      bytes: b1,
    }).toEqual(obs.unpaddedUrlSafe as Record<string, unknown>);
    expect({
      contentType: up2.metadata.contentType ?? null,
      size: up2.metadata.size,
      bytes: b2,
    }).toEqual(obs.paddedUrlSafe as Record<string, unknown>);

    let threw = false;
    let threwSynchronously = false;
    let code: string | null = null;
    try {
      void uploadString(
        ref(storage, 'pyric_oracle/uploadstring-base64url/unknown.bin'),
        'hello',
        'not-a-valid-format' as unknown as 'raw',
      );
    } catch (err) {
      threw = true;
      threwSynchronously = true;
      code = String((err as { code?: unknown }).code);
    }
    const expectedUnknown = obs.unknownFormat as Record<string, unknown>;
    expect({ threw, threwSynchronously, code }).toEqual({
      threw: expectedUnknown.threw,
      threwSynchronously: expectedUnknown.threwSynchronously,
      code: expectedUnknown.code,
    });
  });

  it('storage-uploadbytesresumable-progress-and-controls (storage#47, #48, #49, #50)', async () => {
    const obs = load('storage-uploadbytesresumable-progress-and-controls.json');
    const storage = freshStorage('resumable-controls-s11');
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
    expect(typeof finalSnap.metadata.md5Hash).toBe('string');
    expect({
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
    }).toEqual(obs.progressAndComplete as Record<string, unknown>);

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
    expect({
      pauseReturnedTrue,
      sawPausedSnapshot,
      pauseWhilePausedReturnedFalse,
      resumeReturnedTrue,
      finalSnapshotState: pausedDone.state,
      storedByteLength: pausedRead.byteLength,
    }).toEqual(obs.pauseAndResume as Record<string, unknown>);

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
    let taskErrorCode: string | null = null;
    try {
      await cancelTask;
    } catch (err) {
      taskRejected = true;
      taskErrorCode = String((err as { code?: unknown }).code);
    }
    unsubCancel();
    let postCancelGetMetadataCode: string | null = null;
    try {
      await getMetadata(cancelRef);
    } catch (err) {
      postCancelGetMetadataCode = String((err as { code?: unknown }).code);
    }
    const expectedCancel = obs.cancelFlow as Record<string, unknown>;
    expect({
      cancelReturnedTrue,
      taskRejected,
      taskErrorCode,
      observerErrorCode,
      completeCalledOnCancel,
      postCancelGetMetadataCode,
    }).toEqual({
      cancelReturnedTrue: expectedCancel.cancelReturnedTrue,
      taskRejected: expectedCancel.taskRejected,
      taskErrorCode: expectedCancel.taskErrorCode,
      observerErrorCode: expectedCancel.observerErrorCode,
      completeCalledOnCancel: expectedCancel.completeCalledOnCancel,
      postCancelGetMetadataCode: expectedCancel.postCancelGetMetadataCode,
    });
  });

  it('storage-updatemetadata-undefined-and-null-clear (storage#86)', async () => {
    const obs = load('storage-updatemetadata-undefined-and-null-clear.json');
    const storage = freshStorage('updatemetadata-undefined-null-s11');
    const targetRef = ref(storage, 'pyric_oracle/updatemetadata-undefined-null/item.txt');

    const up = await uploadBytes(targetRef, new Uint8Array([104, 105]), {
      contentType: 'text/plain',
      cacheControl: 'public, max-age=60',
      contentDisposition: 'inline',
      contentLanguage: 'en',
      customMetadata: { keep: 'yes', drop: 'soon' },
    });
    const seeded = projectWritableMetadata(up.metadata);

    const afterUndefinedFields = projectWritableMetadata(
      await updateMetadata(
        targetRef,
        {
          cacheControl: undefined,
          contentDisposition: undefined,
          contentLanguage: 'fr',
          customMetadata: undefined,
        } as unknown as SettableMetadata,
      ),
    );
    const readAfterUndefined = projectWritableMetadata(await getMetadata(targetRef));

    const afterNullScalarAndKeyClear = projectWritableMetadata(
      await updateMetadata(
        targetRef,
        {
          cacheControl: null,
          contentDisposition: null,
          customMetadata: { keep: 'yes', drop: null },
        } as unknown as SettableMetadata,
      ),
    );
    const readAfterNullScalarAndKeyClear = projectWritableMetadata(await getMetadata(targetRef));

    const afterNullCustomMetadataMap = projectWritableMetadata(
      await updateMetadata(targetRef, { customMetadata: null } as unknown as SettableMetadata),
    );
    const readAfterNullCustomMetadataMap = projectWritableMetadata(await getMetadata(targetRef));

    expect({
      seeded,
      afterUndefinedFields,
      readAfterUndefined,
      afterNullScalarAndKeyClear,
      readAfterNullScalarAndKeyClear,
      afterNullCustomMetadataMap,
      readAfterNullCustomMetadataMap,
    }).toEqual(obs);
  });
}
