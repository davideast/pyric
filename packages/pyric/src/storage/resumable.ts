/**
 * Resumable upload operations: `uploadBytesResumable` and related task observers.
 *
 * Implements synthetic/mock progress over the sandbox store since no actual network
 * transfer occurs. Maintains the Firebase-shaped public control contract:
 *   - `on('state_changed')` observer behavior
 *   - `pause()`, `resume()`, and `cancel()`
 *   - task snapshots and progress
 *   - committing bytes only when the task successfully completes
 */
import type { EventProvenance } from 'pyric/sandbox';
import type { StorageReference } from './reference.js';
import type { SettableMetadata, FullMetadata } from './metadata.js';
import { toFullMetadata } from './metadata.js';
import { uploadBytes, buildStoredMetadata } from './upload.js';
import { deleteObject } from './download.js';
import { invalidRootOperation, uploadCanceled, type StorageError } from './errors.js';

export type TaskEvent = 'state_changed';
export type TaskState = 'running' | 'paused' | 'success' | 'canceled' | 'error';

export interface UploadTaskSnapshot {
  readonly bytesTransferred: number;
  readonly totalBytes: number;
  readonly state: TaskState;
  readonly metadata: FullMetadata;
  readonly ref: StorageReference;
  readonly task: UploadTask;
}

export interface UploadTask extends Promise<UploadTaskSnapshot> {
  readonly snapshot: UploadTaskSnapshot;
  cancel(): boolean;
  pause(): boolean;
  resume(): boolean;
  on(
    event: TaskEvent | string,
    nextOrObserver?:
      | null
      | ((snapshot: UploadTaskSnapshot) => unknown)
      | {
          next?: (snapshot: UploadTaskSnapshot) => unknown;
          error?: (error: Error | StorageError) => unknown;
          complete?: () => unknown;
        },
    error?: null | ((error: Error | StorageError) => unknown),
    complete?: null | (() => unknown),
  ): () => void;
}

interface TaskObserver {
  next: ((snapshot: UploadTaskSnapshot) => unknown) | undefined;
  error: ((error: Error | StorageError) => unknown) | undefined;
  complete: (() => unknown) | undefined;
}

function normalizeBlob(
  data: Blob | Uint8Array | ArrayBuffer,
  contentTypeHint: string | undefined,
): Blob {
  const isBlob = data instanceof Blob;
  if (isBlob) {
    const hasHint = contentTypeHint !== undefined;
    if (hasHint) {
      const isDifferentType = contentTypeHint !== data.type;
      if (isDifferentType) {
        return new Blob([data], { type: contentTypeHint });
      }
    }
    return data;
  }
  let fallbackType = '';
  const isHintDefined = contentTypeHint !== undefined;
  if (isHintDefined) {
    fallbackType = contentTypeHint;
  }
  return new Blob([data as ArrayBuffer], { type: fallbackType });
}

class UploadTaskImpl implements UploadTask {
  readonly [Symbol.toStringTag] = 'UploadTask';
  private _snapshot: UploadTaskSnapshot;
  private _promise: Promise<UploadTaskSnapshot>;
  private _resolve!: (snapshot: UploadTaskSnapshot) => void;
  private _reject!: (error: Error | StorageError) => void;
  private _observers: TaskObserver[] = [];
  private _didIntermediateProgress = false;
  private _error: Error | StorageError | undefined;
  private readonly _ref: StorageReference;
  private readonly _blob: Blob;
  private readonly _metadata: SettableMetadata | undefined;
  private readonly _provenance: EventProvenance | undefined;

  constructor(
    ref: StorageReference,
    data: Blob | Uint8Array | ArrayBuffer,
    metadata?: SettableMetadata,
    provenance?: EventProvenance,
  ) {
    this._ref = ref;
    this._metadata = metadata;
    this._provenance = provenance;

    let hint: string | undefined;
    const isMetadataDefined = metadata !== undefined;
    if (isMetadataDefined) {
      hint = metadata.contentType;
    }

    this._blob = normalizeBlob(data, hint);
    const stored = buildStoredMetadata({ ref, blob: this._blob, settable: metadata });
    const fullMetadata = toFullMetadata(stored);

    this._promise = new Promise<UploadTaskSnapshot>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });

    // Suppress unhandled rejection warning if caller only uses callbacks without catch
    this._promise.catch(() => {});

    this._snapshot = {
      bytesTransferred: 0,
      totalBytes: this._blob.size,
      state: 'running',
      metadata: fullMetadata,
      ref: this._ref,
      task: this,
    };

    queueMicrotask(() => {
      this._runStep();
    });
  }

  get snapshot(): UploadTaskSnapshot {
    return this._snapshot;
  }

  then<TResult1 = UploadTaskSnapshot, TResult2 = never>(
    onFulfilled?: null | ((value: UploadTaskSnapshot) => TResult1 | PromiseLike<TResult1>),
    onRejected?: null | ((reason: unknown) => TResult2 | PromiseLike<TResult2>),
  ): Promise<TResult1 | TResult2> {
    return this._promise.then(onFulfilled, onRejected);
  }

  catch<TResult = never>(
    onRejected?: null | ((reason: unknown) => TResult | PromiseLike<TResult>),
  ): Promise<UploadTaskSnapshot | TResult> {
    return this._promise.catch(onRejected);
  }

  finally(onFinally?: null | (() => void)): Promise<UploadTaskSnapshot> {
    return this._promise.finally(onFinally);
  }

  pause(): boolean {
    const isRunning = this._snapshot.state === 'running';
    if (isRunning) {
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
      this._error = uploadCanceled();
      this._updateSnapshot('canceled', this._snapshot.bytesTransferred);
      this._notifyObservers('error');
      this._reject(this._error);
      return true;
    }
    return false;
  }

  on(
    event: TaskEvent | string,
    nextOrObserver?:
      | null
      | ((snapshot: UploadTaskSnapshot) => unknown)
      | {
          next?: (snapshot: UploadTaskSnapshot) => unknown;
          error?: (error: Error | StorageError) => unknown;
          complete?: () => unknown;
        },
    error?: null | ((error: Error | StorageError) => unknown),
    complete?: null | (() => unknown),
  ): () => void {
    let nextCb: ((snapshot: UploadTaskSnapshot) => unknown) | undefined;
    let errCb: ((error: Error | StorageError) => unknown) | undefined;
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
        next?: (snapshot: UploadTaskSnapshot) => unknown;
        error?: (error: Error | StorageError) => unknown;
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
        nextCb = nextOrObserver as (snapshot: UploadTaskSnapshot) => unknown;
      }
      const isErrorFunction = typeof error === 'function';
      if (isErrorFunction) {
        errCb = error as (error: Error | StorageError) => unknown;
      }
      const isCompleteFunction = typeof complete === 'function';
      if (isCompleteFunction) {
        compCb = complete as () => unknown;
      }
    }

    const observer: TaskObserver = { next: nextCb, error: errCb, complete: compCb };
    this._observers.push(observer);

    const isCurrentlyRunning = this._snapshot.state === 'running';
    if (isCurrentlyRunning) {
      const hasNextCb = nextCb !== undefined;
      if (hasNextCb) {
        const fn = nextCb as (snapshot: UploadTaskSnapshot) => unknown;
        try {
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
          const fn = nextCb as (snapshot: UploadTaskSnapshot) => unknown;
          try {
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
            const fn = nextCb as (snapshot: UploadTaskSnapshot) => unknown;
            try {
              fn(this._snapshot);
            } catch {
              // Observational
            }
          }
          const hasCompleteCb = compCb !== undefined;
          if (hasCompleteCb) {
            const fn = compCb as () => unknown;
            try {
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
                const fn = errCb as (error: Error | StorageError) => unknown;
                const err = this._error as Error | StorageError;
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
                  const fn = errCb as (error: Error | StorageError) => unknown;
                  const err = this._error as Error | StorageError;
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

  private _updateSnapshot(state: TaskState, bytesTransferred: number, metadata?: FullMetadata): void {
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
          const fn = obs.next as (snapshot: UploadTaskSnapshot) => unknown;
          try {
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
            const fn = obs.error as (error: Error | StorageError) => unknown;
            const err = this._error as Error | StorageError;
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
            fn();
          } catch {
            // Ignore observer exceptions
          }
        }
      }
    }
  }

  private _runStep(): void {
    const isNotRunning = this._snapshot.state !== 'running';
    if (isNotRunning) {
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
    const isNotRunning = this._snapshot.state !== 'running';
    if (isNotRunning) {
      return;
    }

    try {
      const result = await uploadBytes(this._ref, this._blob, this._metadata, this._provenance);
      const isStillRunning = this._snapshot.state === 'running';
      if (isStillRunning) {
        this._updateSnapshot('success', this._snapshot.totalBytes, result.metadata);
        this._notifyObservers('next');
        this._notifyObservers('complete');
        this._resolve(this._snapshot);
      } else {
        try {
          await deleteObject(this._ref, this._provenance);
        } catch {
          // Best-effort rollback if cancelled during commit
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
    }
  }
}

/**
 * Start a resumable upload of `data` to `ref`. Returns an `UploadTask` that emits
 * synthetic progress events over microtasks before completing the storage write.
 */
export function uploadBytesResumable(
  ref: StorageReference,
  data: Blob | Uint8Array | ArrayBuffer,
  metadata?: SettableMetadata,
  provenance?: EventProvenance,
): UploadTask {
  const isRoot = ref.fullPath === '';
  if (isRoot) {
    throw invalidRootOperation('uploadBytesResumable');
  }
  return new UploadTaskImpl(ref, data, metadata, provenance);
}
