/**
 * Admin-SDK `FirestoreDataConverter` (`withConverter`) and reference discovery
 * (`CollectionReference.listDocuments`, `DocumentReference.listCollections`)
 * across local (`rawDb.snapshot()`) and remote (`admin.readState`) sandboxes.
 */

import { isRemoteSandbox, type Sandbox } from 'pyric/sandbox';
import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  QueryDocumentSnapshot,
  SetOptions,
} from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import { markAdminFirestoreStarted } from './admin-settings-lifecycle.js';

export interface AdminFirestoreDataConverter<T = unknown> {
  toFirestore(modelObject: T): DocumentData;
  toFirestore(modelObject: Partial<T>, options: SetOptions): DocumentData;
  fromFirestore(snapshot: QueryDocumentSnapshot): T;
}

export const adminHandleConverter = new WeakMap<object, AdminFirestoreDataConverter>();

export function assertValidConverterOrNull(
  converter: unknown,
): AdminFirestoreDataConverter | undefined {
  if (converter === null) {
    return undefined;
  }
  if (
    typeof converter === 'object' &&
    converter !== null &&
    typeof (converter as { toFirestore?: unknown }).toFirestore === 'function' &&
    typeof (converter as { fromFirestore?: unknown }).fromFirestore === 'function'
  ) {
    return converter as AdminFirestoreDataConverter;
  }
  throw new Error(
    'Value for argument "converter" is not a valid FirestoreDataConverter.',
  );
}

export function applyConverterToWritePayload(
  converter: AdminFirestoreDataConverter | undefined,
  model: unknown,
  options?: SetOptions,
): unknown {
  if (converter === undefined) {
    return model;
  }
  if (options !== undefined && ('merge' in options || 'mergeFields' in options)) {
    return (converter.toFirestore as (m: unknown, o: SetOptions) => DocumentData)(model, options);
  }
  return converter.toFirestore(model);
}

async function readStorePathsUnderPrefix(
  rawDb: SandboxFirestore,
  sandbox: Sandbox | undefined,
  pathPrefix: string,
): Promise<string[]> {
  if (sandbox !== undefined && isRemoteSandbox(sandbox)) {
    const state = (await sandbox.channel.op({
      method: 'admin.readState',
      path: pathPrefix,
    })) as Record<string, unknown>;
    return Object.keys(state);
  }
  return Object.keys(rawDb.snapshot());
}

export async function adminCollectionListDocuments(
  rootDb: SandboxFirestore,
  rawDb: SandboxFirestore,
  sandbox: Sandbox | undefined,
  collectionPath: string,
  converter: AdminFirestoreDataConverter | undefined,
): Promise<DocumentReference[]> {
  markAdminFirestoreStarted(rootDb);
  const cleanCol = collectionPath.replace(/^\/+|\/+$/g, '');
  const prefix = `${cleanCol}/`;
  const allPaths = await readStorePathsUnderPrefix(rawDb, sandbox, cleanCol);
  const docIds = new Set<string>();
  for (const docPath of allPaths) {
    if (!docPath.startsWith(prefix)) continue;
    const remainder = docPath.slice(prefix.length);
    if (remainder.length === 0) continue;
    const slashIdx = remainder.indexOf('/');
    if (slashIdx === -1) {
      docIds.add(remainder);
    } else if (slashIdx > 0) {
      docIds.add(remainder.slice(0, slashIdx));
    }
  }
  return [...docIds].sort().map((id) => {
    const baseRef = rootDb.doc(`${cleanCol}/${id}`);
    if (converter !== undefined && typeof (baseRef as { withConverter?: unknown }).withConverter === 'function') {
      return (baseRef as unknown as { withConverter(c: AdminFirestoreDataConverter): DocumentReference }).withConverter(converter);
    }
    return baseRef;
  });
}

export async function adminDocListCollections(
  rootDb: SandboxFirestore,
  rawDb: SandboxFirestore,
  sandbox: Sandbox | undefined,
  documentPath: string,
): Promise<CollectionReference[]> {
  markAdminFirestoreStarted(rootDb);
  const cleanDoc = documentPath.replace(/^\/+|\/+$/g, '');
  const prefix = `${cleanDoc}/`;
  const allPaths = await readStorePathsUnderPrefix(rawDb, sandbox, cleanDoc);
  const subColIds = new Set<string>();
  for (const docPath of allPaths) {
    if (!docPath.startsWith(prefix)) continue;
    const remainder = docPath.slice(prefix.length);
    const slashIdx = remainder.indexOf('/');
    if (slashIdx > 0) {
      subColIds.add(remainder.slice(0, slashIdx));
    }
  }
  return [...subColIds].sort().map((subId) => rootDb.collection(`${cleanDoc}/${subId}`));
}
