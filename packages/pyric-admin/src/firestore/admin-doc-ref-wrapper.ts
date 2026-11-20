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
  adminDocumentRefBrand,
  adminRawDbSandbox,
  adminToRootDb,
  adminToUnderlying,
  isAppBackedRoot,
} from './admin-handle-registry.js';
import { normalizeCollectionPath } from './admin-path-validation.js';
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
  validateAndNormalizeDocumentData,
  validateAndNormalizeSetCall,
  validatePreconditionObject,
} from './admin-write-validation.js';

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
          return () => adminDocListCollections(rootDb, rawDb, adminRawDbSandbox.get(rawDb), t.path);
        case 'withConverter':
          return (nextConv: unknown) =>
            createWrappedDocRef(t, rawDb, rootDb, callbacks, assertValidConverterOrNull(nextConv));
        case 'collection':
          return (name: string) =>
            callbacks.wrapCollectionRef(t.collection(normalizeCollectionPath(name)), rawDb, rootDb);
        case 'get':
          return async (opts?: OperationOptions) => {
            markAdminFirestoreStarted(rootDb);
            return wrapDocSnapshot(await t.get(opts), rootDb, callbacks.docRefOnRoot, { converter });
          };
        case 'create':
          return async (data: DocumentData, opts?: OperationOptions): Promise<WriteResult> => {
            markAdminFirestoreStarted(rootDb);
            let payload: unknown = applyConverterToWritePayload(converter, data);
            if (shouldIgnoreUndefinedProperties(rootDb)) payload = stripUndefinedForSettings(payload);
            const normalized = validateAndNormalizeDocumentData('data', payload, 'none', isAppBackedRoot(rootDb));
            await t.create(normalized, opts);
            return recordSingleAdminWrite(rawDb, t.path);
          };
        case 'set':
          return async (data: DocumentData, options?: SetOptions): Promise<WriteResult> => {
            markAdminFirestoreStarted(rootDb);
            let payload: unknown = applyConverterToWritePayload(converter, data, options);
            if (shouldIgnoreUndefinedProperties(rootDb)) payload = stripUndefinedForSettings(payload);
            const validated = validateAndNormalizeSetCall(payload, options, true, isAppBackedRoot(rootDb));
            await t.set(validated.data, validated.options);
            return recordSingleAdminWrite(rawDb, t.path);
          };
        case 'update':
          return async (...args: unknown[]): Promise<WriteResult> => {
            markAdminFirestoreStarted(rootDb);
            const normalized = validateAndNormalizeUpdateArgs(args, isAppBackedRoot(rootDb));
            await assertSingleWritePrecondition(rawDb, t.path, 'update', extractUpdateTrailingPrecondition(args));
            await (t.update as (...a: unknown[]) => Promise<void>)(...normalized);
            return recordSingleAdminWrite(rawDb, t.path);
          };
        case 'delete':
          return async (...args: [opts?: OperationOptions]): Promise<WriteResult> => {
            markAdminFirestoreStarted(rootDb);
            const validatedOpts = validatePreconditionObject('precondition', args[0]);
            await assertSingleWritePrecondition(rawDb, t.path, 'delete', extractParsedPrecondition(args[0]));
            await t.delete(validatedOpts);
            return recordSingleAdminDelete(rawDb, t.path);
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
