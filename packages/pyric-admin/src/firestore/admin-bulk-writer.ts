/**
 * Duck-typed `BulkWriter` implementation returned by `db.bulkWriter()` in
 * `pyric-admin/firestore`, matching `@google-cloud/firestore` synchronous
 * post-close checks, `onWriteResult`/`onWriteError` callbacks, and `flush()`.
 */
import type {
  DocumentData,
  DocumentReference,
  OperationOptions,
  SetOptions,
} from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import type { WriteResult } from './admin-write-result-preconditions.js';
import { runWithAdminErrorsAsync } from './admin-grpc-errors.js';
import { isAppBackedRoot } from './admin-handle-registry.js';
import { assertSameDatabaseTarget } from './admin-named-databases.js';
import { markAdminFirestoreStarted } from './admin-settings-lifecycle.js';

interface AdminBulkWriterError {
  readonly code: number;
  readonly message: string;
  readonly documentRef: DocumentReference;
  readonly operationType: 'create' | 'set' | 'update' | 'delete';
  readonly failedAttempts: number;
}

export interface AdminBulkWriter {
  create(documentRef: DocumentReference, data: DocumentData): Promise<WriteResult>;
  set(documentRef: DocumentReference, data: DocumentData, options?: SetOptions): Promise<WriteResult>;
  update(documentRef: DocumentReference, dataOrField: unknown, ...moreFieldsAndPrecondition: unknown[]): Promise<WriteResult>;
  delete(documentRef: DocumentReference, precondition?: OperationOptions): Promise<WriteResult>;
  onWriteResult(callback: (documentRef: DocumentReference, result: WriteResult) => void): void;
  onWriteError(shouldRetryCallback: (error: AdminBulkWriterError) => boolean): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

const CLOSED_MESSAGE = 'BulkWriter has already been closed.';

export function createAdminBulkWriter(rootDb: SandboxFirestore): AdminBulkWriter {
  markAdminFirestoreStarted(rootDb);
  let closed = false;
  const pendingOps = new Set<Promise<unknown>>();
  let onResultCallback: ((documentRef: DocumentReference, result: WriteResult) => void) | null = null;
  let onErrorCallback: ((error: AdminBulkWriterError) => boolean) | null = null;

  function ensureOpen(): void {
    if (closed) {
      throw new Error(CLOSED_MESSAGE);
    }
  }

  function enqueueWrite(
    documentRef: DocumentReference,
    operationType: 'create' | 'set' | 'update' | 'delete',
    runOnce: () => Promise<WriteResult>,
  ): Promise<WriteResult> {
    ensureOpen();
    let attempts = 0;
    const execute = async (): Promise<WriteResult> => {
      for (;;) {
        try {
          await runWithAdminErrorsAsync(isAppBackedRoot(rootDb), async () => {
            assertSameDatabaseTarget(rootDb, documentRef);
          });
          const result = await runOnce();
          if (onResultCallback !== null) {
            onResultCallback(documentRef, result);
          }
          return result;
        } catch (err) {
          attempts += 1;
          let message = 'BulkWriter operation failed';
          if (err instanceof Error) {
            message = err.message;
          }
          let numericCode = 2;
          if (err !== null && typeof err === 'object') {
            const rawCode = (err as { code?: unknown }).code;
            if (typeof rawCode === 'number') {
              numericCode = rawCode;
            }
          }
          const bwErr: AdminBulkWriterError = {
            code: numericCode,
            message,
            documentRef,
            operationType,
            failedAttempts: attempts,
          };
          const shouldRetry =
            onErrorCallback !== null && attempts < 10 && onErrorCallback(bwErr) === true;
          if (!shouldRetry) {
            throw err;
          }
        }
      }
    };
    const tracked = execute();
    const settled = tracked.then(
      () => undefined,
      () => undefined,
    );
    pendingOps.add(settled);
    void settled.then(() => {
      pendingOps.delete(settled);
    });
    return tracked;
  }

  return {
    create(documentRef, data) {
      return enqueueWrite(
        documentRef,
        'create',
        () => documentRef.create(data) as unknown as Promise<WriteResult>,
      );
    },
    set(documentRef, data, options) {
      return enqueueWrite(
        documentRef,
        'set',
        () => documentRef.set(data, options) as unknown as Promise<WriteResult>,
      );
    },
    update(documentRef, dataOrField, ...rest) {
      return enqueueWrite(
        documentRef,
        'update',
        () =>
          (documentRef.update as unknown as (...args: unknown[]) => Promise<WriteResult>)(
            dataOrField,
            ...rest,
          ),
      );
    },
    delete(documentRef, precondition) {
      return enqueueWrite(
        documentRef,
        'delete',
        () => documentRef.delete(precondition) as unknown as Promise<WriteResult>,
      );
    },
    onWriteResult(callback) {
      onResultCallback = callback;
    },
    onWriteError(shouldRetryCallback) {
      onErrorCallback = shouldRetryCallback;
    },
    async flush() {
      while (pendingOps.size > 0) {
        await Promise.all([...pendingOps]);
      }
    },
    async close() {
      closed = true;
      while (pendingOps.size > 0) {
        await Promise.all([...pendingOps]);
      }
    },
  };
}
