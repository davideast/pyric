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
  assertRootActive,
  lifecycleOf,
  runAsyncWithLifecycle,
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
import { validateAndNormalizeUpdateArgs } from './admin-update-validation.js';
import {
  assertAdminDocumentReference,
  isObjectRecord,
  validateAndNormalizeDocumentData,
  validateAndNormalizeSetCall,
  validatePreconditionObject,
} from './admin-write-validation.js';

const READ_ONLY_WRITE_ERROR = 'Firestore read-only transactions cannot execute writes.';

type BufferedBatchOperation =
  | { readonly kind: 'create'; readonly ref: DocumentReference; readonly data: DocumentData }
  | {
      readonly kind: 'set';
      readonly ref: DocumentReference;
      readonly data: DocumentData;
      readonly options: SetOptions | undefined;
    }
  | { readonly kind: 'update'; readonly ref: DocumentReference; readonly args: readonly unknown[] }
  | { readonly kind: 'delete'; readonly ref: DocumentReference };

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
            assertRootActive(rootDb);
            assertAdminDocumentReference('documentRef', ref);
            const normalized = validateAndNormalizeDocumentData(
              'data',
              data,
              'none',
              lifecycleOf(rootDb) !== undefined,
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
            assertRootActive(rootDb);
            const validated = validateAndNormalizeSetCall(
              data,
              rest[0],
              false,
              lifecycleOf(rootDb) !== undefined,
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
            assertRootActive(rootDb);
            if (allArgs.length < 2) {
              throw new SandboxError(
                'invalid-argument',
                'Function "WriteBatch.update()" requires at least 2 arguments.',
              );
            }
            const ref = allArgs[0] as DocumentReference;
            assertAdminDocumentReference('documentRef', ref);
            assertBatchMutable();
            const normalizedArgs = validateAndNormalizeUpdateArgs(
              allArgs.slice(1),
              lifecycleOf(rootDb) !== undefined,
            );
            bufferedOps.push({
              kind: 'update',
              ref: unwrapAdminObject(ref),
              args: normalizedArgs,
            });
            return proxy;
          };
        case 'delete':
          return (ref: DocumentReference, ...rest: [precondition?: unknown]) => {
            assertRootActive(rootDb);
            assertAdminDocumentReference('documentRef', ref);
            validatePreconditionObject('precondition', rest[0], false);
            assertBatchMutable();
            bufferedOps.push({
              kind: 'delete',
              ref: unwrapAdminObject(ref),
            });
            return proxy;
          };
        case 'commit':
          return (opts?: OperationOptions) =>
            runAsyncWithLifecycle(rootDb, () => {
              committed = true;
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
              return executionBatch.commit(opts);
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

function wrapTransaction(
  rawTx: Transaction,
  rootDb: SandboxFirestore,
  readOnly: boolean,
  docRefOnRoot: (db: SandboxFirestore, path: string) => DocumentReference,
): Transaction {
  function assertWritable(): void {
    if (readOnly) {
      throw new SandboxError('invalid-argument', READ_ONLY_WRITE_ERROR);
    }
  }

  const proxy: Transaction = new Proxy(rawTx, {
    get(t, prop) {
      switch (prop) {
        case 'get':
          return (refOrQuery: DocumentReference | Query) =>
            runAsyncWithLifecycle<QuerySnapshot | DocumentSnapshot>(rootDb, async () => {
              if (isAdminQueryTarget(refOrQuery)) {
                assertQueryExecutable(adminQueryMetadata.get(refOrQuery));
                const unwrappedQuery = unwrapAdminObject(refOrQuery);
                const snap = await t.get(unwrappedQuery);
                return wrapQuerySnapshot(snap, rootDb, docRefOnRoot);
              }
              if (isAdminDocRefTarget(refOrQuery)) {
                const unwrappedRef = unwrapAdminObject(refOrQuery);
                const snap = await t.get(unwrappedRef);
                return wrapDocSnapshot(snap, rootDb, docRefOnRoot);
              }
              throw new SandboxError(
                'invalid-argument',
                'Value for argument "refOrQuery" must be a DocumentReference, Query, or AggregateQuery.',
              );
            });
        case 'create':
          return (ref: DocumentReference, data: DocumentData) => {
            assertRootActive(rootDb);
            assertWritable();
            assertAdminDocumentReference('documentRef', ref);
            const normalized = validateAndNormalizeDocumentData(
              'data',
              data,
              'none',
              lifecycleOf(rootDb) !== undefined,
            );
            t.create(unwrapAdminObject(ref), normalized);
            return proxy;
          };
        case 'set':
          return (ref: DocumentReference, data: DocumentData, options?: SetOptions) => {
            assertRootActive(rootDb);
            assertWritable();
            const validated = validateAndNormalizeSetCall(
              data,
              options,
              true,
              lifecycleOf(rootDb) !== undefined,
            );
            assertAdminDocumentReference('documentRef', ref);
            t.set(unwrapAdminObject(ref), validated.data, validated.options);
            return proxy;
          };
        case 'update':
          return (...allArgs: unknown[]) => {
            assertRootActive(rootDb);
            assertWritable();
            if (allArgs.length < 2) {
              throw new SandboxError(
                'invalid-argument',
                'Function "Transaction.update()" requires at least 2 arguments.',
              );
            }
            const ref = allArgs[0] as DocumentReference;
            assertAdminDocumentReference('documentRef', ref);
            const normalizedArgs = validateAndNormalizeUpdateArgs(
              allArgs.slice(1),
              lifecycleOf(rootDb) !== undefined,
            );
            (t.update as (r: DocumentReference, ...a: unknown[]) => Transaction)(
              unwrapAdminObject(ref),
              ...normalizedArgs,
            );
            return proxy;
          };
        case 'delete':
          return (ref: DocumentReference, ...rest: [precondition?: unknown]) => {
            assertRootActive(rootDb);
            assertWritable();
            assertAdminDocumentReference('documentRef', ref);
            validatePreconditionObject('precondition', rest[0], false);
            t.delete(unwrapAdminObject(ref));
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
  });

  adminToUnderlying.set(proxy, rawTx);
  adminToRootDb.set(proxy, rootDb);
  return proxy;
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

  return {
    readOnly: false,
    forwarded: hasForwardedField ? forwarded : undefined,
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
  return runAsyncWithLifecycle(rootDb, () => {
    if (typeof updateFunction !== 'function') {
      throw new SandboxError(
        'invalid-argument',
        'Value for argument "updateFunction" is not a valid function.',
      );
    }
    const parsedOpts = parseTransactionOptions(rawOptions);
    const callback = updateFunction as (tx: Transaction) => Promise<R>;

    return rawDb
      .runTransaction(async (rawTx) => {
        assertRootActive(rootDb);
        const wrappedTx = wrapTransaction(rawTx, rootDb, parsedOpts.readOnly, docRefOnRoot);
        const returned = callback(wrappedTx);
        if (!isThenable(returned)) {
          throw new SandboxError(
            'invalid-argument',
            'You must return a Promise in your transaction()-callback.',
          );
        }
        const result = await returned;
        assertRootActive(rootDb);
        return result;
      }, parsedOpts.forwarded)
      .catch(translateAdminTransactionError);
  });
}
