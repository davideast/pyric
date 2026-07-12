/**
 * `pyric/firestore` — reference / query path constructors + `withConverter`.
 *
 * `doc` / `collection` / `collectionGroup` build tagged refs against either
 * backend; `withConverter` attaches (or strips) a data converter, returning
 * a fresh typed view that carries forward through the chain factories.
 */
import * as fb from 'firebase/firestore';
import type { DocumentData } from 'pyric/sandbox/admin-firestore';

import {
  TARGET_SYMBOL,
  targetOf,
  isSandboxKind,
  sandboxDb,
  tag,
  tagSandboxRef,
  converterOf,
  underlyingOf,
  buildSandboxShell,
  asChainColl,
  asChainDoc,
  asFbColl,
  asFbDoc,
} from './state.js';
import type {
  Firestore,
  DocumentReference,
  CollectionReference,
  Query,
  FirestoreDataConverter,
} from './types.js';

// ─── Path constructors ────────────────────────────────────────────────

export function doc<T = DocumentData>(
  parent: Firestore | CollectionReference<T>,
  ...pathSegments: string[]
): DocumentReference<T> {
  const target = targetOf(parent);
  const isHandle = TARGET_SYMBOL in parent;
  // Propagate any converter from a typed collection to the resulting
  // doc — `doc(coll<User>, 'u1')` returns `DocumentReference<User>`.
  // For prod, fb's `.doc()` chain inherits the converter natively, so
  // this only needs to fire on the sandbox side.
  const conv = isHandle ? undefined : converterOf(parent);
  if (isSandboxKind(target)) {
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
      return tagged as DocumentReference<T>;
    }
    const coll = asChainColl(underlyingOf(parent));
    const ref = pathSegments.length === 0
      ? coll.doc()
      : coll.doc(pathSegments.join('/'));
    // The path is now known (either the explicit segments under the
    // parent's path, or the auto-minted id appended). Rebuild from
    // the absolute path so the live ref re-resolves under whatever
    // auth the next op picks up.
    const absPath = (ref as { path: string }).path;
    const tagged = tagSandboxRef(
      ref as object,
      target,
      (fresh) => fresh.doc(absPath) as unknown as object,
    );
    if (conv) {
      return buildSandboxShell(
        tagged as { id: string; path: string },
        target,
        conv,
      ) as DocumentReference<T>;
    }
    return tagged as DocumentReference<T>;
  }
  // prod
  if (isHandle) {
    if (pathSegments.length === 0) {
      throw new TypeError('doc(db, path) requires at least one path segment.');
    }
    return tag(fb.doc(target.db, pathSegments.join('/')) as object, target) as DocumentReference<T>;
  }
  const coll = asFbColl(parent);
  const ref = pathSegments.length === 0
    ? fb.doc(coll)
    : fb.doc(coll, pathSegments.join('/'));
  return tag(ref as object, target) as DocumentReference<T>;
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
  if (isSandboxKind(target)) {
    const q = sandboxDb(target).collectionGroup(collectionId);
    return tagSandboxRef(
      q as unknown as Query,
      target,
      (fresh) => fresh.collectionGroup(collectionId) as unknown as object,
    );
  }
  const q = fb.collectionGroup(target.db, collectionId);
  return tag(q as unknown as Query, target);
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
  if (isSandboxKind(target)) {
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
  // prod
  if (isHandle) {
    return tag(fb.collection(target.db, pathSegments.join('/')) as CollectionReference, target);
  }
  const docRef = asFbDoc(parent);
  return tag(fb.collection(docRef, pathSegments.join('/')) as CollectionReference, target);
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
  if (target.kind === 'prod') {
    // fb's native withConverter is on every ref / query — applies the
    // converter to all subsequent reads / writes through fb's own API.
    const native = (source as fb.DocumentReference | fb.CollectionReference | fb.Query) as {
      withConverter: (
        c: fb.FirestoreDataConverter<unknown, DocumentData> | null,
      ) => fb.DocumentReference | fb.CollectionReference | fb.Query;
    };
    const out = native.withConverter(
      converter as fb.FirestoreDataConverter<unknown, DocumentData> | null,
    );
    return tag(out as object, target);
  }
  // Sandbox.
  if (converter === null) {
    // Strip — return the underlying plain ref. Falls back to `source`
    // itself if it was never wrapped (no-op).
    return underlyingOf(source);
  }
  const underlying = underlyingOf(source) as { id?: string; path?: string };
  return buildSandboxShell(underlying, target, converter);
}
