/**
 * `pyric/firestore` — reference / query path constructors + `withConverter`.
 *
 * `doc` / `collection` / `collectionGroup` build tagged sandbox refs;
 * `withConverter` attaches (or strips) a data converter, returning
 * a fresh typed view that carries forward through the chain factories.
 */
import type { DocumentData } from 'pyric/sandbox/admin-firestore';

import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { toFirestoreFirebaseError } from './errors.js';
import {
  TARGET_SYMBOL,
  refToTarget,
  targetOf,
  sandboxDb,
  tagSandboxRef,
  converterOf,
  underlyingOf,
  asChainColl,
  asChainDoc,
} from './state.js';
import { DocumentReference } from './types.js';
import type {
  Firestore,
  CollectionReference,
  Query,
  FirestoreDataConverter,
} from './types.js';
import {
  attachConverterMethod,
  convertedView,
  registerCollectionParentDocumentResolver,
  registerDocumentParentCollectionResolver,
  registerDocumentReferenceValue,
} from './converter-method.js';

registerDocumentParentCollectionResolver((owner, collectionPath, converter) => {
  const rawColl = collection({ [TARGET_SYMBOL]: owner }, collectionPath);
  if (converter !== null) {
    return rawColl.withConverter(converter);
  }
  return rawColl;
});

registerCollectionParentDocumentResolver((owner, docPath) => {
  return doc({ [TARGET_SYMBOL]: owner }, docPath);
});

// --- Path constructors ---------------------------------------------------

function parsePathSegments(
  fnName: 'doc' | 'collection',
  rawSegments: readonly string[],
): string[] {
  const segments: string[] = [];
  for (const raw of rawSegments) {
    if (typeof raw !== 'string') {
      throw new FirebaseError('invalid-argument', `Function ${fnName}() called with non-string path.`);
    }
    if (raw.includes('//')) {
      throw new FirebaseError(
        'invalid-argument',
        `Invalid path (${raw}). Paths must not contain '//' in them.`,
      );
    }
    const trimmed = raw.replace(/^\/+|\/+$/g, '');
    if (trimmed.length === 0) {
      throw new FirebaseError('invalid-argument', `Invalid path (${raw}). Paths must not be empty.`);
    }
    segments.push(...trimmed.split('/'));
  }
  return segments;
}

function assertObjectParent(fnName: string, candidate: unknown): asserts candidate is object {
  if (candidate === null || typeof candidate !== 'object') {
    throw new FirebaseError(
      'invalid-argument',
      `Expected first argument to ${fnName}() to be a Firestore, a CollectionReference or a DocumentReference`,
    );
  }
}

export function doc(
  parent: DocumentReference<unknown>,
  path: string,
  ...pathSegments: string[]
): DocumentReference<DocumentData>;
export function doc<T = DocumentData>(
  parent: Firestore | CollectionReference<T> | DocumentReference<unknown>,
  ...pathSegments: string[]
): DocumentReference<T>;
export function doc<T = DocumentData>(
  parent: Firestore | CollectionReference<T> | DocumentReference<unknown>,
  ...pathSegments: string[]
): DocumentReference<T> {
  assertObjectParent('doc', parent);
  const isHandle = TARGET_SYMBOL in parent;
  if (isHandle) {
    const target = targetOf(parent);
    if (pathSegments.length === 0) {
      throw new FirebaseError(
        'invalid-argument',
        'Function doc() cannot be called with an empty path.',
      );
    }
    const segments = parsePathSegments('doc', pathSegments);
    if (segments.length % 2 !== 0) {
      throw new FirebaseError(
        'invalid-argument',
        `Invalid document reference. Document references must have an even number of segments, but ${segments.join('/')} has ${segments.length}.`,
      );
    }
    const path = segments.join('/');
    const built = sandboxDb(target).doc(path);
    const tagged = tagSandboxRef(
      built,
      target,
      (fresh) => fresh.doc(path),
    );
    return registerDocumentReferenceValue<T>(tagged, path, target);
  }
  const refKind = (parent as { type?: unknown }).type;
  if (!refToTarget.has(parent) || (refKind !== 'collection' && refKind !== 'document')) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected first argument to doc() to be a Firestore, a CollectionReference or a DocumentReference',
    );
  }
  const target = targetOf(parent);
  if (refKind === 'document') {
    if (pathSegments.length === 0) {
      throw new FirebaseError(
        'invalid-argument',
        'Function doc() cannot be called with an empty path.',
      );
    }
    const baseDoc = asChainDoc(underlyingOf(parent));
    const relSegments = parsePathSegments('doc', pathSegments);
    const allSegments = [...baseDoc.path.split('/'), ...relSegments];
    if (allSegments.length % 2 !== 0) {
      throw new FirebaseError(
        'invalid-argument',
        `Invalid document reference. Document references must have an even number of segments, but ${allSegments.join('/')} has ${allSegments.length}.`,
      );
    }
    const absPath = allSegments.join('/');
    const built = sandboxDb(target).doc(absPath);
    const tagged = tagSandboxRef(
      built,
      target,
      (fresh) => fresh.doc(absPath),
    );
    return registerDocumentReferenceValue<T>(tagged, absPath, target);
  }
  const conv = converterOf(parent);
  const coll = asChainColl(underlyingOf(parent));
  let ref;
  if (pathSegments.length === 0) {
    ref = coll.doc();
  } else {
    const relSegments = parsePathSegments('doc', pathSegments);
    const allSegments = [...coll.path.split('/'), ...relSegments];
    if (allSegments.length % 2 !== 0) {
      throw new FirebaseError(
        'invalid-argument',
        `Invalid document reference. Document references must have an even number of segments, but ${allSegments.join('/')} has ${allSegments.length}.`,
      );
    }
    ref = coll.doc(relSegments.join('/'));
  }
  const absPath = ref.path;
  const tagged = tagSandboxRef(
    ref,
    target,
    (fresh) => fresh.doc(absPath),
  );
  if (conv !== undefined && conv !== null) {
    return registerDocumentReferenceValue<T>(tagged, absPath, target, conv);
  }
  return registerDocumentReferenceValue<T>(tagged, absPath, target);
}

/**
 * Cross-collection query -- scans every document under every
 * collection whose final segment matches `collectionId`. Mirrors
 * `firebase/firestore`'s `collectionGroup(db, id)` shape.
 *
 * Returned `Query` accepts the same `where` / `orderBy` / `limit`
 * constraints as any other query.
 */
export function collectionGroup(db: Firestore, collectionId: string): Query {
  if (db === null || typeof db !== 'object' || !(TARGET_SYMBOL in db)) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected first argument to collectionGroup() to be a Firestore instance.',
    );
  }
  const target = targetOf(db);
  if (typeof collectionId !== 'string' || collectionId.length === 0 || collectionId.includes('/')) {
    throw new FirebaseError(
      'invalid-argument',
      `Invalid collection ID (${String(collectionId)}) passed to function collectionGroup(). Collection IDs must be non-empty strings without '/'.`,
    );
  }
  let rawGroup;
  try {
    rawGroup = sandboxDb(target).collectionGroup(collectionId);
  } catch (err) {
    throw toFirestoreFirebaseError(err);
  }
  const q = attachConverterMethod(rawGroup, 'query');
  return tagSandboxRef(
    q as unknown as Query,
    target,
    (fresh) => fresh.collectionGroup(collectionId) as unknown as object,
  );
}

export function collection(
  parent: Firestore | CollectionReference<unknown> | DocumentReference<unknown>,
  ...pathSegments: string[]
): CollectionReference {
  assertObjectParent('collection', parent);
  const isHandle = TARGET_SYMBOL in parent;
  if (isHandle) {
    const target = targetOf(parent);
    if (pathSegments.length === 0) {
      throw new FirebaseError(
        'invalid-argument',
        'Function collection() cannot be called with an empty path.',
      );
    }
    const segments = parsePathSegments('collection', pathSegments);
    if (segments.length % 2 !== 1) {
      throw new FirebaseError(
        'invalid-argument',
        `Invalid collection reference. Collection references must have an odd number of segments, but ${segments.join('/')} has ${segments.length}.`,
      );
    }
    const path = segments.join('/');
    const built = attachConverterMethod(sandboxDb(target).collection(path), 'collection');
    return tagSandboxRef(
      built as unknown as CollectionReference,
      target,
      (fresh) => fresh.collection(path) as unknown as object,
    );
  }
  const refKind = (parent as { type?: unknown }).type;
  if (!refToTarget.has(parent) || (refKind !== 'document' && refKind !== 'collection')) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected first argument to collection() to be a Firestore, a CollectionReference or a DocumentReference',
    );
  }
  const target = targetOf(parent);
  if (pathSegments.length === 0) {
    throw new FirebaseError(
      'invalid-argument',
      'Function collection() cannot be called with an empty path.',
    );
  }
  const basePath = (underlyingOf(parent) as { path: string }).path;
  const relSegments = parsePathSegments('collection', pathSegments);
  const allSegments = [...basePath.split('/'), ...relSegments];
  if (allSegments.length % 2 !== 1) {
    throw new FirebaseError(
      'invalid-argument',
      `Invalid collection reference. Collection references must have an odd number of segments, but ${allSegments.join('/')} has ${allSegments.length}.`,
    );
  }
  const absPath = allSegments.join('/');
  const built = attachConverterMethod(sandboxDb(target).collection(absPath), 'collection');
  return tagSandboxRef(
    built as unknown as CollectionReference,
    target,
    (fresh) => fresh.collection(absPath) as unknown as object,
  );
}

// ─── withConverter (typed refs / queries) ────────────────────────────
//
// Document references expose the Firebase-shaped method. This free function
// remains available for existing document, collection, and query callers:
//
//   interface UserDb { name: string; createdAt: Timestamp; }
//   interface User    { name: string; createdAt: Date; }
//
//   const userConverter: FirestoreDataConverter<User, UserDb> = {
//     toFirestore: (u) => ({ name: u.name, createdAt: Timestamp.fromDate(u.createdAt) }),
//     fromFirestore: (snap) => {
//       const d = snap.data();
//       return { name: d.name, createdAt: d.createdAt.toDate() };
//     },
//   };
//
//   const users = withConverter(collection(db, 'users'), userConverter);
//   await setDoc(doc(users, 'alice'), { name: 'Alice', createdAt: new Date() });
//   const snap = await getDoc(doc(users, 'alice'));
//   const user: User | undefined = snap.data(); // typed!
//
// Behavior:
//   - The returned ref carries the converter forward through chain
//     factories (`doc(typedColl, id)`, `query(typedColl, ...)`).
//   - `setDoc` / `addDoc` invoke `toFirestore` before the write.
//   - `getDoc` / `getDocs` invoke `fromFirestore` on each result.
//   - `updateDoc` does NOT run the converter (matches JS SDK; partial
//     writes don't have a typed home).
//   - Passing `null` strips an existing converter while retaining a
//     usable untyped reference.

export function withConverter<AppModel, DbModel extends DocumentData = DocumentData>(
  ref: DocumentReference<DocumentData>,
  converter: FirestoreDataConverter<AppModel, DbModel>,
): DocumentReference<AppModel>;
export function withConverter(
  ref: DocumentReference<unknown>,
  converter: null,
): DocumentReference<DocumentData>;
export function withConverter<AppModel, DbModel extends DocumentData = DocumentData>(
  ref: CollectionReference<DocumentData>,
  converter: FirestoreDataConverter<AppModel, DbModel>,
): CollectionReference<AppModel>;
export function withConverter(
  ref: CollectionReference<unknown>,
  converter: null,
): CollectionReference<DocumentData>;
export function withConverter<AppModel, DbModel extends DocumentData = DocumentData>(
  q: Query<DocumentData>,
  converter: FirestoreDataConverter<AppModel, DbModel>,
): Query<AppModel>;
export function withConverter(
  q: Query<unknown>,
  converter: null,
): Query<DocumentData>;
export function withConverter(
  source: object,
  converter: FirestoreDataConverter<unknown, DocumentData> | null,
): object {
  const target = targetOf(source);
  const underlying = underlyingOf(source) as { id?: string; path?: string };
  const isDocument = underlying instanceof DocumentReference;
  if (isDocument) {
    const resolvedPath = underlying.path ?? '';
    return registerDocumentReferenceValue(
      underlying as { id: string; path: string },
      resolvedPath,
      target,
      converter,
    );
  }
  return convertedView(source, converter);
}
