/**
 * Admin-SDK `WriteBatch` validation and execution wrapper (`@google-cloud/firestore`
 * parity across local and JSON-wire remote sandboxes).
 */

import type {
  DocumentData,
  DocumentReference,
  OperationOptions,
  SetOptions,
  WriteBatch,
} from 'pyric/sandbox/admin-compat';
import { SandboxError } from 'pyric/sandbox';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import {
  runWithAdminErrorsAsync,
  runWithAdminErrorsSync,
} from './admin-grpc-errors.js';
import {
  adminToRootDb,
  adminToUnderlying,
  isAppBackedRoot,
  unwrapAdminObject,
} from './admin-handle-registry.js';
import {
  capturePreWriteBaselines,
  recordPostWriteVersions,
} from './admin-read-time-history.js';
import {
  validateAndNormalizeSetCall,
  validatePreconditionObject,
} from './admin-set-and-precondition-validation.js';
import { validateAndNormalizeUpdateArgs } from './admin-update-validation.js';
import {
  assertBatchPreconditions,
  extractParsedPrecondition,
  extractUpdateTrailingPrecondition,
  recordBatchAdminMutations,
  type ParsedAdminPrecondition,
  type WriteResult,
} from './admin-write-result-preconditions.js';
import {
  assertAdminDocumentReference,
  validateAndNormalizeDocumentData,
} from './admin-write-validation.js';

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

export function wrapWriteBatch(
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  docRefOnRoot: (db: SandboxFirestore, path: string) => DocumentReference,
): WriteBatch {
  const protoBatch = rawDb.batch();
  const bufferedOps: BufferedBatchOperation[] = [];
  const appBacked = isAppBackedRoot(rootDb);
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
          return (ref: DocumentReference, data: DocumentData) =>
            runWithAdminErrorsSync(appBacked, () => {
              assertAdminDocumentReference('documentRef', ref);
              const normalized = validateAndNormalizeDocumentData(
                'data',
                data,
                'none',
                appBacked,
              );
              assertBatchMutable();
              bufferedOps.push({
                kind: 'create',
                ref: unwrapAdminObject(ref),
                data: normalized,
              });
              return proxy;
            });
        case 'set':
          return (ref: DocumentReference, data: DocumentData, ...rest: [options?: SetOptions]) =>
            runWithAdminErrorsSync(appBacked, () => {
              const validated = validateAndNormalizeSetCall(
                data,
                rest[0],
                false,
                appBacked,
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
            });
        case 'update':
          return (...allArgs: unknown[]) =>
            runWithAdminErrorsSync(appBacked, () => {
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
                appBacked,
              );
              const precondition = extractUpdateTrailingPrecondition(rawUpdateArgs);
              bufferedOps.push({
                kind: 'update',
                ref: unwrapAdminObject(ref),
                args: normalizedArgs,
                precondition,
              });
              return proxy;
            });
        case 'delete':
          return (ref: DocumentReference, ...rest: [precondition?: unknown]) =>
            runWithAdminErrorsSync(appBacked, () => {
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
            });
        case 'commit':
          return (opts?: OperationOptions): Promise<WriteResult[]> =>
            runWithAdminErrorsAsync(appBacked, async () => {
              assertBatchMutable();
              committed = true;
              await assertBatchPreconditions(rawDb, bufferedOps);
              const affectedPaths = bufferedOps.map((op) => op.ref.path);
              await capturePreWriteBaselines(rawDb, rootDb, docRefOnRoot, affectedPaths);
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
              const results = recordBatchAdminMutations(rawDb, mutationSummary);
              const commitTime = results[0]?.writeTime;
              if (commitTime !== undefined) {
                await recordPostWriteVersions(rawDb, rootDb, docRefOnRoot, mutationSummary, commitTime);
              }
              return results;
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
