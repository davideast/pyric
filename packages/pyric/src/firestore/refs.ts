/**
 * `pyric/firestore` — reference / query path constructors + `withConverter`.
 *
 * `doc` / `collection` / `collectionGroup` build tagged sandbox refs;
 * `withConverter` attaches (or strips) a data converter, returning
 * a fresh typed view that carries forward through the chain factories.
 */
import type { DocumentData } from 'pyric/sandbox/admin-firestore';

import {
  TARGET_SYMBOL,
  targetOf,
  sandboxDb,
  tagSandboxRef,
  converterOf,
  underlyingOf,
  buildSandboxShell,
  asChainColl,
  asChainDoc,
  type Target,
} from './state.js';
import { DocumentReference } from './types.js';
import type {
  Firestore,
  CollectionReference,
  Query,
  FirestoreDataConverter,
} from './types.js';
import {
  boundedActivityIdentity,
  registerActivityValue,
} from './sandbox/activity-value-registry.js';
import {
  registerReferenceQueryValue,
  copyQueryValueRegistration,
} from './sandbox/query-value-registry.js';
import { attachConverterMethod, convertedView } from './converter-method.js';

function registerDocumentValue<T extends { id: string; path: string }>(
  ref: T,
  path: string,
  owner: Target,
  converter: FirestoreDataConverter<unknown> | null = null,
) {
  function convert<A, D extends DocumentData = DocumentData>(converter: FirestoreDataConverter<A, D>): DocumentReference<A>;
  function convert(converter: null): DocumentReference<DocumentData>;
  function convert(converter: FirestoreDataConverter<unknown> | null): DocumentReference<unknown> {
    const removesConverter = converter === null;
    if (removesConverter) return withConverter(reference, null);
    return withConverter(reference, converter);
  }
  // Modular methods must live outside the Admin error-translation proxy.
  const underlying = underlyingOf(ref) as { id?: string; path?: string };
  const shell = buildSandboxShell(underlying, owner, converter);
  const reference = Object.assign(shell, { withConverter: convert });
  registerActivityValue(reference, boundedActivityIdentity('reference', path));
  registerReferenceQueryValue(underlying, path, owner);
  copyQueryValueRegistration(underlying, reference);
  return reference;
}

// ─── Path constructors ────────────────────────────────────────────────

export function doc<T = DocumentData>(
  parent: Firestore | CollectionReference<T>,
  ...pathSegments: string[]
): DocumentReference<T> {
  const target = targetOf(parent);
  const isHandle = TARGET_SYMBOL in parent;
  // Propagate any converter from a typed collection to the resulting
  // doc — `doc(coll<User>, 'u1')` returns `DocumentReference<User>`.
  const conv = isHandle ? undefined : converterOf(parent);
  const db = sandboxDb(target);
  if (isHandle) {
    const hasNoPath = pathSegments.length === 0;
    if (hasNoPath) {
      throw new TypeError('doc(db, path) requires at least one path segment.');
    }
    const path = pathSegments.join('/');
    const built = db.doc(path);
    const tagged = tagSandboxRef(
      built,
      target,
      (fresh) => fresh.doc(path),
    );
    return registerDocumentValue(tagged, path, target) as DocumentReference<T>;
  }
  const coll = asChainColl(underlyingOf(parent));
  const createsId = pathSegments.length === 0;
  let ref;
  if (createsId) ref = coll.doc();
  else ref = coll.doc(pathSegments.join('/'));
  const absPath = ref.path;
  const tagged = tagSandboxRef(
    ref,
    target,
    (fresh) => fresh.doc(absPath),
  );
  const hasConverter = conv !== undefined && conv !== null;
  if (hasConverter) {
    return registerDocumentValue(tagged, absPath, target, conv) as DocumentReference<T>;
  }
  return registerDocumentValue(tagged, absPath, target) as DocumentReference<T>;
}

/**
 * Cross-collection query — scans every document under every
 * collection whose final segment matches `collectionId`. Mirrors
 * `firebase/firestore`'s `collectionGroup(db, id)` shape.
 *
 * Returned `Query` accepts the same `where` / `orderBy` / `limit`
 * constraints as any other query.
 */
export function collectionGroup(db: Firestore, collectionId: string): Query {
  const target = targetOf(db);
  const q = attachConverterMethod(sandboxDb(target).collectionGroup(collectionId));
  return tagSandboxRef(
    q as unknown as Query,
    target,
    (fresh) => fresh.collectionGroup(collectionId) as unknown as object,
  );
}

export function collection(parent: Firestore | DocumentReference, ...pathSegments: string[]): CollectionReference {
  const target = targetOf(parent);
  const isHandle = TARGET_SYMBOL in parent;
  if (pathSegments.length === 0) {
    throw new TypeError('collection() requires at least one path segment.');
  }
  // Note: any converter on `parent` (typed DocumentReference<T>) does
  // NOT propagate to the sub-collection — matches `firebase/firestore`'s
  // `collection(typedDoc, path)` returning `CollectionReference<DocumentData>`.
  // A parent doc's T describes its own data, not its subcollections'.
  if (isHandle) {
    const path = pathSegments.join('/');
    const built = attachConverterMethod(sandboxDb(target).collection(path));
    return tagSandboxRef(
      built as unknown as CollectionReference,
      target,
      (fresh) => fresh.collection(path) as unknown as object,
    );
  }
  const docRef = asChainDoc(underlyingOf(parent));
  const subPath = pathSegments.join('/');
  const built = attachConverterMethod(docRef.collection(subPath));
  const absPath = (built as { path: string }).path;
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
    return registerDocumentValue(underlying, underlying.path, target, converter);
  }
  return convertedView(source, converter);
}
