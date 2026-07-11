---
title: "Public API"
group: "pyric / firestore"
section: "Reference"
order: 83
---
# Public API

`pyric/firestore` re-exports a large surface that mirrors `firebase/firestore`. The lists below group by area; for individual function signatures, the package matches the upstream SDK closely enough that the [official Web SDK reference](https://firebase.google.com/docs/reference/js/firestore_) applies.

## Entry point

### `getFirestore(target): Firestore`

Two overloads:

- `getFirestore(ctx: SandboxContext)`: sandbox backend via `pyric-admin`.
- `getFirestore(app: FirebaseApp)`: prod backend via `firebase/firestore`.

The returned `Firestore` is opaque. It carries the target via `TARGET_SYMBOL` and is consumed only by other functions in this package. See [`getFirestore` overloads](../pyric-firestore-reference-getfirestore/).

### `connectFirestoreEmulator(db, host, port)`

Mirrors the upstream `connectFirestoreEmulator`. No-op on sandbox-backed handles; delegates to `firebase/firestore` on prod-backed handles.

## Reference types
```ts
interface DocumentReference<T = DocumentData> { readonly id: string; readonly path: string; }
interface CollectionReference<T = DocumentData> { readonly id: string; readonly path: string; }
interface Query<T = DocumentData> { readonly _isQuery?: true; }
```
References and queries are backend-opaque. Don't read or mutate their properties beyond `id` and `path`; pass them to free functions instead.

## Snapshot types
```ts
interface DocumentSnapshot<T = DocumentData> {
  readonly id: string;
  readonly exists: () => boolean;
  readonly data: () => T | undefined;
  readonly ref: DocumentReference<T>;
  readonly metadata: SnapshotMetadata;
}

interface QueryDocumentSnapshot<T = DocumentData> extends DocumentSnapshot<T> {
  readonly data: () => T;  // always present
}

interface QuerySnapshot<T = DocumentData> {
  readonly docs: QueryDocumentSnapshot<T>[];
  readonly size: number;
  readonly empty: boolean;
  readonly metadata: SnapshotMetadata;
  forEach(cb: (doc: QueryDocumentSnapshot<T>) => void): void;
  docChanges(opts?: DocChangesOptions): DocumentChange<T>[];
}
```
## Reads

- `getDoc(ref)`
- `getDocs(query)`
- `getCountFromServer(query)`
- `getAggregateFromServer(query, spec)`

## Writes

- `setDoc(ref, data, opts?)`
- `updateDoc(ref, data)`
- `deleteDoc(ref)`
- `addDoc(collectionRef, data)`

## Path construction

- `doc(db, path, ...segments)`
- `doc(ref, path, ...segments)`: relative path under a doc / collection
- `collection(parent, path, ...segments)`
- `collectionGroup(db, collectionId)`

## Queries

Build a query by composing constraints:
```ts
query(
  collection(db, 'notes'),
  where('ownerId', '==', 'alice'),
  where('archived', '==', false),
  orderBy('createdAt', 'desc'),
  limit(20),
);
```
Constraint constructors:

- `where(field, op, value)`
- `or(...filters)`, `and(...filters)`
- `orderBy(field, dir?)`
- `limit(n)`, `limitToLast(n)`
- `startAt(...)`, `startAfter(...)`, `endAt(...)`, `endBefore(...)`

See [Query constraints](../pyric-firestore-reference-query-constraints/).

## Aggregations

- `count()`
- `sum(field)`
- `average(field)`

Pass to `getAggregateFromServer(query, { name: aggregateField })`.

## Listeners

- `onSnapshot(refOrQuery, ...)`: same four-overload-group shape as `firebase/firestore`.

Returns an `Unsubscribe` (`() => void`).

## Batches and transactions

- `writeBatch(db)`: returns a `WriteBatch`.
- `runTransaction(db, async (tx) => { ... })`.

## Equality helpers

- `refEqual(a, b)`: compare two `DocumentReference`s.
- `queryEqual(a, b)`: compare two `Query`s.
- `snapshotEqual(a, b)`: compare two `DocumentSnapshot`s or `QuerySnapshot`s.

## Sentinels
```ts
import {
  FieldValue,
  Timestamp,
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
  deleteField,
} from 'pyric/firestore';
```
The factory functions (`serverTimestamp()`, `increment(n)`, etc.) match `firebase/firestore`. `FieldValue` and `Timestamp` are also exported as classes for code that prefers the class form.

## Converters
```ts
withConverter(parent, converter)
```
Mirrors `firebase/firestore`'s `withConverter`. Apply to a `DocumentReference`, `CollectionReference`, or `Query`; the returned reference carries the converter through subsequent reads and writes.

## Sandbox-only operations
```ts
sandbox.setRules(db, rules)
sandbox.seedDocuments(db, documents)
sandbox.snapshotState(db)
```
Only callable against a sandbox-backed `Firestore`. Throws `SandboxError('failed-precondition')` if called against a prod-backed handle.

See [Sandbox-only operations](../pyric-firestore-reference-sandbox-ops/).

## Re-exported from `pyric/sandbox`

- `AuthState`, `Sandbox`, `SandboxContext`.
- `SandboxError`.

## Tool factories

- `createFirestoreDataTools(deps): ToolHandler[]`: wraps reads and writes as agent tools.
- `FirestoreDataToolDeps`: `{ resolveDb }` resolver.
- `UserAuth`: `{ uid, claims? }` shape the tool layer accepts.

See [Tool factories](../pyric-firestore-reference-tool-factories/).
