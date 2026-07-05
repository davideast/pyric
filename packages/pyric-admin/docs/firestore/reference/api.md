# Public API

Every symbol re-exported from `pyric-admin`.

## Entry point

### `getFirestore(ctx: SandboxContext): SandboxFirestore`

Resolve the Firestore service handle for a `SandboxContext`. Idempotent — subsequent calls with the same context return the same wrapper, cached in a `WeakMap`.

Requires a `SandboxContext`, not a bare `Sandbox`. For anonymous, pass `sandbox.withAuth(null)` explicitly.

### `onSnapshot(refOrQuery, observerOrNext, errorOrOptions?, options?): Unsubscribe`

Web-SDK-shaped streaming reads. Four overload groups mirror `firebase/firestore`'s `onSnapshot`. See [`onSnapshot` overloads](./onsnapshot.md).

## Types

### `SandboxFirestore extends Firestore`

The handle returned from `getFirestore`. Adds three sandbox-only methods:

- `setRules(rules: string): LintResult`
- `seed(options?: { documents?: Record<string, DocumentData> }): LintResult`
- `snapshot(): Record<string, DocumentData>`

See [`SandboxFirestore` surface](./sandbox-firestore.md).

### `SnapshotObserver<T>`

```ts
interface SnapshotObserver<T> {
  next?: (snapshot: T) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
}
```

Mirrors `firebase/firestore`'s `PartialObserver<T>`. `complete` is accepted for shape parity but never fires — the local listener stream has no terminal state.

### `SnapshotListenOptions`

Type alias for `SnapshotListenerOptions`. Mirrors `firebase/firestore`'s shape; `includeMetadataChanges` is accepted but has no observable effect (no offline cache, no pending-writes window in the sandbox).

### `Unsubscribe`

`() => void`. Returned by `onSnapshot`. Idempotent.

## Re-exported from `pyric/sandbox`

- `AuthState`, `Sandbox`, `SandboxContext` — foundation types.
- `SandboxError` — typed error family.

See the [`pyric/sandbox` API reference](../../../sandbox/docs/reference/api.md).

## Re-exported from `pyric/sandbox/admin-firestore`

The production-shaped Firestore types:

- `Firestore`, `CollectionReference`, `DocumentReference`, `Query`
- `Transaction`, `WriteBatch`
- `DocumentData`, `SetOptions`, `OperationOptions`, `WhereFilterOp`, `OrderDirection`
- `Filter`
- `AggregateField`, `AggregateQuerySnapshot`, `AggregateSpec`
- `LintResult`, `LintWarning`, `RulesMetrics`
- `FieldValueSentinel`
- Admin-shaped snapshot types (`AdminDocumentSnapshot`, `AdminQuerySnapshot`, `AdminQueryDocumentSnapshot`)
- Web-SDK-shaped snapshot types (`DocumentSnapshot`, `QuerySnapshot`, `QueryDocumentSnapshot`, `DocumentChange`, `DocumentChangeType`, `DocChangesOptions`, `SnapshotMetadata`)

### Values

- `FieldValue` — `serverTimestamp`, `increment`, `arrayUnion`, `arrayRemove`, `delete`.
- `Timestamp` — wrapper class for Firestore timestamps.

See [Re-exported types](./re-exported-types.md) for why the admin shape and the Web shape both appear here.
