import type { Probe } from '../../rigs/types.ts';
import { extractObservedErrorDetails, withStorageProbeSession } from '../../src/storage-probe-session.ts';

export const RESUMABLE_PROBE_BYTE_LENGTH = 300 * 1024;

export function buildDeterministicResumablePayload(length: number = RESUMABLE_PROBE_BYTE_LENGTH): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = i % 251;
  }
  return out;
}

interface ResumableProgressCompleteOutcome {
  hasPauseMethod: boolean;
  hasResumeMethod: boolean;
  hasCancelMethod: boolean;
  hasOnMethod: boolean;
  unsubscribeIsFunction: boolean;
  sawRunningSnapshot: boolean;
  bytesMonotonicNonDecreasing: boolean;
  allTotalBytesMatchPayload: boolean;
  completeCallbackFiredOnce: boolean;
  errorCallbackFired: boolean;
  finalSnapshotState: string;
  finalBytesTransferred: number;
  finalTotalBytes: number;
  metadataContentType: string | null;
  storedByteLength: number;
  firstFourBytes: number[];
  lastFourBytes: number[];
}

interface ResumablePauseResumeOutcome {
  pauseReturnedTrue: boolean;
  sawPausedSnapshot: boolean;
  pauseWhilePausedReturnedFalse: boolean;
  resumeReturnedTrue: boolean;
  finalSnapshotState: string;
  storedByteLength: number;
}

interface ResumableCancelOutcome {
  cancelReturnedTrue: boolean;
  taskRejected: boolean;
  taskErrorCode: string | null;
  taskErrorIsFirebaseError: boolean;
  observerErrorCode: string | null;
  completeCalledOnCancel: boolean;
  postCancelGetMetadataCode: string | null;
}

export interface UploadBytesResumableProbeSubject {
  runProgressToCompletion(subpath: string, payload: Uint8Array): Promise<ResumableProgressCompleteOutcome>;
  runPauseAndResume(subpath: string, payload: Uint8Array): Promise<ResumablePauseResumeOutcome>;
  runCancel(subpath: string, payload: Uint8Array): Promise<ResumableCancelOutcome>;
}

export async function observeUploadBytesResumableLifecycle(
  subject: UploadBytesResumableProbeSubject,
): Promise<Record<string, unknown>> {
  const payload = buildDeterministicResumablePayload();
  const progressAndComplete = await subject.runProgressToCompletion(
    'resumable/complete.bin',
    payload,
  );
  const pauseAndResume = await subject.runPauseAndResume(
    'resumable/pause-resume.bin',
    payload,
  );
  const cancelFlow = await subject.runCancel('resumable/cancel.bin', payload);

  return {
    payloadByteLength: payload.byteLength,
    progressAndComplete,
    pauseAndResume,
    cancelFlow,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'storage #47, #48, #49, #50',
  rowIds: ['storage#47', 'storage#48', 'storage#49', 'storage#50'],
  description:
    "firebase/storage uploadBytesResumable(ref, data, metadata): observes UploadTask control methods, state_changed progress snapshots, pause()/resume() state transitions, and cancel() rejecting with storage/canceled without persisting the object.",
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      return observeUploadBytesResumableLifecycle({
        async runProgressToCompletion(subpath, payload) {
          const targetRef = objectRef(subpath);
          const task = storageSdk.uploadBytesResumable(targetRef, payload, {
            contentType: 'application/octet-stream',
            customMetadata: { mode: 'resumable' },
          });
          const snapshots: Array<{ state: string; bytesTransferred: number; totalBytes: number }> = [];
          let completeCalls = 0;
          let errorCalls = 0;
          let completeLatchResolve: (() => void) | undefined;
          const completeLatch = new Promise<void>((resolve) => {
            completeLatchResolve = resolve;
          });

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
              if (completeLatchResolve) completeLatchResolve();
            },
            () => {
              completeCalls += 1;
              if (completeLatchResolve) completeLatchResolve();
            },
          );

          const finalSnap = await task;
          await completeLatch;
          unsubscribe();

          let bytesMonotonicNonDecreasing = true;
          for (let i = 1; i < snapshots.length; i += 1) {
            const prev = snapshots[i - 1];
            const curr = snapshots[i];
            if (prev && curr && curr.bytesTransferred < prev.bytesTransferred) {
              bytesMonotonicNonDecreasing = false;
            }
          }

          const readBuf = await storageSdk.getBytes(targetRef);
          const readArr = new Uint8Array(readBuf);
          let metadataContentType: string | null = null;
          if (finalSnap.metadata.contentType !== undefined) {
            metadataContentType = finalSnap.metadata.contentType;
          }

          return {
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
            metadataContentType,
            storedByteLength: readArr.byteLength,
            firstFourBytes: [...readArr.slice(0, 4)],
            lastFourBytes: [...readArr.slice(readArr.byteLength - 4)],
          };
        },
        async runPauseAndResume(subpath, payload) {
          const targetRef = objectRef(subpath);
          const task = storageSdk.uploadBytesResumable(targetRef, payload, {
            contentType: 'application/octet-stream',
          });

          let sawPausedSnapshot = false;
          let pauseWhilePausedReturnedFalse = false;
          let resumeReturnedTrue = false;
          let pausedHandled = false;

          const unsubscribe = task.on('state_changed', (snap) => {
            if (snap.state === 'paused' && !pausedHandled) {
              pausedHandled = true;
              sawPausedSnapshot = true;
              pauseWhilePausedReturnedFalse = task.pause() === false;
              resumeReturnedTrue = task.resume();
            }
          });

          const pauseReturnedTrue = task.pause();
          if (task.snapshot.state === 'paused' && !pausedHandled) {
            pausedHandled = true;
            sawPausedSnapshot = true;
            pauseWhilePausedReturnedFalse = task.pause() === false;
            resumeReturnedTrue = task.resume();
          }

          const finalSnap = await task;
          unsubscribe();
          const readBuf = await storageSdk.getBytes(targetRef);

          return {
            pauseReturnedTrue,
            sawPausedSnapshot,
            pauseWhilePausedReturnedFalse,
            resumeReturnedTrue,
            finalSnapshotState: finalSnap.state,
            storedByteLength: readBuf.byteLength,
          };
        },
        async runCancel(subpath, payload) {
          const targetRef = objectRef(subpath);
          const task = storageSdk.uploadBytesResumable(targetRef, payload, {
            contentType: 'application/octet-stream',
          });

          let observerError: unknown = null;
          let completeCalledOnCancel = false;
          let errorLatchResolve: (() => void) | undefined;
          const errorLatch = new Promise<void>((resolve) => {
            errorLatchResolve = resolve;
          });

          const unsubscribe = task.on(
            'state_changed',
            () => undefined,
            (err) => {
              observerError = err;
              if (errorLatchResolve) errorLatchResolve();
            },
            () => {
              completeCalledOnCancel = true;
              if (errorLatchResolve) errorLatchResolve();
            },
          );

          const cancelReturnedTrue = task.cancel();
          let taskRejected = false;
          let taskCaught: unknown = null;
          try {
            await task;
          } catch (err) {
            taskRejected = true;
            taskCaught = err;
          }
          await errorLatch;
          unsubscribe();

          let postCancelGetMetadataCode: string | null = null;
          try {
            await storageSdk.getMetadata(targetRef);
          } catch (err) {
            postCancelGetMetadataCode = extractObservedErrorDetails(err).code;
          }

          const taskDetails = extractObservedErrorDetails(taskCaught);
          const observerDetails = extractObservedErrorDetails(observerError);
          return {
            cancelReturnedTrue,
            taskRejected,
            taskErrorCode: taskDetails.code,
            taskErrorIsFirebaseError: taskDetails.isFirebaseError,
            observerErrorCode: observerDetails.code,
            completeCalledOnCancel,
            postCancelGetMetadataCode,
          };
        },
      });
    });
  },
};
