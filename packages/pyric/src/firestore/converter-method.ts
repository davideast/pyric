/**
 * `pyric/firestore` -- the `withConverter` instance method and typed view
 * builders for document, collection, and query values.
 *
 * Package-internal: not re-exported by the barrel, so it stays off the
 * published `pyric/firestore` surface.
 */
import {
  boundedActivityIdentity,
  registerActivityValue,
} from './sandbox/activity-value-registry.js';
import {
  targetOf,
  underlyingOf,
  buildSandboxShell,
  type Target,
} from './state.js';
import {
  copyQueryValueRegistration,
  registerReferenceQueryValue,
} from './sandbox/query-value-registry.js';
import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  FirestoreDataConverter,
} from './types.js';

type CollectionParentResolver = (
  owner: Target,
  collectionPath: string,
  converter: FirestoreDataConverter<unknown, DocumentData> | null,
) => CollectionReference<unknown>;

let resolveDocumentParentCollection: CollectionParentResolver | undefined;

export function registerDocumentParentCollectionResolver(
  resolver: CollectionParentResolver,
): void {
  resolveDocumentParentCollection = resolver;
}

function parentCollectionPathOf(docPath: string): string {
  const slashIndex = docPath.lastIndexOf('/');
  if (slashIndex <= 0) {
    return '';
  }
  return docPath.slice(0, slashIndex);
}

export function registerDocumentReferenceValue<T = DocumentData>(
  ref: { id: string; path: string },
  path: string,
  owner: Target,
  converter: FirestoreDataConverter<unknown, DocumentData> | null = null,
): DocumentReference<T> {
  function convert<A, D extends DocumentData = DocumentData>(
    nextConverter: FirestoreDataConverter<A, D>,
  ): DocumentReference<A>;
  function convert(nextConverter: null): DocumentReference<DocumentData>;
  function convert(
    nextConverter: FirestoreDataConverter<unknown, DocumentData> | null,
  ): DocumentReference<unknown> {
    if (nextConverter === null) {
      return registerDocumentReferenceValue(ref, path, owner, null);
    }
    return registerDocumentReferenceValue(ref, path, owner, nextConverter);
  }

  const underlying = underlyingOf(ref) as { id?: string; path?: string };
  const shell = buildSandboxShell(underlying, owner, converter);
  const reference = Object.assign(shell, {
    type: 'document' as const,
    converter,
    withConverter: convert,
  });
  Object.defineProperty(reference, 'parent', {
    get() {
      if (resolveDocumentParentCollection === undefined) {
        throw new Error('pyric/firestore: document parent collection resolver not initialized.');
      }
      return resolveDocumentParentCollection(owner, parentCollectionPathOf(path), converter);
    },
    enumerable: true,
    configurable: true,
  });
  registerActivityValue(reference, boundedActivityIdentity('reference', path));
  registerReferenceQueryValue(underlying, path, owner);
  copyQueryValueRegistration(underlying, reference);
  return reference as unknown as DocumentReference<T>;
}

/**
 * A fresh typed view over a collection or query. `null` strips the converter
 * and hands back the underlying untyped value, which already carries the
 * method, `type`, and `converter: null`.
 */
export function convertedView(
  source: object,
  converter: FirestoreDataConverter<unknown, DocumentData> | null,
): object {
  const underlying = underlyingOf(source);
  const rawKind = (source as { type?: unknown }).type;
  let refType: 'collection' | 'query' = 'query';
  if (rawKind === 'collection') {
    refType = 'collection';
  }
  const removesConverter = converter === null;
  if (removesConverter) return underlying;
  const target = targetOf(source);
  const shell = buildSandboxShell(
    underlying as { id?: string; path?: string },
    target,
    converter,
  );
  copyQueryValueRegistration(underlying, shell);
  return attachConverterMethod(shell, refType, converter);
}

/** Attach Firebase's `type`, `converter`, and `withConverter` members to a collection or query value. */
export function attachConverterMethod<V extends object>(
  value: V,
  refType: 'collection' | 'query' = 'query',
  converter: FirestoreDataConverter<unknown, DocumentData> | null = null,
): V {
  function convert<A, D extends DocumentData = DocumentData>(
    nextConverter: FirestoreDataConverter<A, D>,
  ): V;
  function convert(nextConverter: null): V;
  function convert(
    nextConverter: FirestoreDataConverter<unknown, DocumentData> | null,
  ): object {
    return convertedView(value, nextConverter);
  }
  return Object.assign(value, {
    type: refType,
    converter,
    withConverter: convert,
  });
}

/** Decorate a raw snapshot `.ref` object with `type`, `converter`, `parent`, and `withConverter`. */
export function decorateUntypedSnapshotRef(
  snapRef: { id?: string; path?: string },
  path: string,
  owner: Target,
): void {
  if ((snapRef as { type?: unknown }).type === undefined) {
    Object.defineProperty(snapRef, 'type', { value: 'document', configurable: true });
  }
  if ((snapRef as { converter?: unknown }).converter === undefined) {
    Object.defineProperty(snapRef, 'converter', { value: null, configurable: true, writable: true });
  }
  if (Object.getOwnPropertyDescriptor(snapRef, 'parent') === undefined) {
    Object.defineProperty(snapRef, 'parent', {
      get() {
        if (resolveDocumentParentCollection === undefined) {
          throw new Error('pyric/firestore: document parent collection resolver not initialized.');
        }
        return resolveDocumentParentCollection(owner, parentCollectionPathOf(path), null);
      },
      configurable: true,
    });
  }
  if (typeof (snapRef as { withConverter?: unknown }).withConverter !== 'function') {
    const id = snapRef.id ?? path.slice(path.lastIndexOf('/') + 1);
    const backing = Object.assign(snapRef, { id, path });
    Object.defineProperty(snapRef, 'withConverter', {
      value: (next: FirestoreDataConverter<unknown, DocumentData> | null) =>
        registerDocumentReferenceValue(backing, path, owner, next),
      configurable: true,
      writable: true,
    });
  }
}
