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
} from './state.js';
import type {
  Firestore,
  DocumentReference,
  CollectionReference,
  Query,
  FirestoreDataConverter,
} from './types.js';
import {
  boundedActivityIdentity,
  registerActivityValue,
} from './sandbox/activity-value-registry.js';
import { registerQueryValue } from './sandbox/query-value-registry.js';

function registerDocumentValue<T extends object>(ref: T, path: string): T {
  registerActivityValue(ref, boundedActivityIdentity('reference', path));
  registerQueryValue(ref, Object.freeze({ type: 'reference', path }));
  return ref;
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
    if (pathSegments.length === 0) {
      throw new TypeError('doc(db, path) requires at least one path segment.');
    }
    const path = pathSegments.join('/');
    const built = db.doc(path);
    const tagged = tagSandboxRef(
      built as object,
      target,
      (fresh) => fresh.doc(path) as unknown as object,
    );
    return registerDocumentValue(tagged, path) as DocumentReference<T>;
  }
  const coll = asChainColl(underlyingOf(parent));
  const ref = pathSegments.length === 0
    ? coll.doc()
    : coll.doc(pathSegments.join('/'));
  const absPath = (ref as { path: string }).path;
  const tagged = tagSandboxRef(
    ref as object,
    target,
    (fresh) => fresh.doc(absPath) as unknown as object,
  );
  if (conv) {
    const shell = buildSandboxShell(
      tagged as { id: string; path: string },
      target,
      conv,
    );
    return registerDocumentValue(shell, absPath) as DocumentReference<T>;
  }
  return registerDocumentValue(tagged, absPath) as DocumentReference<T>;
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
  const q = sandboxDb(target).collectionGroup(collectionId);
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
    const built = sandboxDb(target).collection(path);
    return tagSandboxRef(
      built as CollectionReference,
      target,
      (fresh) => fresh.collection(path) as unknown as object,
    );
  }
  const docRef = asChainDoc(underlyingOf(parent));
  const subPath = pathSegments.join('/');
  const built = docRef.collection(subPath);
  const absPath = (built as { path: string }).path;
  return tagSandboxRef(
    built as CollectionReference,
    target,
    (fresh) => fresh.collection(absPath) as unknown as object,
  );
}

// ─── withConverter (typed refs / queries) ────────────────────────────
//
// Modular Web-SDK shape (the JS SDK exposes it as a method on the ref;
// pyric exposes it as a free function for consistency with the rest of
// the surface, where every operation routes through a free call):
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
//   - Passing `null` strips an existing converter, returning the
//     underlying untyped ref.

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
  if (converter === null) {
    // Strip — return the underlying plain ref. Falls back to `source`
    // itself if it was never wrapped (no-op).
    return underlyingOf(source);
  }
  const underlying = underlyingOf(source) as { id?: string; path?: string };
  return buildSandboxShell(underlying, target, converter);
}
