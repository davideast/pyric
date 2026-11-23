/**
 * `BulkWriter` implementation returned by `db.bulkWriter(options?)` in
 * `pyric-admin/firestore`, matching `@google-cloud/firestore` options
 * validation, synchronous argument and post-close checks, idempotent `close()`,
 * `BulkWriterError` rejections, default transient retry codes, and
 * `onWriteResult` / `onWriteError` callbacks.
 */
import type {
  DocumentData,
  DocumentReference,
  OperationOptions,
  SetOptions,
} from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import {
  runWithAdminErrorsAsync,
  runWithAdminErrorsSync,
} from './admin-grpc-errors.js';
import { GrpcStatus } from './admin-grpc-log.js';
import { isAppBackedRoot } from './admin-handle-registry.js';
import {
  assertSameDatabaseTarget,
  hasCrossDatabaseMismatch,
} from './admin-named-databases.js';
import { markAdminFirestoreStarted } from './admin-settings-lifecycle.js';
import type { WriteResult } from './admin-write-result-preconditions.js';
import {
  assertAdminDocumentReference,
  isObjectRecord,
} from './admin-write-validation.js';

type BulkWriterOperationType = 'create' | 'set' | 'update' | 'delete';

interface BulkWriterThrottlingOptions {
  initialOpsPerSecond?: number;
  maxOpsPerSecond?: number;
}

export interface BulkWriterOptions {
  readonly throttling?: boolean | BulkWriterThrottlingOptions;
}

/**
 * The error surfaced to `onWriteError` and rejected by failed `BulkWriter`
 * operation promises, matching `@google-cloud/firestore`'s `BulkWriterError`.
 */
export class BulkWriterError extends Error {
  readonly code: number;
  override readonly message: string;
  readonly documentRef: DocumentReference;
  readonly operationType: BulkWriterOperationType;
  readonly failedAttempts: number;

  constructor(
    code: number,
    message: string,
    documentRef: DocumentReference,
    operationType: BulkWriterOperationType,
    failedAttempts: number,
  ) {
    super(message);
    this.code = code;
    this.message = message;
    this.documentRef = documentRef;
    this.operationType = operationType;
    this.failedAttempts = failedAttempts;
  }
}

export interface AdminBulkWriter {
  create(documentRef: DocumentReference, data: DocumentData): Promise<WriteResult>;
  set(
    documentRef: DocumentReference,
    data: DocumentData,
    options?: SetOptions,
  ): Promise<WriteResult>;
  update(
    documentRef: DocumentReference,
    dataOrField: unknown,
    ...moreFieldsAndPrecondition: unknown[]
  ): Promise<WriteResult>;
  delete(
    documentRef: DocumentReference,
    precondition?: OperationOptions,
  ): Promise<WriteResult>;
  onWriteResult(
    callback: (documentRef: DocumentReference, result: WriteResult) => void,
  ): void;
  onWriteError(shouldRetryCallback: (error: BulkWriterError) => boolean): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

const CLOSED_MESSAGE = 'BulkWriter has already been closed.';
const MAX_DEFAULT_RETRY_ATTEMPTS = 10;

const DEFAULT_BATCH_WRITE_RETRY_CODES: ReadonlySet<number> = new Set<number>([
  GrpcStatus.RESOURCE_EXHAUSTED as number,
  GrpcStatus.ABORTED as number,
  GrpcStatus.UNAVAILABLE as number,
]);

function isValidIntegerValue(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value) && value % 1 === 0;
}

function validatePositiveRateOption(argName: string, value: unknown): number {
  if (!isValidIntegerValue(value)) {
    throw new Error(`Value for argument "${argName}" is not a valid integer.`);
  }
  if (value < 1) {
    throw new Error(
      `Value for argument "${argName}" must be within [1, Infinity] inclusive, but was: ${String(value)}`,
    );
  }
  return value;
}

function validateBulkWriterOptions(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isObjectRecord(value)) {
    throw new Error(
      'Value for argument "options" is not a valid bulkWriter() options argument. Input is not an object.',
    );
  }
  const options = value as {
    throttling?: boolean | { initialOpsPerSecond?: unknown; maxOpsPerSecond?: unknown };
  };
  if (options.throttling === undefined || typeof options.throttling === 'boolean') {
    return;
  }
  const rawInitial = options.throttling.initialOpsPerSecond;
  const rawMax = options.throttling.maxOpsPerSecond;

  let validatedInitial: number | undefined;
  if (rawInitial !== undefined) {
    validatedInitial = validatePositiveRateOption('initialOpsPerSecond', rawInitial);
  }
  if (rawMax !== undefined) {
    const validatedMax = validatePositiveRateOption('maxOpsPerSecond', rawMax);
    if (validatedInitial !== undefined && validatedInitial > validatedMax) {
      throw new Error(
        'Value for argument "options" is not a valid bulkWriter() options argument. "maxOpsPerSecond" cannot be less than "initialOpsPerSecond".',
      );
    }
  }
}

function isDefaultRetryableBulkWriterError(error: BulkWriterError): boolean {
  const isRetryableDeleteInternal =
    error.operationType === 'delete' &&
    error.code === (GrpcStatus.INTERNAL as number);
  const isRetryableStatusCode =
    DEFAULT_BATCH_WRITE_RETRY_CODES.has(error.code) || isRetryableDeleteInternal;
  return isRetryableStatusCode && error.failedAttempts < MAX_DEFAULT_RETRY_ATTEMPTS;
}

function toBulkWriterError(
  err: unknown,
  documentRef: DocumentReference,
  operationType: BulkWriterOperationType,
  failedAttempts: number,
): BulkWriterError {
  let message = 'BulkWriter operation failed';
  if (err instanceof Error) {
    message = err.message;
  }
  let numericCode = GrpcStatus.UNKNOWN as number;
  if (err !== null && typeof err === 'object') {
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'number') {
      numericCode = rawCode;
    }
  }
  return new BulkWriterError(
    numericCode,
    message,
    documentRef,
    operationType,
    failedAttempts,
  );
}

export function createAdminBulkWriter(
  rootDb: SandboxFirestore,
  options?: BulkWriterOptions,
): AdminBulkWriter {
  markAdminFirestoreStarted(rootDb);
  validateBulkWriterOptions(options);

  const appBacked = isAppBackedRoot(rootDb);
  let lastOp: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;
  let onResultCallback:
    | ((documentRef: DocumentReference, result: WriteResult) => void)
    | null = null;
  let errorHandler: (error: BulkWriterError) => boolean =
    isDefaultRetryableBulkWriterError;

  function ensureOpen(): void {
    if (closePromise !== null) {
      throw new Error(CLOSED_MESSAGE);
    }
  }

  function enqueueWrite(
    documentRef: DocumentReference,
    operationType: BulkWriterOperationType,
    runOnce: () => Promise<WriteResult>,
  ): Promise<WriteResult> {
    ensureOpen();
    runWithAdminErrorsSync(appBacked, () => {
      assertAdminDocumentReference('documentRef', documentRef);
    });

    const isCrossDatabaseRef = hasCrossDatabaseMismatch(rootDb, documentRef);
    let firstAttemptPromise: Promise<WriteResult> | undefined;
    if (!isCrossDatabaseRef) {
      firstAttemptPromise = runOnce();
      firstAttemptPromise.catch(() => undefined);
    }

    const execute = async (): Promise<WriteResult> => {
      for (let attempt = 1; ; attempt += 1) {
        let result: WriteResult;
        try {
          if (attempt === 1 && firstAttemptPromise !== undefined) {
            result = await firstAttemptPromise;
          } else {
            await runWithAdminErrorsAsync(appBacked, async () => {
              assertSameDatabaseTarget(rootDb, documentRef);
            });
            result = await runOnce();
          }
        } catch (writeError) {
          const bulkWriterError = toBulkWriterError(
            writeError,
            documentRef,
            operationType,
            attempt,
          );
          const shouldRetry = Boolean(errorHandler(bulkWriterError));
          if (!shouldRetry) {
            throw bulkWriterError;
          }
          continue;
        }
        if (onResultCallback !== null) {
          onResultCallback(documentRef, result);
        }
        return result;
      }
    };

    const operationPromise = execute();
    const settledOperation = operationPromise.then(
      () => undefined,
      () => undefined,
    );
    lastOp = lastOp.then(() => settledOperation);
    return operationPromise;
  }

  return {
    create(documentRef, data) {
      return enqueueWrite(
        documentRef,
        'create',
        () => documentRef.create(data) as unknown as Promise<WriteResult>,
      );
    },
    set(documentRef, data, setOptions) {
      return enqueueWrite(
        documentRef,
        'set',
        () => documentRef.set(data, setOptions) as unknown as Promise<WriteResult>,
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
      errorHandler = shouldRetryCallback;
    },
    flush() {
      ensureOpen();
      return lastOp;
    },
    close() {
      if (closePromise === null) {
        closePromise = lastOp;
      }
      return closePromise;
    },
  };
}
