/**
 * `DocumentReference` proxy wrapper for `pyric-admin/firestore` supporting
 * `.firestore`, `.parent`, `.isEqual()`, `.listCollections()`, and
 * `.withConverter()`.
 */

import {
  copyAdminReferenceRegistration,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type OperationOptions,
  type SetOptions,
} from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore, Unsubscribe } from 'pyric/sandbox/admin-firestore';
import {
  adminDocListCollections,
  adminHandleConverter,
  applyConverterToWritePayload,
  assertValidConverterOrNull,
  type AdminFirestoreDataConverter,
} from './admin-converter-and-discovery.js';
import {
  runWithAdminErrorsAsync,
  runWithAdminErrorsSync,
} from './admin-grpc-errors.js';
import {
  adminDocumentRefBrand,
  adminRawDbSandbox,
  adminToRootDb,
  adminToUnderlying,
  isAppBackedRoot,
} from './admin-handle-registry.js';
import { normalizeCollectionPath } from './admin-path-validation.js';
import {
  capturePreWriteBaselines,
  recordPostWriteVersions,
} from './admin-read-time-history.js';
import { isAdminDocRefEqual } from './admin-reference-and-snapshot-equality.js';
import {
  markAdminFirestoreStarted,
  shouldIgnoreUndefinedProperties,
  stripUndefinedForSettings,
} from './admin-settings-lifecycle.js';
import { wrapDocSnapshot, type DocRefBuilder } from './admin-snapshot-adapter.js';
import { validateAndNormalizeUpdateArgs } from './admin-update-validation.js';
import {
  assertSingleWritePrecondition,
  extractParsedPrecondition,
  extractUpdateTrailingPrecondition,
  recordSingleAdminDelete,
  recordSingleAdminWrite,
  type WriteResult,
} from './admin-write-result-preconditions.js';
import {
  validateAndNormalizeSetCall,
  validatePreconditionObject,
} from './admin-set-and-precondition-validation.js';
import { validateAndNormalizeDocumentData } from './admin-write-validation.js';

const SYNTHETIC_DOC_REF_PROPS = new Set<PropertyKey>([
  'firestore',
  'isEqual',
  'listCollections',
  'withConverter',
]);

export interface WrapDocRefCallbacks {
  readonly wrapCollectionRef: (
    rawColl: CollectionReference,
    rawDb: SandboxFirestore,
    rootDb: SandboxFirestore,
    converter?: AdminFirestoreDataConverter,
  ) => CollectionReference;
  readonly docRefOnRoot: DocRefBuilder;
  readonly instanceOnSnapshot: (ref: unknown, ...rest: unknown[]) => Unsubscribe;
}

export function createWrappedDocRef(
  rawRef: DocumentReference,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  callbacks: WrapDocRefCallbacks,
  converter?: AdminFirestoreDataConverter,
): DocumentReference {
  const appBacked = isAppBackedRoot(rootDb);
  const proxy: DocumentReference = new Proxy(rawRef, {
    has(t, prop) {
      if (SYNTHETIC_DOC_REF_PROPS.has(prop)) return true;
      return Reflect.has(t, prop);
    },
    getOwnPropertyDescriptor(t, prop) {
      const own = Reflect.getOwnPropertyDescriptor(t, prop);
      if (own !== undefined) return own;
      if (SYNTHETIC_DOC_REF_PROPS.has(prop)) {
        return {
          value: Reflect.get(proxy, prop, proxy),
          writable: true,
          enumerable: false,
          configurable: true,
        };
      }
      return undefined;
    },
    get(t, prop, receiver) {
      switch (prop) {
        case 'firestore':
          return rootDb;
        case 'parent':
          return callbacks.wrapCollectionRef(t.parent, rawDb, rootDb, converter);
        case 'isEqual':
          return (other: unknown) => isAdminDocRefEqual(proxy, other);
        case 'listCollections':
          return () =>
            runWithAdminErrorsAsync(appBacked, () =>
              adminDocListCollections(rootDb, rawDb, adminRawDbSandbox.get(rawDb), t.path),
            );
        case 'withConverter':
          return (nextConv: unknown) =>
            runWithAdminErrorsSync(appBacked, () =>
              createWrappedDocRef(t, rawDb, rootDb, callbacks, assertValidConverterOrNull(nextConv)),
            );
        case 'collection':
          return (name: string) =>
            runWithAdminErrorsSync(appBacked, () =>
              callbacks.wrapCollectionRef(t.collection(normalizeCollectionPath(name)), rawDb, rootDb),
            );
        case 'get':
          return (opts?: OperationOptions) =>
            runWithAdminErrorsAsync(appBacked, async () => {
              markAdminFirestoreStarted(rootDb);
              return wrapDocSnapshot(await t.get(opts), rootDb, callbacks.docRefOnRoot, { converter });
            });
        case 'create':
          return (data: DocumentData, opts?: OperationOptions): Promise<WriteResult> => {
            const normalized = runWithAdminErrorsSync(appBacked, () => {
              markAdminFirestoreStarted(rootDb);
              let payload: unknown = applyConverterToWritePayload(converter, data);
              if (shouldIgnoreUndefinedProperties(rootDb)) payload = stripUndefinedForSettings(payload);
              return validateAndNormalizeDocumentData('data', payload, 'none', appBacked);
            });
            return runWithAdminErrorsAsync(appBacked, async () => {
              await capturePreWriteBaselines(rawDb, rootDb, callbacks.docRefOnRoot, [t.path]);
              await t.create(normalized, opts);
              const res = recordSingleAdminWrite(rawDb, t.path);
              await recordPostWriteVersions(
                rawDb,
                rootDb,
                callbacks.docRefOnRoot,
                [{ path: t.path, kind: 'write' }],
                res.writeTime,
              );
              return res;
            });
          };
        case 'set':
          return (data: DocumentData, options?: SetOptions): Promise<WriteResult> => {
            const validated = runWithAdminErrorsSync(appBacked, () => {
              markAdminFirestoreStarted(rootDb);
              let payload: unknown = applyConverterToWritePayload(converter, data, options);
              if (shouldIgnoreUndefinedProperties(rootDb)) payload = stripUndefinedForSettings(payload);
              return validateAndNormalizeSetCall(payload, options, true, appBacked);
            });
            return runWithAdminErrorsAsync(appBacked, async () => {
              await capturePreWriteBaselines(rawDb, rootDb, callbacks.docRefOnRoot, [t.path]);
              await t.set(validated.data, validated.options);
              const res = recordSingleAdminWrite(rawDb, t.path);
              await recordPostWriteVersions(
                rawDb,
                rootDb,
                callbacks.docRefOnRoot,
                [{ path: t.path, kind: 'write' }],
                res.writeTime,
              );
              return res;
            });
          };
        case 'update':
          return (...args: unknown[]): Promise<WriteResult> => {
            const normalized = runWithAdminErrorsSync(appBacked, () => {
              markAdminFirestoreStarted(rootDb);
              return validateAndNormalizeUpdateArgs(args, appBacked);
            });
            return runWithAdminErrorsAsync(appBacked, async () => {
              await assertSingleWritePrecondition(rawDb, t.path, 'update', extractUpdateTrailingPrecondition(args));
              await capturePreWriteBaselines(rawDb, rootDb, callbacks.docRefOnRoot, [t.path]);
              await (t.update as (...a: unknown[]) => Promise<void>)(...normalized);
              const res = recordSingleAdminWrite(rawDb, t.path);
              await recordPostWriteVersions(
                rawDb,
                rootDb,
                callbacks.docRefOnRoot,
                [{ path: t.path, kind: 'write' }],
                res.writeTime,
              );
              return res;
            });
          };
        case 'delete':
          return (...args: [opts?: OperationOptions]): Promise<WriteResult> => {
            const validatedOpts = runWithAdminErrorsSync(appBacked, () => {
              markAdminFirestoreStarted(rootDb);
              return validatePreconditionObject('precondition', args[0]);
            });
            return runWithAdminErrorsAsync(appBacked, async () => {
              await assertSingleWritePrecondition(rawDb, t.path, 'delete', extractParsedPrecondition(args[0]));
              await capturePreWriteBaselines(rawDb, rootDb, callbacks.docRefOnRoot, [t.path]);
              await t.delete(validatedOpts);
              const res = recordSingleAdminDelete(rawDb, t.path);
              await recordPostWriteVersions(
                rawDb,
                rootDb,
                callbacks.docRefOnRoot,
                [{ path: t.path, kind: 'delete' }],
                res.writeTime,
              );
              return res;
            });
          };
        case 'onSnapshot': {
          const underlying = Reflect.get(t, prop, t);
          if (typeof underlying === 'function') {
            return (...args: unknown[]) => callbacks.instanceOnSnapshot(receiver, ...args);
          }
          return underlying;
        }
        default: {
          const value = Reflect.get(t, prop, t);
          if (typeof value === 'function') return value.bind(t);
          return value;
        }
      }
    },
  });
  copyAdminReferenceRegistration(rawRef, proxy);
  adminDocumentRefBrand.add(proxy);
  adminToUnderlying.set(proxy, rawRef);
  adminToRootDb.set(proxy, rootDb);
  if (converter !== undefined) {
    adminHandleConverter.set(proxy, converter);
  }
  return proxy;
}
