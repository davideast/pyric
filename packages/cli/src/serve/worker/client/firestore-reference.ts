import { registerReferenceQueryValue } from 'pyric/firestore/internal/value-codec';
import type { FirestoreDataConverter, DocumentData } from 'pyric/firestore';
import type { CollRef } from '../protocol.js';
import { normalizeClientDatabaseId } from './firestore-database.js';
import { lastSegment, type ClientPort, type CollRefHandle, type DocRefHandle } from './handles.js';
import { bindWorkerHandleOwner, getActiveWorkerDbForPort } from './firestore-lifecycle.js';

function parentCollectionPath(docPath: string): string {
  const slashIndex = docPath.lastIndexOf('/');
  if (slashIndex <= 0) {
    return '';
  }
  return docPath.slice(0, slashIndex);
}

function parentDocumentPath(collPath: string): string | null {
  const slashIndex = collPath.lastIndexOf('/');
  if (slashIndex <= 0) {
    return null;
  }
  return collPath.slice(0, slashIndex);
}

/** Collection handles are rebuilt per view so each carries its own converter. */
export function createCollectionReference<T = DocumentData>(
  port: ClientPort,
  path: string,
  converter: FirestoreDataConverter<unknown> | null,
  owner?: object,
  databaseId?: string,
): CollRefHandle<T> {
  let effectiveOwner = owner;
  if (effectiveOwner === undefined) {
    effectiveOwner = getActiveWorkerDbForPort(port);
  }
  const ownerDb = normalizeClientDatabaseId(
    databaseId ?? (effectiveOwner as { databaseId?: string } | undefined)?.databaseId,
  );
  function withConverter<A, D extends DocumentData = DocumentData>(
    next: FirestoreDataConverter<A, D>,
  ): CollRefHandle<A>;
  function withConverter(next: null): CollRefHandle;
  function withConverter(next: FirestoreDataConverter<unknown> | null): CollRefHandle<unknown> {
    return createCollectionReference(port, path, next, effectiveOwner, ownerDb);
  }
  const descriptor: CollRef = { __ref: 'collection', path };
  const collRef: CollRefHandle<T> = {
    __kind: 'coll-ref',
    type: 'collection',
    descriptor,
    port,
    id: lastSegment(path),
    path,
    converter,
    get parent(): DocRefHandle | null {
      const docPath = parentDocumentPath(path);
      if (docPath === null) {
        return null;
      }
      return createDocumentReference(port, docPath, null, effectiveOwner, ownerDb);
    },
    withConverter,
  };
  if (ownerDb !== undefined) {
    (collRef as { databaseId?: string }).databaseId = ownerDb;
  }
  return bindWorkerHandleOwner(collRef, effectiveOwner);
}

/** References returned by reads and factories share the receiving client's lifetime. */
export function createDocumentReference<T = DocumentData>(
  port: ClientPort,
  path: string,
  converter: FirestoreDataConverter<unknown> | null = null,
  owner?: object,
  databaseId?: string,
): DocRefHandle<T> {
  let effectiveOwner = owner;
  if (effectiveOwner === undefined) {
    effectiveOwner = getActiveWorkerDbForPort(port);
  }
  const ownerDb = normalizeClientDatabaseId(
    databaseId ?? (effectiveOwner as { databaseId?: string } | undefined)?.databaseId,
  );
  function withConverter<A, D extends DocumentData = DocumentData>(
    next: FirestoreDataConverter<A, D>,
  ): DocRefHandle<A>;
  function withConverter(next: null): DocRefHandle;
  function withConverter(next: FirestoreDataConverter<unknown> | null): DocRefHandle<unknown> {
    return createDocumentReference(port, path, next, effectiveOwner, ownerDb);
  }
  const reference: DocRefHandle<T> = {
    __kind: 'doc-ref',
    type: 'document',
    descriptor: { __ref: 'doc', path },
    port,
    id: lastSegment(path),
    path,
    converter,
    get parent(): CollRefHandle<T> {
      return createCollectionReference<T>(port, parentCollectionPath(path), converter, effectiveOwner, ownerDb);
    },
    withConverter,
  };
  if (ownerDb !== undefined) {
    (reference as { databaseId?: string }).databaseId = ownerDb;
  }
  registerReferenceQueryValue(reference, path, effectiveOwner ?? port, reference, ownerDb);
  return bindWorkerHandleOwner(reference, effectiveOwner);
}
