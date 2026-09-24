import { storageTaskProgress, storageTaskResult } from 'pyric/storage/internal';
/**
 * Worker-mode resumable upload operations: `uploadBytesResumable` and observer tasks.
 *
 * On a host with a byte route, the task sends the object a slice at a time and
 * reports progress as each slice lands; pausing stops between slices, and
 * resuming asks the host how much it holds before continuing. Elsewhere it
 * emits one intermediate progress event before a single `uploadBytes` call.
 */
import type { FullMetadata } from 'pyric/storage';
import { sandboxNow } from './clock.js';
import type { ClientStorageReference, ClientSettableMetadata, RouteUpload } from './storage.js';
import {
  abortRouteUpload, beginRouteUpload, byteRouteOf, deleteObject, finishRouteUpload, routeUploadOffset,
  sendRouteSlice, uploadBlobOf, uploadBytes,
} from './storage.js';

export type ClientTaskState = 'running' | 'paused' | 'success' | 'canceled' | 'error';

export interface ClientUploadTaskSnapshot {
  readonly bytesTransferred: number;
  readonly totalBytes: number;
  readonly state: ClientTaskState;
  readonly metadata: FullMetadata;
  readonly ref: ClientStorageReference;
  readonly task: ClientUploadTask;
}

export interface ClientUploadTask extends Promise<ClientUploadTaskSnapshot> {
  readonly snapshot: ClientUploadTaskSnapshot;
  cancel(): boolean;
  pause(): boolean;
  resume(): boolean;
  on(
    event: string,
    nextOrObserver?:
      | null
      | ((snapshot: ClientUploadTaskSnapshot) => unknown)
      | {
          next?: (snapshot: ClientUploadTaskSnapshot) => unknown;
          error?: (error: Error) => unknown;
          complete?: () => unknown;
        },
    error?: null | ((error: Error) => unknown),
    complete?: null | (() => unknown),
  ): () => void;
}

interface ClientTaskObserver {
  next: ((snapshot: ClientUploadTaskSnapshot) => unknown) | undefined;
  error: ((error: Error) => unknown) | undefined;
  complete: (() => unknown) | undefined;
}

function computePayloadSize(data: Blob | Uint8Array | ArrayBuffer): number {
  const isBlob = data instanceof Blob;
  if (isBlob) {
    return data.size;
  }
  return data.byteLength;
}

function createCanceledError(): Error & { code: string } {
  const err = new Error('storage/canceled: User canceled the upload/download.') as Error & { code: string };
  err.code = 'storage/canceled';
  return err;
}

function createRootOpError(): Error & { code: string } {
  const err = new Error('storage/invalid-root-operation: uploadBytesResumable cannot operate on root reference.') as Error & { code: string };
  err.code = 'storage/invalid-root-operation';
  return err;
}

class ClientUploadTaskImpl implements ClientUploadTask {
  readonly [Symbol.toStringTag] = 'UploadTask';
  private _snapshot: ClientUploadTaskSnapshot;
  private _promise: Promise<ClientUploadTaskSnapshot>;
  private _resolve!: (snapshot: ClientUploadTaskSnapshot) => void;
  private _reject!: (error: Error) => void;
  private _observers: ClientTaskObserver[] = [];
  private _didIntermediateProgress = false;
  private _committing = false;
  private _error: Error | undefined;
  private readonly _ref: ClientStorageReference;
  private readonly _data: Blob | Uint8Array | ArrayBuffer;
  private readonly _metadata: ClientSettableMetadata | undefined;
  /** The upload on the host's byte route, once it has begun. */
  private _upload: RouteUpload | undefined;
  /** The slice request in flight, aborted by a pause or a cancel. */
  private _inFlight: AbortController | undefined;
  private _sending = false;
  /** After a pause the host may hold part of the aborted slice; ask before sending. */
  private _resyncs = false;

  constructor(
    ref: ClientStorageReference,
    data: Blob | Uint8Array | ArrayBuffer,
    metadata?: ClientSettableMetadata,
  ) {
    this._ref = ref;
    this._data = data;
    this._metadata = metadata;

    const size = computePayloadSize(data);
    // The placeholder metadata an in-flight task reports. The stamp is the
    // sandbox clock's, so a paused task's snapshot agrees with the object the
    // host writes when it completes.
    const now = new Date(sandboxNow()).toISOString();

    let contentType = 'application/octet-stream';
    const isBlob = data instanceof Blob;
    if (isBlob) {
      const hasBlobType = data.type !== '';
      if (hasBlobType) {
        contentType = data.type;
      }
    }
    const hasMetadata = metadata !== undefined;
    if (hasMetadata) {
      const hasMetaType = metadata.contentType !== undefined;
      if (hasMetaType) {
        const metaTypeDefined = metadata.contentType;
        if (metaTypeDefined !== undefined) {
          contentType = metaTypeDefined;
        }
      }
    }

    const initialMetadata: FullMetadata = {
      fullPath: ref.fullPath,
      name: ref.name,
      bucket: 'default',
      generation: '1',
      metageneration: '1',
      timeCreated: now,
      updated: now,
      size,
      contentType,
    };

    this._promise = new Promise<ClientUploadTaskSnapshot>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });

    this._promise.catch(() => {});

    this._snapshot = {
      bytesTransferred: 0,
      totalBytes: size,
      state: 'running',
      metadata: initialMetadata,
      ref: this._ref,
      task: this,
    };

    queueMicrotask(() => {
      this._runStep();
    });
  }

  get snapshot(): ClientUploadTaskSnapshot {
    return this._snapshot;
  }

  then<TResult1 = ClientUploadTaskSnapshot, TResult2 = never>(
    onFulfilled?: null | ((value: ClientUploadTaskSnapshot) => TResult1 | PromiseLike<TResult1>),
    onRejected?: null | ((reason: unknown) => TResult2 | PromiseLike<TResult2>),
  ): Promise<TResult1 | TResult2> {
    return this._promise.then(onFulfilled, onRejected);
  }

  catch<TResult = never>(
    onRejected?: null | ((reason: unknown) => TResult | PromiseLike<TResult>),
  ): Promise<ClientUploadTaskSnapshot | TResult> {
    return this._promise.catch(onRejected);
  }

  finally(onFinally?: null | (() => void)): Promise<ClientUploadTaskSnapshot> {
    return this._promise.finally(onFinally);
  }

  pause(): boolean {
    const isRunning = this._snapshot.state === 'running';
    if (isRunning) {
      this._resyncs = true;
      this._inFlight?.abort();
      this._updateSnapshot('paused', this._snapshot.bytesTransferred);
      this._notifyObservers('next');
      return true;
    }
    return false;
  }

  resume(): boolean {
    const isPaused = this._snapshot.state === 'paused';
    if (isPaused) {
      this._updateSnapshot('running', this._snapshot.bytesTransferred);
      this._notifyObservers('next');
      queueMicrotask(() => {
        this._runStep();
      });
      return true;
    }
    return false;
  }

  cancel(): boolean {
    let canCancel = false;
    const isRunning = this._snapshot.state === 'running';
    if (isRunning) {
      canCancel = true;
    } else {
      const isPaused = this._snapshot.state === 'paused';
      if (isPaused) {
        canCancel = true;
      }
    }

    if (canCancel) {
      this._error = createCanceledError();
      this._updateSnapshot('canceled', this._snapshot.bytesTransferred);
      this._inFlight?.abort();
      const upload = this._upload;
      if (upload !== undefined) void abortRouteUpload(upload);
      this._notifyObservers('error');
      this._reject(this._error);
      return true;
    }
    return false;
  }

  on(
    event: string,
    nextOrObserver?:
      | null
      | ((snapshot: ClientUploadTaskSnapshot) => unknown)
      | {
          next?: (snapshot: ClientUploadTaskSnapshot) => unknown;
          error?: (error: Error) => unknown;
          complete?: () => unknown;
        },
    error?: null | ((error: Error) => unknown),
    complete?: null | (() => unknown),
  ): () => void {
    let nextCb: ((snapshot: ClientUploadTaskSnapshot) => unknown) | undefined;
    let errCb: ((error: Error) => unknown) | undefined;
    let compCb: (() => unknown) | undefined;

    let isObjectObserver = false;
    const isObject = typeof nextOrObserver === 'object';
    if (isObject) {
      const isNotNull = nextOrObserver !== null;
      if (isNotNull) {
        isObjectObserver = true;
      }
    }

    if (isObjectObserver) {
      const observerObj = nextOrObserver as {
        next?: (snapshot: ClientUploadTaskSnapshot) => unknown;
        error?: (error: Error) => unknown;
        complete?: () => unknown;
      };
      const hasNext = observerObj.next !== undefined;
      if (hasNext) {
        nextCb = observerObj.next;
      }
      const hasError = observerObj.error !== undefined;
      if (hasError) {
        errCb = observerObj.error;
      }
      const hasComplete = observerObj.complete !== undefined;
      if (hasComplete) {
        compCb = observerObj.complete;
      }
    } else {
      const isFunction = typeof nextOrObserver === 'function';
      if (isFunction) {
        nextCb = nextOrObserver as (snapshot: ClientUploadTaskSnapshot) => unknown;
      }
      const isErrorFunction = typeof error === 'function';
      if (isErrorFunction) {
        errCb = error as (error: Error) => unknown;
      }
      const isCompleteFunction = typeof complete === 'function';
      if (isCompleteFunction) {
        compCb = complete as () => unknown;
      }
    }

    const observer: ClientTaskObserver = { next: nextCb, error: errCb, complete: compCb };
    this._observers.push(observer);

    const isCurrentlyRunning = this._snapshot.state === 'running';
    if (isCurrentlyRunning) {
      const hasNextCb = nextCb !== undefined;
      if (hasNextCb) {
        const fn = nextCb as (snapshot: ClientUploadTaskSnapshot) => unknown;
        try {
          storageTaskProgress(this);
            fn(this._snapshot);
        } catch {
          // Observational
        }
      }
    } else {
      const isCurrentlyPaused = this._snapshot.state === 'paused';
      if (isCurrentlyPaused) {
        const hasNextCb = nextCb !== undefined;
        if (hasNextCb) {
          const fn = nextCb as (snapshot: ClientUploadTaskSnapshot) => unknown;
          try {
            storageTaskProgress(this);
            fn(this._snapshot);
          } catch {
            // Observational
          }
        }
      } else {
        const isAlreadySuccess = this._snapshot.state === 'success';
        if (isAlreadySuccess) {
          const hasNextCb = nextCb !== undefined;
          if (hasNextCb) {
            const fn = nextCb as (snapshot: ClientUploadTaskSnapshot) => unknown;
            try {
              storageTaskProgress(this);
            fn(this._snapshot);
            } catch {
              // Observational
            }
          }
          const hasCompleteCb = compCb !== undefined;
          if (hasCompleteCb) {
            const fn = compCb as () => unknown;
            try {
              storageTaskResult(this);
            fn();
            } catch {
              // Observational
            }
          }
        } else {
          const isAlreadyError = this._snapshot.state === 'error';
          if (isAlreadyError) {
            const hasErrCb = errCb !== undefined;
            if (hasErrCb) {
              const hasStoredError = this._error !== undefined;
              if (hasStoredError) {
                const fn = errCb as (error: Error) => unknown;
                const err = this._error as Error;
                try {
                  fn(err);
                } catch {
                  // Observational
                }
              }
            }
          } else {
            const isAlreadyCanceled = this._snapshot.state === 'canceled';
            if (isAlreadyCanceled) {
              const hasErrCb = errCb !== undefined;
              if (hasErrCb) {
                const hasStoredError = this._error !== undefined;
                if (hasStoredError) {
                  const fn = errCb as (error: Error) => unknown;
                  const err = this._error as Error;
                  try {
                    fn(err);
                  } catch {
                    // Observational
                  }
                }
              }
            }
          }
        }
      }
    }

    return () => {
      const index = this._observers.indexOf(observer);
      const isFound = index !== -1;
      if (isFound) {
        this._observers.splice(index, 1);
      }
    };
  }

  private _updateSnapshot(state: ClientTaskState, bytesTransferred: number, metadata?: FullMetadata): void {
    let nextMetadata = this._snapshot.metadata;
    const isNewMetadata = metadata !== undefined;
    if (isNewMetadata) {
      nextMetadata = metadata;
    }
    this._snapshot = {
      bytesTransferred,
      totalBytes: this._snapshot.totalBytes,
      state,
      metadata: nextMetadata,
      ref: this._ref,
      task: this,
    };
  }

  private _notifyObservers(kind: 'next' | 'error' | 'complete'): void {
    const isNext = kind === 'next';
    if (isNext) {
      for (const obs of this._observers) {
        const hasNext = obs.next !== undefined;
        if (hasNext) {
          const fn = obs.next as (snapshot: ClientUploadTaskSnapshot) => unknown;
          try {
            storageTaskProgress(this);
            fn(this._snapshot);
          } catch {
            // Ignore observer exceptions
          }
        }
      }
    }

    const isError = kind === 'error';
    if (isError) {
      for (const obs of this._observers) {
        const hasError = obs.error !== undefined;
        if (hasError) {
          const isErrorDefined = this._error !== undefined;
          if (isErrorDefined) {
            const fn = obs.error as (error: Error) => unknown;
            const err = this._error as Error;
            try {
              fn(err);
            } catch {
              // Ignore observer exceptions
            }
          }
        }
      }
    }

    const isComplete = kind === 'complete';
    if (isComplete) {
      for (const obs of this._observers) {
        const hasComplete = obs.complete !== undefined;
        if (hasComplete) {
          const fn = obs.complete as () => unknown;
          try {
            storageTaskResult(this);
            fn();
          } catch {
            // Ignore observer exceptions
          }
        }
      }
    }
  }

  /**
   * Send the object over the byte route a slice at a time, reporting progress
   * as each lands, then commit it over the RPC. A pause or a cancel aborts the
   * slice in flight and ends this loop; resuming starts another.
   */
  private async _sendOverRoute(): Promise<void> {
    if (this._sending) return;
    this._sending = true;
    const data = uploadBlobOf(this._data);
    const running = () => this._snapshot.state === 'running';
    try {
      const route = byteRouteOf(this._ref)!;
      let upload = this._upload;
      if (upload === undefined) {
        const contentType = this._metadata?.contentType ?? (data.type !== '' ? data.type : undefined);
        upload = await beginRouteUpload(this._ref, route, data.size, contentType, this._metadata);
        this._upload = upload;
        const canceled = this._snapshot.state === 'canceled';
        if (canceled) await abortRouteUpload(upload);
        if (!running()) return;
      }
      let offset = this._snapshot.bytesTransferred;
      if (this._resyncs) {
        offset = await routeUploadOffset(upload);
        this._resyncs = false;
      }
      while (running() && offset < upload.size) {
        const controller = new AbortController();
        this._inFlight = controller;
        offset = await sendRouteSlice(upload, data, offset, controller.signal);
        this._inFlight = undefined;
        if (!running()) return;
        this._updateSnapshot('running', offset);
        this._notifyObservers('next');
      }
      if (!running()) return;
      const metadata = await finishRouteUpload(upload);
      if (!running()) return;
      this._updateSnapshot('success', upload.size, metadata);
      this._notifyObservers('next');
      this._notifyObservers('complete');
      this._resolve(this._snapshot);
    } catch (error: unknown) {
      this._inFlight = undefined;
      // A pause or a cancel aborts the slice in flight; neither is a failure.
      if (!running()) return;
      this._error = error instanceof Error ? error : new Error(String(error));
      this._updateSnapshot('error', this._snapshot.bytesTransferred);
      const upload = this._upload;
      if (upload !== undefined) await abortRouteUpload(upload);
      this._notifyObservers('error');
      this._reject(this._error);
    } finally {
      this._sending = false;
      // Resumed while the last request was settling: continue now.
      if (running()) queueMicrotask(() => this._runStep());
    }
  }

  private _runStep(): void {
    const isNotRunning = this._snapshot.state !== 'running';
    if (isNotRunning) {
      return;
    }
    const routed = byteRouteOf(this._ref) !== undefined;
    if (routed) {
      void this._sendOverRoute();
      return;
    }

    const needsIntermediate = this._didIntermediateProgress === false;
    if (needsIntermediate) {
      this._didIntermediateProgress = true;
      let middleBytes = 0;
      const hasBytes = this._snapshot.totalBytes > 0;
      if (hasBytes) {
        middleBytes = Math.floor(this._snapshot.totalBytes / 2);
      }
      this._updateSnapshot('running', middleBytes);
      this._notifyObservers('next');
      queueMicrotask(() => {
        this._runStep();
      });
      return;
    }

    this._commitUpload();
  }

  private async _commitUpload(): Promise<void> {
    if (this._committing) return;
    const isNotRunning = this._snapshot.state !== 'running';
    if (isNotRunning) {
      return;
    }

    this._committing = true;
    try {
      const result = await uploadBytes(this._ref, this._data, this._metadata);
      const isStillRunning = this._snapshot.state === 'running';
      if (isStillRunning) {
        this._updateSnapshot('success', this._snapshot.totalBytes, result.metadata);
        this._notifyObservers('next');
        this._notifyObservers('complete');
        this._resolve(this._snapshot);
      } else {
        try {
          await deleteObject(this._ref);
        } catch {
          // Best-effort rollback
        }
      }
    } catch (err: unknown) {
      const isStillRunning = this._snapshot.state === 'running';
      if (isStillRunning) {
        let errObj: Error;
        const isInstanceOfError = err instanceof Error;
        if (isInstanceOfError) {
          errObj = err as Error;
        } else {
          errObj = new Error(String(err));
        }
        this._error = errObj;
        this._updateSnapshot('error', this._snapshot.bytesTransferred);
        this._notifyObservers('error');
        this._reject(this._error);
      }
    } finally {
      this._committing = false;
      if (this._snapshot.state === 'running') queueMicrotask(() => this._runStep());
    }
  }
}

export function uploadBytesResumable(
  reference: ClientStorageReference,
  data: Blob | Uint8Array | ArrayBuffer,
  metadata?: ClientSettableMetadata,
): ClientUploadTask {
  const isRoot = reference.fullPath === '';
  if (isRoot) {
    throw createRootOpError();
  }
  return new ClientUploadTaskImpl(reference, data, metadata);
}
