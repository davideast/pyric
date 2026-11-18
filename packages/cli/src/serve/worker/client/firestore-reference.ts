import { registerReferenceQueryValue } from 'pyric/firestore/internal/value-codec';
import type { FirestoreDataConverter, DocumentData } from 'pyric/firestore';
import type { CollRef } from '../protocol.js';
import { lastSegment, type ClientPort, type CollRefHandle, type DocRefHandle } from './handles.js';

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
): CollRefHandle<T> {
  function withConverter<A, D extends DocumentData = DocumentData>(
    next: FirestoreDataConverter<A, D>,
  ): CollRefHandle<A>;
  function withConverter(next: null): CollRefHandle;
  function withConverter(next: FirestoreDataConverter<unknown> | null): CollRefHandle<unknown> {
    return createCollectionReference(port, path, next);
  }
  const descriptor: CollRef = { __ref: 'collection', path };
  return {
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
      return createDocumentReference(port, docPath, null);
    },
    withConverter,
  };
}

/** References returned by reads and factories share the receiving client's lifetime. */
export function createDocumentReference<T = DocumentData>(
  port: ClientPort,
  path: string,
  converter: FirestoreDataConverter<unknown> | null = null,
): DocRefHandle<T> {
  function withConverter<A, D extends DocumentData = DocumentData>(
    next: FirestoreDataConverter<A, D>,
  ): DocRefHandle<A>;
  function withConverter(next: null): DocRefHandle;
  function withConverter(next: FirestoreDataConverter<unknown> | null): DocRefHandle<unknown> {
    return createDocumentReference(port, path, next);
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
      return createCollectionReference<T>(port, parentCollectionPath(path), converter);
    },
    withConverter,
  };
  registerReferenceQueryValue(reference, path, port);
  return reference;
}
