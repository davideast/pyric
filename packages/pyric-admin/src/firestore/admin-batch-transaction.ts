/**
 * Admin-SDK `WriteBatch`, `Transaction`, and `Firestore.runTransaction`
 * validation and execution wrappers (`@google-cloud/firestore` parity across
 * local and JSON-wire remote sandboxes).
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
  type WriteBatch,
} from 'pyric/sandbox/admin-compat';
import { SandboxError } from 'pyric/sandbox';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import {
  adminDocumentRefBrand,
  adminQueryBrand,
  adminToRootDb,
  adminToUnderlying,
  isAppBackedRoot,
  unwrapAdminObject,
} from './admin-handle-registry.js';
import {
  adminQueryMetadata,
  assertQueryExecutable,
} from './admin-query-validation.js';
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
  assertSingleWritePrecondition,
  extractParsedPrecondition,
  extractUpdateTrailingPrecondition,
  recordBatchAdminMutations,
  recordTransactionAdminMutations,
  verifyPreconditionState,
  type ParsedAdminPrecondition,
  type WriteResult,
} from './admin-write-result-preconditions.js';
import {
  assertAdminDocumentReference,
  isObjectRecord,
  validateAndNormalizeDocumentData,
  validateAndNormalizeSetCall,
  validatePreconditionObject,
} from './admin-write-validation.js';

const READ_ONLY_WRITE_ERROR = 'Firestore read-only transactions cannot execute writes.';
const TX_READ_AFTER_WRITE_CLIENT_MESSAGE =
  'Firestore transactions require all reads to be executed before all writes.';

type BufferedBatchOperation =
  | { readonly kind: 'create'; readonly ref: DocumentReference; readonly data: DocumentData }
  | {
      readonly kind: 'set';
      readonly ref: DocumentReference;
      readonly data: DocumentData;
      readonly options: SetOptions | undefined;
    }
  | {
      readonly kind: 'update';
      readonly ref: DocumentReference;
      readonly args: readonly unknown[];
      readonly precondition: ParsedAdminPrecondition | undefined;
    }
  | {
      readonly kind: 'delete';
      readonly ref: DocumentReference;
      readonly precondition: ParsedAdminPrecondition | undefined;
    };

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

export function wrapWriteBatch(rawDb: SandboxFirestore, rootDb: SandboxFirestore): WriteBatch {
  const protoBatch = rawDb.batch();
  const bufferedOps: BufferedBatchOperation[] = [];
  let committed = false;

  function assertBatchMutable(): void {
    if (committed) {
      throw new SandboxError(
        'failed-precondition',
        'Cannot modify a WriteBatch that has been committed.',
      );
    }
  }

  const proxy: WriteBatch = new Proxy(protoBatch, {
    get(t, prop) {
      switch (prop) {
        case 'create':
          return (ref: DocumentReference, data: DocumentData) => {
            assertAdminDocumentReference('documentRef', ref);
            const normalized = validateAndNormalizeDocumentData(
              'data',
              data,
              'none',
              isAppBackedRoot(rootDb),
            );
            assertBatchMutable();
            bufferedOps.push({
              kind: 'create',
              ref: unwrapAdminObject(ref),
              data: normalized,
            });
            return proxy;
          };
        case 'set':
          return (ref: DocumentReference, data: DocumentData, ...rest: [options?: SetOptions]) => {
            const validated = validateAndNormalizeSetCall(
              data,
              rest[0],
              false,
              isAppBackedRoot(rootDb),
            );
            assertAdminDocumentReference('documentRef', ref);
            assertBatchMutable();
            bufferedOps.push({
              kind: 'set',
              ref: unwrapAdminObject(ref),
              data: validated.data,
              options: validated.options,
            });
            return proxy;
          };
        case 'update':
          return (...allArgs: unknown[]) => {
            if (allArgs.length < 2) {
              throw new SandboxError(
                'invalid-argument',
                'Function "WriteBatch.update()" requires at least 2 arguments.',
              );
            }
            const ref = allArgs[0] as DocumentReference;
            assertAdminDocumentReference('documentRef', ref);
            assertBatchMutable();
            const rawUpdateArgs = allArgs.slice(1);
            const normalizedArgs = validateAndNormalizeUpdateArgs(
              rawUpdateArgs,
              isAppBackedRoot(rootDb),
            );
            const precondition = extractUpdateTrailingPrecondition(rawUpdateArgs);
            bufferedOps.push({
              kind: 'update',
              ref: unwrapAdminObject(ref),
              args: normalizedArgs,
              precondition,
            });
            return proxy;
          };
        case 'delete':
          return (ref: DocumentReference, ...rest: [precondition?: unknown]) => {
            assertAdminDocumentReference('documentRef', ref);
            validatePreconditionObject('precondition', rest[0], false);
            const precondition = extractParsedPrecondition(rest[0]);
            assertBatchMutable();
            bufferedOps.push({
              kind: 'delete',
              ref: unwrapAdminObject(ref),
              precondition,
            });
            return proxy;
          };
        case 'commit':
          return async (opts?: OperationOptions): Promise<WriteResult[]> => {
            committed = true;
            const checks: Array<{
              readonly ref: DocumentReference;
              readonly method: 'update' | 'delete';
              readonly precondition: ParsedAdminPrecondition | undefined;
            }> = [];
            for (const op of bufferedOps) {
              if (op.kind === 'update' || op.kind === 'delete') {
                checks.push({
                  ref: op.ref,
                  method: op.kind,
                  precondition: op.precondition,
                });
              }
            }
            await assertBatchPreconditions(rawDb, checks);
            const executionBatch = rawDb.batch();
            for (const op of bufferedOps) {
              if (op.kind === 'create') {
                executionBatch.create(op.ref, op.data);
              } else if (op.kind === 'set') {
                executionBatch.set(op.ref, op.data, op.options);
              } else if (op.kind === 'update') {
                (executionBatch.update as (r: DocumentReference, ...a: unknown[]) => WriteBatch)(
                  op.ref,
                  ...op.args,
                );
              } else {
                executionBatch.delete(op.ref);
              }
            }
            await executionBatch.commit(opts);
            const mutationSummary: Array<{ readonly path: string; readonly kind: 'write' | 'delete' }> = [];
            for (const op of bufferedOps) {
              if (op.kind === 'delete') {
                mutationSummary.push({ path: op.ref.path, kind: 'delete' });
              } else {
                mutationSummary.push({ path: op.ref.path, kind: 'write' });
              }
            }
            return recordBatchAdminMutations(rawDb, mutationSummary);
          };
        default: {
          const value = Reflect.get(t, prop, t);
          if (typeof value === 'function') {
            return value.bind(t);
          }
          return value;
        }
      }
    },
  });

  adminToUnderlying.set(proxy, protoBatch);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
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
  const txReadExists = new Map<string, boolean>();
  const pendingPreconditions: Array<{
    readonly path: string;
    readonly method: 'update' | 'delete';
    readonly precondition: ParsedAdminPrecondition;
  }> = [];
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
          return async (refOrQuery: DocumentReference | Query): Promise<QuerySnapshot | DocumentSnapshot> => {
            if (isAdminQueryTarget(refOrQuery)) {
              assertQueryExecutable(adminQueryMetadata.get(refOrQuery));
              const unwrappedQuery = unwrapAdminObject(refOrQuery);
              const snap = await t.get(unwrappedQuery);
              return wrapQuerySnapshot(snap, rootDb, docRefOnRoot);
            }
            if (isAdminDocRefTarget(refOrQuery)) {
              const unwrappedRef = unwrapAdminObject(refOrQuery);
              const snap = await t.get(unwrappedRef);
              txReadExists.set(unwrappedRef.path, snap.exists);
              return wrapDocSnapshot(snap, rootDb, docRefOnRoot);
            }
            throw new SandboxError(
              'invalid-argument',
              'Value for argument "refOrQuery" must be a DocumentReference, Query, or AggregateQuery.',
            );
          };
        case 'getAll':
          return async (...args: unknown[]): Promise<DocumentSnapshot[]> => {
            if (hasQueuedWrites) {
              throw new Error(TX_READ_AFTER_WRITE_CLIENT_MESSAGE);
            }
            const parsed = parseTransactionGetAllArgs(args);
            const results: DocumentSnapshot[] = [];
            for (const ref of parsed.refs) {
              const unwrappedRef = unwrapAdminObject(ref);
              const snap = await t.get(unwrappedRef);
              txReadExists.set(unwrappedRef.path, snap.exists);
              const wrapped = wrapDocSnapshot(snap, rootDb, docRefOnRoot);
              if (parsed.fieldMask !== undefined) {
                results.push(projectDocSnapshotFields(wrapped, parsed.fieldMask));
              } else {
                results.push(wrapped);
              }
            }
            return results;
          };
        case 'create':
          return (ref: DocumentReference, data: DocumentData) => {
            assertWritable();
            assertAdminDocumentReference('documentRef', ref);
            const normalized = validateAndNormalizeDocumentData(
              'data',
              data,
              'none',
              isAppBackedRoot(rootDb),
            );
            const unwrappedRef = unwrapAdminObject(ref);
            t.create(unwrappedRef, normalized);
            hasQueuedWrites = true;
            mutations.push({ path: unwrappedRef.path, kind: 'write' });
            return proxy;
          };
        case 'set':
          return (ref: DocumentReference, data: DocumentData, options?: SetOptions) => {
            assertWritable();
            const validated = validateAndNormalizeSetCall(
              data,
              options,
              true,
              isAppBackedRoot(rootDb),
            );
            assertAdminDocumentReference('documentRef', ref);
            const unwrappedRef = unwrapAdminObject(ref);
            t.set(unwrappedRef, validated.data, validated.options);
            hasQueuedWrites = true;
            mutations.push({ path: unwrappedRef.path, kind: 'write' });
            return proxy;
          };
        case 'update':
          return (...allArgs: unknown[]) => {
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
              isAppBackedRoot(rootDb),
            );
            const precondition = extractUpdateTrailingPrecondition(rawUpdateArgs);
            const unwrappedRef = unwrapAdminObject(ref);
            if (precondition !== undefined) {
              pendingPreconditions.push({
                path: unwrappedRef.path,
                method: 'update',
                precondition,
              });
            }
            (t.update as (r: DocumentReference, ...a: unknown[]) => Transaction)(
              unwrappedRef,
              ...normalizedArgs,
            );
            hasQueuedWrites = true;
            mutations.push({ path: unwrappedRef.path, kind: 'write' });
            return proxy;
          };
        case 'delete':
          return (ref: DocumentReference, ...rest: [precondition?: unknown]) => {
            assertWritable();
            assertAdminDocumentReference('documentRef', ref);
            validatePreconditionObject('precondition', rest[0], false);
            const precondition = extractParsedPrecondition(rest[0]);
            const unwrappedRef = unwrapAdminObject(ref);
            if (precondition !== undefined) {
              pendingPreconditions.push({
                path: unwrappedRef.path,
                method: 'delete',
                precondition,
              });
            }
            t.delete(unwrappedRef);
            hasQueuedWrites = true;
            mutations.push({ path: unwrappedRef.path, kind: 'delete' });
            return proxy;
          };
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
    async verifyPreconditions(): Promise<void> {
      for (const item of pendingPreconditions) {
        const cachedExists = txReadExists.get(item.path);
        if (cachedExists !== undefined) {
          verifyPreconditionState(rawDb, item.path, item.method, item.precondition, cachedExists);
        } else {
          await assertSingleWritePrecondition(rawDb, item.path, item.method, item.precondition);
        }
      }
    },
  };
}

function parseTransactionOptions(rawOptions: unknown): {
  readOnly: boolean;
  forwarded: OperationOptions | undefined;
} {
  if (!rawOptions) {
    return { readOnly: false, forwarded: undefined };
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
    return { readOnly: true, forwarded };
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
): Promise<R> {
  if (typeof updateFunction !== 'function') {
    throw new SandboxError(
      'invalid-argument',
      'Value for argument "updateFunction" is not a valid function.',
    );
  }
  const parsedOpts = parseTransactionOptions(rawOptions);
  const callback = updateFunction as (tx: Transaction) => Promise<R>;
  let committedAttemptMutations: Array<{ readonly path: string; readonly kind: 'write' | 'delete' }> = [];

  return rawDb
    .runTransaction(async (rawTx) => {
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
      await attempt.verifyPreconditions();
      committedAttemptMutations = attempt.mutations;
      return value;
    }, parsedOpts.forwarded)
    .then((result) => {
      recordTransactionAdminMutations(rawDb, committedAttemptMutations);
      return result;
    })
    .catch(translateAdminTransactionError);
}
