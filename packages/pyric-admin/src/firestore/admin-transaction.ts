/**
 * Admin-SDK `Transaction` and `Firestore.runTransaction` validation and
 * execution wrapper (`@google-cloud/firestore` parity across local and
 * JSON-wire remote sandboxes, including read-only `readTime` snapshots).
 */

import {
  registeredAdminReferencePath,
  Timestamp as CompatTimestamp,
  TXN_ATTEMPTS_EXHAUSTED_MARKER,
  type AuthContext,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type OperationOptions,
  type Query,
  type QuerySnapshot,
  type SetOptions,
  type Transaction,
} from 'pyric/sandbox/admin-compat';
import { isRemoteSandbox, SandboxError, type Sandbox } from 'pyric/sandbox';
import { RetryableTransactionConflictError } from 'pyric/sandbox/internal';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import {
  runWithAdminErrorsAsync,
  runWithAdminErrorsSync,
} from './admin-grpc-errors.js';
import {
  adminDocumentRefBrand,
  adminQueryBrand,
  adminRawDbSandbox,
  adminToRootDb,
  adminToUnderlying,
  isAppBackedRoot,
  unwrapAdminObject,
} from './admin-handle-registry.js';
import {
  assertAdminRootDatabaseDeclared,
  assertSameDatabaseTarget,
  hasCrossDatabaseMismatch,
  isBoundToUndeclaredPlaceholderEnv,
} from './admin-named-databases.js';
import {
  adminQueryMetadata,
  assertQueryExecutable,
} from './admin-query-validation.js';
import {
  capturePreWriteBaselines,
  executeReadOnlyTransactionAtReadTime,
  recordPostWriteVersions,
} from './admin-read-time-history.js';
import {
  validateAndNormalizeSetCall,
  validatePreconditionObject,
} from './admin-set-and-precondition-validation.js';
import {
  wrapDocSnapshot,
  wrapQuerySnapshot,
} from './admin-snapshot-adapter.js';
import {
  parseTransactionGetAllArgs,
  projectDocSnapshotFields,
} from './admin-transaction-getall.js';
import { validateAndNormalizeUpdateArgs } from './admin-update-validation.js';
import {
  assertBatchPreconditions,
  extractParsedPrecondition,
  extractUpdateTrailingPrecondition,
  readDocPreconditionState,
  recordTransactionAdminMutations,
  type BatchOperationCheckItem,
  type InitialPreconditionSnapshot,
} from './admin-write-result-preconditions.js';
import {
  assertAdminDocumentReference,
  isObjectRecord,
  validateAndNormalizeDocumentData,
} from './admin-write-validation.js';

const READ_ONLY_WRITE_ERROR = 'Firestore read-only transactions cannot execute writes.';
const TX_READ_AFTER_WRITE_CLIENT_MESSAGE =
  'Firestore transactions require all reads to be executed before all writes.';
const REMOTE_TX_CONFLICT_MARKER = Symbol('pyric.admin.firestore.remoteTxConflict');

function translateAdminTransactionError(err: unknown): never {
  if (
    err !== null &&
    typeof err === 'object' &&
    (err as Record<symbol, unknown>)[TXN_ATTEMPTS_EXHAUSTED_MARKER] === true
  ) {
    let message = 'Transaction failed after maximum attempts due to repeated conflicts.';
    const rawMessage = (err as { message?: unknown }).message;
    if (typeof rawMessage === 'string') {
      message = rawMessage;
    }
    throw new SandboxError('aborted', message);
  }
  throw err;
}

function isAdminDocRefTarget(value: unknown): value is DocumentReference {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return adminDocumentRefBrand.has(value) || registeredAdminReferencePath(value) !== undefined;
}

function isAdminQueryTarget(value: unknown): value is Query {
  return value !== null && typeof value === 'object' && adminQueryBrand.has(value);
}

interface TransactionAttemptContext {
  readonly tx: Transaction;
  readonly verifyPreconditions: () => Promise<void>;
  readonly assertQueuedWritesSameDatabase: () => void;
  readonly mutations: Array<{ readonly path: string; readonly kind: 'write' | 'delete' }>;
}

function wrapTransaction(
  rawTx: Transaction,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  readOnly: boolean,
  docRefOnRoot: (db: SandboxFirestore, path: string) => DocumentReference,
): TransactionAttemptContext {
  let hasQueuedWrites = false;
  let firstCrossDbWriteTarget: object | null = null;
  const appBacked = isAppBackedRoot(rootDb);
  const txReadSnapshots = new Map<string, InitialPreconditionSnapshot>();
  const queuedOps: BatchOperationCheckItem[] = [];
  const mutations: Array<{ readonly path: string; readonly kind: 'write' | 'delete' }> = [];

  function assertWritable(): void {
    if (readOnly) {
      throw new SandboxError('invalid-argument', READ_ONLY_WRITE_ERROR);
    }
  }

  const proxy: Transaction = new Proxy(rawTx, {
    get(t, prop) {
      switch (prop) {
        case 'get':
          return (refOrQuery: DocumentReference | Query): Promise<QuerySnapshot | DocumentSnapshot> =>
            runWithAdminErrorsAsync(appBacked, async () => {
              if (isAdminQueryTarget(refOrQuery)) {
                assertSameDatabaseTarget(rootDb, refOrQuery);
                const meta = adminQueryMetadata.get(refOrQuery);
                assertQueryExecutable(meta);
                let unwrappedQuery = unwrapAdminObject(refOrQuery);
                if (
                  meta !== undefined &&
                  typeof meta.replayOnRoot === 'function' &&
                  isBoundToUndeclaredPlaceholderEnv(unwrappedQuery)
                ) {
                  unwrappedQuery = unwrapAdminObject(meta.replayOnRoot(rootDb));
                }
                const snap = await t.get(unwrappedQuery);
                const wrappedQuerySnap = wrapQuerySnapshot(snap, rootDb, docRefOnRoot);
                for (const docSnap of wrappedQuerySnap.docs) {
                  if (!txReadSnapshots.has(docSnap.ref.path)) {
                    const docUpdateTime = Reflect.get(docSnap, 'updateTime', docSnap) as
                      | CompatTimestamp
                      | undefined;
                    txReadSnapshots.set(docSnap.ref.path, {
                      exists: true,
                      updateTime: docUpdateTime,
                    });
                  }
                }
                return wrappedQuerySnap;
              }
              if (isAdminDocRefTarget(refOrQuery)) {
                assertSameDatabaseTarget(rootDb, refOrQuery);
                let unwrappedRef = unwrapAdminObject(refOrQuery);
                if (isBoundToUndeclaredPlaceholderEnv(unwrappedRef)) {
                  unwrappedRef = unwrapAdminObject(rootDb.doc(refOrQuery.path));
                }
                const snap = await t.get(unwrappedRef);
                const wrappedSnap = wrapDocSnapshot(snap, rootDb, docRefOnRoot);
                if (!txReadSnapshots.has(unwrappedRef.path)) {
                  const snapUpdateTime = Reflect.get(wrappedSnap, 'updateTime', wrappedSnap) as
                    | CompatTimestamp
                    | undefined;
                  txReadSnapshots.set(unwrappedRef.path, {
                    exists: snap.exists,
                    updateTime: snapUpdateTime,
                  });
                }
                return wrappedSnap;
              }
              throw new SandboxError(
                'invalid-argument',
                'Value for argument "refOrQuery" must be a DocumentReference, Query, or AggregateQuery.',
              );
            });
        case 'getAll':
          return async (...args: unknown[]): Promise<DocumentSnapshot[]> => {
            if (hasQueuedWrites) {
              throw new Error(TX_READ_AFTER_WRITE_CLIENT_MESSAGE);
            }
            return runWithAdminErrorsAsync(appBacked, async () => {
              const parsed = parseTransactionGetAllArgs(args);
              for (const ref of parsed.refs) {
                assertSameDatabaseTarget(rootDb, ref);
              }
              const results: DocumentSnapshot[] = [];
              for (const ref of parsed.refs) {
                let unwrappedRef = unwrapAdminObject(ref);
                if (isBoundToUndeclaredPlaceholderEnv(unwrappedRef)) {
                  unwrappedRef = unwrapAdminObject(rootDb.doc(ref.path));
                }
                const snap = await t.get(unwrappedRef);
                const wrapped = wrapDocSnapshot(snap, rootDb, docRefOnRoot);
                if (!txReadSnapshots.has(unwrappedRef.path)) {
                  const snapUpdateTime = Reflect.get(wrapped, 'updateTime', wrapped) as
                    | CompatTimestamp
                    | undefined;
                  txReadSnapshots.set(unwrappedRef.path, {
                    exists: snap.exists,
                    updateTime: snapUpdateTime,
                  });
                }
                if (parsed.fieldMask !== undefined) {
                  results.push(projectDocSnapshotFields(wrapped, parsed.fieldMask));
                } else {
                  results.push(wrapped);
                }
              }
              return results;
            });
          };
        case 'create':
          return (ref: DocumentReference, data: DocumentData) =>
            runWithAdminErrorsSync(appBacked, () => {
              assertWritable();
              assertAdminDocumentReference('documentRef', ref);
              const normalized = validateAndNormalizeDocumentData(
                'data',
                data,
                'none',
                appBacked,
              );
              hasQueuedWrites = true;
              if (hasCrossDatabaseMismatch(rootDb, ref)) {
                if (firstCrossDbWriteTarget === null) {
                  firstCrossDbWriteTarget = ref;
                }
                return proxy;
              }
              const unwrappedRef = unwrapAdminObject(ref);
              t.create(unwrappedRef, normalized);
              queuedOps.push({ kind: 'create', ref: unwrappedRef });
              mutations.push({ path: unwrappedRef.path, kind: 'write' });
              return proxy;
            });
        case 'set':
          return (ref: DocumentReference, data: DocumentData, options?: SetOptions) =>
            runWithAdminErrorsSync(appBacked, () => {
              assertWritable();
              const validated = validateAndNormalizeSetCall(
                data,
                options,
                true,
                appBacked,
              );
              assertAdminDocumentReference('documentRef', ref);
              hasQueuedWrites = true;
              if (hasCrossDatabaseMismatch(rootDb, ref)) {
                if (firstCrossDbWriteTarget === null) {
                  firstCrossDbWriteTarget = ref;
                }
                return proxy;
              }
              const unwrappedRef = unwrapAdminObject(ref);
              t.set(unwrappedRef, validated.data, validated.options);
              queuedOps.push({ kind: 'set', ref: unwrappedRef });
              mutations.push({ path: unwrappedRef.path, kind: 'write' });
              return proxy;
            });
        case 'update':
          return (...allArgs: unknown[]) =>
            runWithAdminErrorsSync(appBacked, () => {
              assertWritable();
              if (allArgs.length < 2) {
                throw new SandboxError(
                  'invalid-argument',
                  'Function "Transaction.update()" requires at least 2 arguments.',
                );
              }
              const ref = allArgs[0] as DocumentReference;
              assertAdminDocumentReference('documentRef', ref);
              const rawUpdateArgs = allArgs.slice(1);
              const normalizedArgs = validateAndNormalizeUpdateArgs(
                rawUpdateArgs,
                appBacked,
              );
              hasQueuedWrites = true;
              if (hasCrossDatabaseMismatch(rootDb, ref)) {
                if (firstCrossDbWriteTarget === null) {
                  firstCrossDbWriteTarget = ref;
                }
                return proxy;
              }
              const precondition = extractUpdateTrailingPrecondition(rawUpdateArgs);
              const unwrappedRef = unwrapAdminObject(ref);
              (t.update as (r: DocumentReference, ...a: unknown[]) => Transaction)(
                unwrappedRef,
                ...normalizedArgs,
              );
              queuedOps.push({ kind: 'update', ref: unwrappedRef, precondition });
              mutations.push({ path: unwrappedRef.path, kind: 'write' });
              return proxy;
            });
        case 'delete':
          return (ref: DocumentReference, ...rest: [precondition?: unknown]) =>
            runWithAdminErrorsSync(appBacked, () => {
              assertWritable();
              assertAdminDocumentReference('documentRef', ref);
              validatePreconditionObject('precondition', rest[0], false);
              hasQueuedWrites = true;
              if (hasCrossDatabaseMismatch(rootDb, ref)) {
                if (firstCrossDbWriteTarget === null) {
                  firstCrossDbWriteTarget = ref;
                }
                return proxy;
              }
              const precondition = extractParsedPrecondition(rest[0]);
              const unwrappedRef = unwrapAdminObject(ref);
              t.delete(unwrappedRef);
              queuedOps.push({ kind: 'delete', ref: unwrappedRef, precondition });
              mutations.push({ path: unwrappedRef.path, kind: 'delete' });
              return proxy;
            });
        default: {
          const value = Reflect.get(t, prop, t);
          if (typeof value === 'function') {
            return value.bind(t);
          }
          return value;
        }
      }
    },
    getOwnPropertyDescriptor(t, prop) {
      const own = Reflect.getOwnPropertyDescriptor(t, prop);
      if (own !== undefined) {
        return own;
      }
      if (prop === 'getAll') {
        return {
          value: Reflect.get(proxy, 'getAll', proxy),
          writable: true,
          enumerable: false,
          configurable: true,
        };
      }
      return undefined;
    },
  });

  adminToUnderlying.set(proxy, rawTx);
  adminToRootDb.set(proxy, rootDb);

  return {
    tx: proxy,
    mutations,
    assertQueuedWritesSameDatabase(): void {
      if (firstCrossDbWriteTarget !== null) {
        assertSameDatabaseTarget(rootDb, firstCrossDbWriteTarget);
      }
    },
    async verifyPreconditions(): Promise<void> {
      await assertBatchPreconditions(rawDb, queuedOps, txReadSnapshots);
      if (txReadSnapshots.size === 0 || queuedOps.length === 0) {
        return;
      }
      const sb = adminRawDbSandbox.get(rawDb);
      const remote = sb !== undefined && isRemoteSandbox(sb);
      for (const [docPath, readSnap] of txReadSnapshots.entries()) {
        const live = await readDocPreconditionState(rawDb, docPath);
        const existenceChanged = live.exists !== readSnap.exists;
        const updateTimeChanged =
          live.exists &&
          readSnap.updateTime !== undefined &&
          (live.updateTime === undefined || !live.updateTime.isEqual(readSnap.updateTime));
        if (existenceChanged || updateTimeChanged) {
          if (remote) {
            const err = new Error('Remote transaction read snapshot became stale.');
            Object.defineProperty(err, REMOTE_TX_CONFLICT_MARKER, { value: true });
            throw err;
          }
          throw new RetryableTransactionConflictError();
        }
      }
    },
  };
}

function parseTransactionOptions(rawOptions: unknown): {
  readOnly: boolean;
  readTime: CompatTimestamp | undefined;
  forwarded: OperationOptions | undefined;
} {
  if (!rawOptions) {
    return { readOnly: false, readTime: undefined, forwarded: undefined };
  }
  if (!isObjectRecord(rawOptions)) {
    throw new SandboxError(
      'invalid-argument',
      'Value for argument "transactionOptions" is not a valid object.',
    );
  }

  const readOnlyVal = rawOptions.readOnly;
  if (readOnlyVal !== undefined && typeof readOnlyVal !== 'boolean') {
    throw new SandboxError(
      'invalid-argument',
      'Value for argument "transactionOptions.readOnly" is not a valid boolean.',
    );
  }

  const forwarded: OperationOptions = {};
  let hasForwardedField = false;
  if ('auth' in rawOptions) {
    forwarded.auth = rawOptions.auth as AuthContext;
    hasForwardedField = true;
  }

  if (readOnlyVal === true) {
    const readTimeVal = rawOptions.readTime;
    if (readTimeVal !== undefined && !(readTimeVal instanceof CompatTimestamp)) {
      throw new SandboxError(
        'invalid-argument',
        'Value for argument "transactionOptions.readTime" is not a valid Timestamp.',
      );
    }
    forwarded.maxAttempts = 1;
    return {
      readOnly: true,
      readTime: readTimeVal as CompatTimestamp | undefined,
      forwarded,
    };
  }

  const maxAttemptsVal = rawOptions.maxAttempts;
  if (maxAttemptsVal !== undefined) {
    if (typeof maxAttemptsVal !== 'number' || !Number.isInteger(maxAttemptsVal)) {
      throw new SandboxError(
        'invalid-argument',
        'Value for argument "transactionOptions.maxAttempts" is not a valid integer.',
      );
    }
    if (maxAttemptsVal < 1) {
      throw new SandboxError(
        'invalid-argument',
        `Value for argument "transactionOptions.maxAttempts" must be within [1, Infinity] inclusive, but was: ${String(maxAttemptsVal)}`,
      );
    }
    forwarded.maxAttempts = maxAttemptsVal;
    hasForwardedField = true;
  }

  let effectiveForwarded: OperationOptions | undefined;
  if (hasForwardedField) {
    effectiveForwarded = forwarded;
  }
  return {
    readOnly: false,
    readTime: undefined,
    forwarded: effectiveForwarded,
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) {
    return false;
  }
  const kind = typeof value;
  if (kind !== 'object' && kind !== 'function') {
    return false;
  }
  return typeof (value as { then?: unknown }).then === 'function';
}

export function executeAdminRunTransaction<R>(
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  updateFunction: unknown,
  rawOptions: unknown,
  docRefOnRoot: (db: SandboxFirestore, path: string) => DocumentReference,
  wrapTempAdminDb: (rawTempDb: SandboxFirestore, tempSb: Sandbox) => SandboxFirestore,
): Promise<R> {
  const appBacked = isAppBackedRoot(rootDb);
  const parsedOpts = runWithAdminErrorsSync(appBacked, () => {
    if (typeof updateFunction !== 'function') {
      throw new SandboxError(
        'invalid-argument',
        'Value for argument "updateFunction" is not a valid function.',
      );
    }
    return parseTransactionOptions(rawOptions);
  });

  const callback = updateFunction as (tx: Transaction) => Promise<R>;

  if (parsedOpts.readOnly && parsedOpts.readTime !== undefined) {
    const readTime = parsedOpts.readTime;
    return runWithAdminErrorsAsync(appBacked, async () => {
      assertAdminRootDatabaseDeclared(rootDb);
      return executeReadOnlyTransactionAtReadTime<R>(rawDb, rootDb, readTime, callback, {
        isAdminDocRefTarget,
        isAdminQueryTarget,
        getQueryMeta: (q) => adminQueryMetadata.get(q),
        docRefOnRoot,
        wrapTempAdminDb,
      });
    });
  }

  let committedAttemptMutations: Array<{ readonly path: string; readonly kind: 'write' | 'delete' }> = [];

  return runWithAdminErrorsAsync(appBacked, async () => {
    assertAdminRootDatabaseDeclared(rootDb);
    const maxOuterAttempts = parsedOpts.forwarded?.maxAttempts ?? 5;
    for (let outerAttempt = 0; outerAttempt < maxOuterAttempts; outerAttempt += 1) {
      try {
        const result = await rawDb.runTransaction(async (rawTx) => {
          const attempt = wrapTransaction(
            rawTx,
            rawDb,
            rootDb,
            parsedOpts.readOnly,
            docRefOnRoot,
          );
          const returned = callback(attempt.tx);
          if (!isThenable(returned)) {
            throw new SandboxError(
              'invalid-argument',
              'You must return a Promise in your transaction()-callback.',
            );
          }
          const value = await returned;
          attempt.assertQueuedWritesSameDatabase();
          await attempt.verifyPreconditions();
          await capturePreWriteBaselines(
            rawDb,
            rootDb,
            docRefOnRoot,
            attempt.mutations.map((m) => m.path),
          );
          committedAttemptMutations = attempt.mutations;
          return value;
        }, parsedOpts.forwarded);

        const commitTime = recordTransactionAdminMutations(rawDb, committedAttemptMutations);
        if (commitTime !== undefined) {
          await recordPostWriteVersions(
            rawDb,
            rootDb,
            docRefOnRoot,
            committedAttemptMutations,
            commitTime,
          );
        }
        return result;
      } catch (err) {
        if (
          err !== null &&
          typeof err === 'object' &&
          (err as Record<symbol, unknown>)[REMOTE_TX_CONFLICT_MARKER] === true
        ) {
          if (outerAttempt + 1 < maxOuterAttempts) {
            continue;
          }
          throw new SandboxError(
            'aborted',
            `Transaction failed after ${String(maxOuterAttempts)} attempts due to repeated conflicts.`,
          );
        }
        return translateAdminTransactionError(err);
      }
    }
    throw new SandboxError('aborted', 'Transaction failed after maximum attempts.');
  });
}
