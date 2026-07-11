---
title: "onSnapshot overloads"
group: "pyric-admin / firestore"
section: "Reference"
order: 176
---
# `onSnapshot` overloads

The Web-SDK-shaped streaming surface. Four overload groups mirror `firebase/firestore`'s `onSnapshot` exactly, so existing call sites copied from production code typecheck unchanged.

## Why Web-shaped, not Admin-shaped

The Firebase Admin SDK's `onSnapshot` lives on the reference (`db.doc('x').onSnapshot(...)`), takes positional `(onNext, onError)`, and produces admin-shaped snapshot types. The Web SDK's `onSnapshot` is a standalone function (`onSnapshot(ref, observer)`), takes either positional or observer-shaped arguments, and produces a different snapshot type with `metadata`.

`pyric-admin` exposes the Web-SDK form for two reasons:

- React, Vue, and Svelte UI code copied from production looks identical.
- The Web-SDK observer form (`{ next, error, complete }`) is convenient for tests.

The reference-method form (`ref.onSnapshot(...)`) is also available because the underlying Firestore reference still carries that method.

## Document overloads
```ts
// (observer)
onSnapshot(ref: DocumentReference, observer: SnapshotObserver<DocumentSnapshot>): Unsubscribe;
onSnapshot(ref: DocumentReference, options: SnapshotListenOptions, observer: SnapshotObserver<DocumentSnapshot>): Unsubscribe;

// (onNext, onError?)
onSnapshot(ref: DocumentReference, onNext: (snap: DocumentSnapshot) => void, onError?: (error: unknown) => void): Unsubscribe;
onSnapshot(ref: DocumentReference, options: SnapshotListenOptions, onNext: (snap: DocumentSnapshot) => void, onError?: (error: unknown) => void): Unsubscribe;
```
## Query overloads

Same four shapes against `Query`:
```ts
onSnapshot(query: Query, observer: SnapshotObserver<QuerySnapshot>): Unsubscribe;
onSnapshot(query: Query, options: SnapshotListenOptions, observer: SnapshotObserver<QuerySnapshot>): Unsubscribe;
onSnapshot(query: Query, onNext: (snap: QuerySnapshot) => void, onError?: (error: unknown) => void): Unsubscribe;
onSnapshot(query: Query, options: SnapshotListenOptions, onNext: (snap: QuerySnapshot) => void, onError?: (error: unknown) => void): Unsubscribe;
```
## `SnapshotListenOptions`
```ts
interface SnapshotListenOptions {
  includeMetadataChanges?: boolean;
}
```
Accepted for shape parity. `includeMetadataChanges` has no observable effect in the sandbox (there's no offline cache and no pending-writes window), so `metadata.fromCache` and `metadata.hasPendingWrites` are always `false`.

## What `Unsubscribe` does

Calling the returned function deregisters the listener and stops further callback invocations. Idempotent: calling it twice is a no-op.

Always unsubscribe before discarding a listener, especially in React `useEffect` cleanup. Without it, a new render registers a fresh listener and the old one stays alive (until the sandbox is reset or disposed).

## What fires the `error` callback

The observer's `error` (or the positional `onError`) fires when a snapshot listener is silently terminated by a rule denial, either at initial read or during re-evaluation after a write. Once-per-stream: after `error` fires, no further callbacks happen on that listener.

The sandbox also exposes `sandbox.onSnapshotError(cb)` (from `pyric/sandbox`) which fires for every stream-error across every listener. Use that when you want host-level error handling without each listener registering its own callback.

## What does *not* fire the callbacks

- Network failures: there is no network.
- `unavailable` / `aborted` errors: no transport, no concurrent transactions.
- `complete`: the listener stream has no terminal state.

## Routing

The handler routes by reference type:

| Argument | Target |
|---|---|
| `DocumentReference` | `{ kind: 'doc', path }` |
| `CollectionReference` | `{ kind: 'query', collection: path }` |
| Chained query (`.where`, `.orderBy`, `.limit`) | `{ kind: 'query', collection: rootCollection }` |

Chained queries currently route as whole-collection listeners: the simulator fires for any change in the collection, and the callback receives every document. Filter/order honoring at the listener layer is in a later slice.

## Auth capture at register time

The context's `auth` is captured when `onSnapshot` is called. Subsequent rule evaluations use that auth identity, even if the registering context is later replaced. To listen as a different identity, register a new listener through a different context's handle.
