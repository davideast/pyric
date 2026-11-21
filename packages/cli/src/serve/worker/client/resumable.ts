import {
  clientContentEncoding,
  cloneCustomMetadata,
  cloneSettableMetadata,
  storageTaskProgress,
  storageTaskResult,
  uploadContentDisposition,
} from 'pyric/storage/internal';
/**
 * Worker-mode resumable upload operations: `uploadBytesResumable` and observer tasks.
 *
 * On a host with a byte route, the task sends the object a slice at a time and
 * reports progress as each slice lands; pausing stops between slices, and
 * resuming asks the host how much it holds before continuing. Elsewhere it
 * emits one intermediate progress event before a single `uploadBytes` call.
 */
import { FirebaseError } from 'pyric/app';
import type { FullMetadata } from 'pyric/storage';
import { sandboxNow } from './clock.js';
import type { ClientStorageReference, ClientSettableMetadata, CommittedUpload, RouteUpload } from './storage.js';
import {
  abortRouteUpload, beginRouteUpload, byteRouteOf, commitUpload, finishRouteUpload, routeUploadOffset,
  sendRouteSlice, uploadBlobOf,
} from './storage.js';
import type { CommitOutcome } from './upload-rollback.js';
import { commitOutcomeOf, removeStoredObject, storedUpload } from './upload-rollback.js';

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

function deferMicrotask(callback: () => void): void {
  void Promise.resolve().then(callback);
}

type ClientTaskState = 'running' | 'paused' | 'success' | 'canceled' | 'error';

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
  if (data instanceof Blob) return data.size;
  return data.byteLength;
}

function createCanceledError(): FirebaseError {
  return new FirebaseError('storage/canceled', 'storage/canceled: User canceled the upload/download.');
}

function createRootOpError(): FirebaseError {
  return new FirebaseError('storage/invalid-root-operation', 'storage/invalid-root-operation: uploadBytesResumable cannot operate on root reference.');
}

class ClientUploadTaskImpl implements ClientUploadTask {
  readonly [Symbol.toStringTag] = 'UploadTask';
  private _snapshot: ClientUploadTaskSnapshot;
  private _promise: Promise<ClientUploadTaskSnapshot>;
  private _resolve: (snapshot: ClientUploadTaskSnapshot) => void = () => {};
  private _reject: (error: Error) => void = () => {};
  private _observers: ClientTaskObserver[] = [];
  private _didIntermediateProgress = false;
  private _committing = false;
  /** The commit's outcome when it settled while paused; resuming reports it. */
  private _heldOutcome: CommitOutcome | undefined;
  /** The commit once it is sent; it cannot be recalled, so a cancel waits on it. */
  private _sentCommit: Promise<CommitOutcome> | undefined;
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
    const clonedMetadata = cloneSettableMetadata(metadata);
    this._ref = ref;
    this._data = data;
    this._metadata = clonedMetadata;

    const size = computePayloadSize(data);
    // The placeholder metadata an in-flight task reports. The stamp is the
    // sandbox clock's, so a paused task's snapshot agrees with the object the
    // host writes when it completes.
    const now = new Date(sandboxNow()).toISOString();

    let contentType = 'application/octet-stream';
    if (data instanceof Blob && data.type !== '') {
      contentType = data.type;
    }
    if (metadata?.contentType !== undefined && metadata.contentType !== '') {
      contentType = metadata.contentType;
    }

    let resolvedBucket = 'default';
    if (ref.bucket !== '') resolvedBucket = ref.bucket;
    const initialMetadata: FullMetadata = {
      fullPath: ref.fullPath,
      name: ref.name,
      bucket: resolvedBucket,
      generation: '1',
      metageneration: '1',
      timeCreated: now,
      updated: now,
      size,
      contentType,
      contentDisposition: uploadContentDisposition(metadata?.contentDisposition, ref.fullPath),
      contentEncoding: clientContentEncoding(metadata?.contentEncoding),
    };
    if (clonedMetadata?.cacheControl !== undefined) {
      initialMetadata.cacheControl = clonedMetadata.cacheControl;
    }
    if (clonedMetadata?.contentLanguage !== undefined) {
      initialMetadata.contentLanguage = clonedMetadata.contentLanguage;
    }
    if (clonedMetadata?.customMetadata !== undefined) {
      initialMetadata.customMetadata = cloneCustomMetadata(clonedMetadata.customMetadata);
    }

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

    // The first frame goes out at the call (D1, D2); progress reports follow on a microtask.
    this._start();
    deferMicrotask(() => {
      queueMicrotask(() => {
        this._runStep();
      });
    });
  }

  private _start(): void {
    // Before the first attachment the transport cannot say whether the host
    // has a byte route. `uploadBytes` then keeps this upload's place in the
    // call order until it can, and sends it over the route or as frames (#1082).
    const routeUnknown = this._ref.port.byteRouteSettled?.() !== undefined;
    const routed = !routeUnknown && byteRouteOf(this._ref) !== undefined;
    if (routed) void this._sendOverRoute();
    else void this._commitUpload();
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
      this._notifyObservers();
      return true;
    }
    return false;
  }

  resume(): boolean {
    const isPaused = this._snapshot.state === 'paused';
    if (isPaused) {
      this._updateSnapshot('running', this._snapshot.bytesTransferred);
      this._notifyObservers();
      queueMicrotask(() => {
        this._runStep();
      });
      return true;
    }
    return false;
  }

  cancel(): boolean {
    const canCancel = this._snapshot.state === 'running' || this._snapshot.state === 'paused';
    if (canCancel) {
      const canceled = createCanceledError();
      this._updateSnapshot('canceled', this._snapshot.bytesTransferred);
      this._inFlight?.abort();
      // A failed rollback rejects with the error removeStoredObject words.
      void this._rollBackCanceled().then(
        () => this._settleCanceled(canceled),
        (failure: unknown) => this._settleCanceled(asError(failure)),
      );
      return true;
    }
    return false;
  }

  /**
   * End a canceled task once its rollback is done: error observers, later
   * subscribers, and the promise all get the same error, as Firebase settles
   * them together, so an observer that reads the path finds it as the cancel
   * leaves it. A failed rollback's error replaces `storage/canceled`.
   */
  private _settleCanceled(error: Error): void {
    this._error = error;
    this._notifyObservers();
    this._reject(error);
  }

  /**
   * Undo what a canceled upload left on the host: wait for a sent commit,
   * discard the staged route upload, then delete the object if the commit
   * stored it, whether it settled while paused or settles after the cancel.
   * The commit settles first, so the discard never drops staged bytes that a
   * finish in flight is still storing.
   */
  private async _rollBackCanceled(): Promise<void> {
    const held = this._heldOutcome;
    this._heldOutcome = undefined;
    const sent = this._sentCommit;
    let outcome = held;
    if (outcome === undefined && sent !== undefined) {
      outcome = await sent;
    }
    const upload = this._upload;
    if (upload !== undefined) await abortRouteUpload(upload);
    const stored = storedUpload(outcome);
    if (stored !== undefined) await removeStoredObject(this._ref, stored);
  }

  /** Send the commit, asking the host for the token that rolls it back. */
  private _sendCommit(commit: Promise<CommittedUpload>): Promise<CommitOutcome> {
    const sent = commitOutcomeOf(commit);
    this._sentCommit = sent;
    return sent;
  }

  /** Report the outcome a commit held while paused; false when there is none. */
  private _releaseHeldOutcome(): boolean {
    const held = this._heldOutcome;
    if (held === undefined) return false;
    this._heldOutcome = undefined;
    if ('result' in held) this._succeed(held.result.metadata);
    else this._fail(held.error);
    return true;
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

    if (typeof nextOrObserver === 'object' && nextOrObserver !== null) {
      if (typeof nextOrObserver.next === 'function') nextCb = nextOrObserver.next.bind(nextOrObserver);
      if (typeof nextOrObserver.error === 'function') errCb = nextOrObserver.error.bind(nextOrObserver);
      if (typeof nextOrObserver.complete === 'function') compCb = nextOrObserver.complete.bind(nextOrObserver);
    } else {
      if (typeof nextOrObserver === 'function') nextCb = nextOrObserver;
      if (typeof error === 'function') errCb = error;
      if (typeof complete === 'function') compCb = complete;
    }

    const observer: ClientTaskObserver = { next: nextCb, error: errCb, complete: compCb };
    this._observers.push(observer);
    this._notifyObserver(observer);

    return () => {
      const index = this._observers.indexOf(observer);
      if (index !== -1) this._observers.splice(index, 1);
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

  private _notifyObservers(): void {
    const observers = this._observers.slice();
    for (const observer of observers) {
      this._notifyObserver(observer);
    }
  }

  private _notifyObserver(observer: ClientTaskObserver): void {
    const state = this._snapshot.state;
    if (state === 'running' || state === 'paused') {
      const nextFn = observer.next;
      if (nextFn !== undefined) {
        const snapshot = this._snapshot;
        deferMicrotask(() => {
          try {
            storageTaskProgress(this);
            nextFn(snapshot);
          } catch {
            // Ignore observer exceptions
          }
        });
      }
      return;
    }
    if (state === 'success') {
      const completeFn = observer.complete;
      if (completeFn !== undefined) {
        deferMicrotask(() => {
          try {
            storageTaskResult(this);
            completeFn();
          } catch {
            // Ignore observer exceptions
          }
        });
      }
      return;
    }
    if (state === 'error' || state === 'canceled') {
      const errorFn = observer.error;
      const err = this._error;
      if (errorFn !== undefined && err !== undefined) {
        deferMicrotask(() => {
          try {
            errorFn(err);
          } catch {
            // Ignore observer exceptions
          }
        });
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
      const route = byteRouteOf(this._ref);
      if (route === undefined) return;
      let upload = this._upload;
      if (upload === undefined) {
        let contentType: string | undefined;
        if (this._metadata?.contentType !== undefined && this._metadata.contentType !== '') {
          contentType = this._metadata.contentType;
        } else if (data.type !== '') {
          contentType = data.type;
        }
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
        this._notifyObservers();
      }
      if (!running()) return;
      const outcome = await this._sendCommit(finishRouteUpload(upload, true));
      const finishFailedWhileRunning = 'error' in outcome && running();
      if (finishFailedWhileRunning) throw outcome.error;
      this._settleCommit(outcome);
    } catch (error: unknown) {
      this._inFlight = undefined;
      // A pause or a cancel aborts the slice in flight; neither is a failure.
      if (!running()) return;
      this._error = asError(error);
      this._updateSnapshot('error', this._snapshot.bytesTransferred);
      const upload = this._upload;
      if (upload !== undefined) await abortRouteUpload(upload);
      this._notifyObservers();
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
    const routed = byteRouteOf(this._ref) !== undefined && !this._committing;
    if (routed) {
      const reported = this._releaseHeldOutcome();
      if (!reported) void this._sendOverRoute();
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
      this._notifyObservers();
    }

    const reported = this._releaseHeldOutcome();
    if (!reported) void this._commitUpload();
  }

  private _succeed(metadata: FullMetadata): void {
    this._updateSnapshot('success', this._snapshot.totalBytes, metadata);
    this._notifyObservers();
    this._resolve(this._snapshot);
  }

  private _fail(err: unknown): void {
    this._error = asError(err);
    this._updateSnapshot('error', this._snapshot.bytesTransferred);
    this._notifyObservers();
    this._reject(this._error);
  }

  /**
   * Upload the object in one call. It is sent once: a pause cannot recall a
   * sent frame, so an outcome that arrives while paused is held for resume,
   * and a cancel waits on it to roll the object back.
   */
  private async _commitUpload(): Promise<void> {
    const isNotRunning = this._snapshot.state !== 'running';
    const hasStarted = this._committing || this._heldOutcome !== undefined;
    if (isNotRunning || hasStarted) return;
    this._committing = true;
    const outcome = await this._sendCommit(commitUpload(this._ref, this._data, this._metadata, true));
    this._committing = false;
    this._settleCommit(outcome);
  }

  /** Report a settled commit, or hold it while paused; a cancel rolls it back itself. */
  private _settleCommit(outcome: CommitOutcome): void {
    const state = this._snapshot.state;
    const isRunning = state === 'running';
    if (isRunning) {
      if ('result' in outcome) this._succeed(outcome.result.metadata);
      else this._fail(outcome.error);
      return;
    }
    const isPaused = state === 'paused';
    if (isPaused) this._heldOutcome = outcome;
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
