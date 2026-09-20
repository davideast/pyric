import { registerReferenceQueryValue } from 'pyric/firestore/internal/value-codec';
import type { FirestoreDataConverter, DocumentData } from 'pyric/firestore';
import { lastSegment, type ClientPort, type DocRefHandle } from './handles.js';

/** References returned by reads and factories share the receiving client's lifetime. */
export function createDocumentReference<T = DocumentData>(
  port: ClientPort,
  path: string,
  converter: FirestoreDataConverter<unknown> | null = null,
): DocRefHandle<T> {
  function withConverter<A, D extends DocumentData = DocumentData>(next: FirestoreDataConverter<A, D>): DocRefHandle<A>;
  function withConverter(next: null): DocRefHandle;
  function withConverter(next: FirestoreDataConverter<unknown> | null): DocRefHandle<unknown> {
    return createDocumentReference(port, path, next);
  }
  const reference: DocRefHandle<T> = {
    __kind: 'doc-ref',
    descriptor: { __ref: 'doc', path },
    port,
    id: lastSegment(path),
    path,
    converter,
    withConverter,
  };
  registerReferenceQueryValue(reference, path, port);
  return reference;
}
