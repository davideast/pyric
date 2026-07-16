---
title: "API reference: pyric/database"
navLabel: "API reference"
group: "pyric / database"
section: "Reference"
order: 16003
---
# API reference: `pyric/database`

Exact signatures of every public export, grouped by purpose. Sandbox-only behavior is called out per function.

> **Experimental.** Realtime Database is not part of Pyric's v1-supported surface (that is auth, Firestore, and rules). The modular functions below are verified sandbox-side by unit probes, and the semantics marked with an oracle observation are pinned to recorded production behavior, but most rows are not yet captured against a live project. See the [compatibility matrix](../pyric-database-compat/) before depending on parity.

`pyric/database` is the canonical sandbox-only mirror of
`firebase/database`. It never imports or dispatches to the production SDK.
Package resolution selects the backend before either module loads: production
keeps `firebase/database`, while Pyric activation maps that canonical import to
this mirror.

Sandbox owner controls live at `pyric/sandbox/database`. RTDB rules authoring
and analysis live at `pyric/rules`. Agent simulation and structure crawling
are provided by the sandbox/CLI tool layer; they are not exports of this
Firebase-shaped package.

---

## Initialization

### `getDatabase(target?)`

```ts
function getDatabase(): Database;
function getDatabase(ctx: SandboxContext): Database;
function getDatabase(sandbox: Sandbox): Database;
function getDatabase(app: FirebaseApp): Database;
```

Build a sandbox `Database` handle. Three overloads select its identity mode:

- `SandboxContext` (from `sandbox.withAuth(...)`): sandbox-backed with a frozen identity.
- `Sandbox`: sandbox-backed with a live identity. Each operation reads `sandbox.currentUser` at call time, so a `pyric/auth` sign-in flips the next operation's `request.auth` without re-binding.
- `FirebaseApp`: resolves the app's private sandbox association and app-local Auth session.
- no argument: resolves the registered default app, matching `firebase/database`.

A real production `FirebaseApp` or any foreign value throws a
`TypeError` explaining that package resolution owns production selection.

One backend per `Sandbox`: repeat calls for the same sandbox return handles that share data, matching `firebase/database`'s singleton-per-app behavior. The sandbox tree also registers as a persistable service, so `enablePersistence` includes RTDB data in the serialized blob and restores it on reload.

### `getAdminDatabase(target)`

```ts
function getAdminDatabase(sandbox: Sandbox): Database;
function getAdminDatabase(ctx: SandboxContext): Database;
function getAdminDatabase(app: FirebaseApp): Database;
```

Rules-bypass handle for sandbox setup and inspection, the RTDB counterpart of
`getAdminFirestore`. Reads and writes through it skip rule evaluation. Foreign
or non-sandbox app values throw a `TypeError`.

### `connectDatabaseEmulator(db, host, port, options?)`

```ts
function connectDatabaseEmulator(
  db: Database,
  host: string,
  port: number,
  options?: { mockUserToken?: string | EmulatorMockTokenOptions },
): void;
```

Accepted as a no-op because the selected backend already runs in-process.

### `TARGET_SYMBOL`

```ts
const TARGET_SYMBOL: unique symbol;
```

The hidden brand on every `Database` handle that routes each free function to its backend. Exported so advanced callers can detect a Pyric handle; there is no reason to read it in application code.

---

## Refs, reads, and writes

### `ref(db, path?)`

```ts
function ref(db: Database, path?: string): DatabaseReference;
```

Build a `DatabaseReference` at `path` (default root). Leading and trailing slashes are stripped; an empty path or `'/'` is the root. Refs carry their routing internally, so every function below accepts a ref without the `db` handle.

### `child(parent, path)`

```ts
function child(parent: DatabaseReference, path: string): DatabaseReference;
```

Ref at `<parent>/<path>`. Empty segments are stripped; the result inherits the parent's target.

### `get(refOrQuery)`

```ts
function get(r: DatabaseReference | Query): Promise<DataSnapshot>;
```

One-shot read. An absent path resolves to a snapshot where `val()` is `null` and `exists()` is `false`. Passing a `Query` returns the ordered, windowed result.

Sandbox reads run through the rule engine. A denial throws a plain `Error` (not a `FirebaseError`) with `code === 'PERMISSION_DENIED'` and message `'PERMISSION_DENIED: Permission denied'`, the exact shape recorded from production (oracle `rtdb-rules-denied-error-code.json`).

### `set(ref, value)`

```ts
function set(r: DatabaseReference, value: unknown): Promise<void>;
```

Replace the value at the ref's path. `set(ref, null)` deletes, the RTDB invariant (oracle `rtdb-remove-vs-set-null.json`). `serverTimestamp()` and `increment()` sentinels resolve at write time.

### `update(ref, values)`

```ts
function update(r: DatabaseReference, values: Record<string, unknown>): Promise<void>;
```

Partial update with two modes, decided by the keys:

- Keys containing `/` make it a multi-path atomic update: every listed path is written as one transaction, and any denial fails the whole batch.
- Plain keys make it a shallow merge at the ref's path: each top-level key replaces the corresponding child, and `null` values delete.

### `remove(ref)`

```ts
function remove(r: DatabaseReference): Promise<void>;
```

Delete the subtree at the ref's path. Dispatches through the same path as `set(ref, null)`.

### `push(ref, value?)`

```ts
function push(r: DatabaseReference, value?: unknown): ThenableReference;
```

Mint an auto-id child key under the ref's path, optionally writing `value` there. The key is minted client-side: the returned ref and its `.key` are available synchronously, even when the optional write is later denied by rules (the denial rejects the thenable's promise instead of throwing). Keys are 20 characters, start with `-`, and sort lexicographically by creation time (oracle `rtdb-push-autoid-format.json`).

### `pushKey()`

```ts
function pushKey(): string;
```

Pre-mint a push key without writing. Useful when a multi-path `update` needs the key up front:

```ts
const key = pushKey();
await update(ref(db), { [`/users/${key}/name`]: 'Alice', [`/index/${key}`]: true });
```

---

## Listeners

All subscribe functions return an `Unsubscribe` (`() => void`). Calling it twice is a no-op. A listener callback that throws is swallowed, matching `firebase/database`, so one observer's exception never blocks others.

### `onValue(refOrQuery, cb, options?)`

```ts
function onValue(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot) => void,
  options?: { onlyOnce?: boolean },
): Unsubscribe;
```

Fires immediately on subscribe with the current value (`null` and `exists: false` for an absent path), then on every write touching the path or a descendant. With `onlyOnce: true` the listener auto-unsubscribes after its first fire.

On a `Query`, the listener fires only when the windowed result changes: a write outside the window does not re-fire it, a write inside or one that displaces a member does (oracle `rtdb-modular-onvalue-with-query.json`).

Subscribing under rules that deny the read throws the `PERMISSION_DENIED` plain-`Error` shape synchronously.

### `onChildAdded(refOrQuery, cb)`

```ts
function onChildAdded(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```

On subscribe, replays every existing direct child (one fire per key). After that, fires exactly once per new direct child. On a `Query`, a child entering the window fires, and the current window is replayed in window order on subscribe.

### `onChildChanged(refOrQuery, cb)`

```ts
function onChildChanged(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```

No initial replay. Fires when an existing direct child transitions to a new non-null value; the snapshot carries the new value. Does not fire for added or removed children.

### `onChildRemoved(refOrQuery, cb)`

```ts
function onChildRemoved(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```

No initial replay. Fires when a direct child is deleted (`remove(child)` or `set(child, null)`); the snapshot carries the prior, now-removed value. On a `Query`, a child leaving the window (displaced past a `limitTo*` boundary, or filtered out) also fires with its prior value.

### `onChildMoved(refOrQuery, cb)`

```ts
function onChildMoved(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```

Only meaningful under an ordered query; under a plain ref the subscription is accepted but never fires, matching the upstream SDK. **Sandbox divergence:** the sandbox accepts the subscription on a query but does not yet fire on reorders, while production does. The reorder and `previousChildName` semantics are held pending fresh oracle captures. This is a documented, pinned divergence.

### `off(ref, eventType?, callback?)`

```ts
function off(
  r: DatabaseReference,
  eventType?: 'value' | 'child_added' | 'child_changed' | 'child_removed' | 'child_moved',
  callback?: (snap: DataSnapshot) => void,
): void;
```

Unsubscribe variant (oracle `rtdb-modular-off-stops-child-fires.json`):

- `off(ref)` removes all listeners at the ref, value and every child variety.
- `off(ref, eventType)` removes only that variety.
- `off(ref, eventType, cb)` removes only the matching callback; an unregistered callback is a silent no-op.

The unsubscribe function returned by `onValue` / `onChild*` is equivalent to the three-argument form for that registration. Both work.

---

## Transactions and write sentinels

### `runTransaction(ref, transactionUpdate, options?)`

```ts
function runTransaction<T>(
  r: DatabaseReference,
  transactionUpdate: (current: T | null) => T | undefined,
  options?: { applyLocally?: boolean },
): Promise<TransactionResult>;
```

Atomic read-modify-write. The oracle-locked contract:

1. `transactionUpdate` receives the current value; an absent path passes `null`, not `undefined`.
2. Returning `undefined` aborts: resolves `{ committed: false, snapshot }` where the snapshot is the pre-transaction value.
3. Returning a defined value writes it (rules-checked): resolves `{ committed: true, snapshot }` with the committed value.
4. A rules denial rejects with a plain `Error` whose message is `'permission_denied'` (lowercase) and no `.code` field. This is deliberately different from `set`/`get`'s denial shape; production behaves this way (oracle `rtdb-modular-runtransaction-on-rules-denied-path.json`).

`options.applyLocally` (default `true`): when `false`, listeners skip the optimistic intermediate value and see only the committed one. The single-client sandbox has no other writer to conflict with, so the update function runs once; the documented retry-on-conflict path never engages.

### `serverTimestamp()`

```ts
function serverTimestamp(): ServerTimestampSentinel;
```

Returns the `{ '.sv': 'timestamp' }` sentinel. Resolves to epoch milliseconds (a number) at write time on both targets (oracle `rtdb-servertimestamp-resolves.json`). The sentinel type itself is not exported; treat the return value as opaque.

### `increment(delta)`

```ts
function increment(delta: number): IncrementSentinel;
```

Returns the `{ '.sv': { increment: delta } }` sentinel that atomically adds `delta` to the value at the written field. Starts from `0` when the field is absent or non-numeric (oracle `rtdb-modular-increment-from-missing.json`).

---

## Query builder

### `query(refOrQuery, ...constraints)`

```ts
function query(refOrQuery: DatabaseReference | Query, ...constraints: QueryConstraint[]): Query;
```

Wrap a ref in an immutable constraint chain, then pass the result to `get`, `onValue`, or the `onChild*` listeners. Chaining folds: `query(query(ref, orderByChild('x')), limitToFirst(2))` merges both constraints into one spec.

### Ordering constraints

```ts
function orderByChild(path: string): QueryConstraint;
function orderByKey(): QueryConstraint;
function orderByValue(): QueryConstraint;
```

- `orderByChild(path)` orders children by the value at a nested child path (oracle `rtdb-modular-orderbychild-window.json`).
- `orderByKey()` orders lexicographically by key string (oracle `rtdb-modular-orderbykey-window.json`).
- `orderByValue()` orders by primitive value. Production requires `.indexOn: ".value"` and throws `Index not defined` without it; the sandbox does not enforce indexes (oracle `rtdb-modular-orderbyvalue-numeric.json`).

### Bound constraints

```ts
function startAt(value: JsonValue, key?: string): QueryConstraint;
function startAfter(value: JsonValue, key?: string): QueryConstraint;
function endAt(value: JsonValue, key?: string): QueryConstraint;
function endBefore(value: JsonValue, key?: string): QueryConstraint;
function equalTo(value: JsonValue, key?: string): QueryConstraint;
```

`startAt` and `endAt` are inclusive; `startAfter` and `endBefore` are exclusive (oracle `rtdb-modular-startafter-endbefore-exclusive.json`). The optional `key` breaks ties when ordering by child or value and several children share the bound's value. `equalTo(v, key?)` is sugar for `startAt(v, key)` plus `endAt(v, key)` and returns all matching children, with no uniqueness assumption (oracle `rtdb-modular-equalTo-filter.json`).

### Limit constraints

```ts
function limitToFirst(n: number): QueryConstraint;
function limitToLast(n: number): QueryConstraint;
```

Keep the first or last `n` children of the ordered window (oracle `rtdb-modular-limittofirst-vs-limittolast.json`).

### `QUERY_SYMBOL`

```ts
const QUERY_SYMBOL: unique symbol;
```

The brand on every `Query`, used internally to dispatch `get` / `onValue` between plain refs and query-wrapped refs. Exported for detection; not needed in application code.

---

## The sandbox namespace

Sandbox lifecycle operations retained as mirror extensions for compatibility.
Prefer the owner-oriented `pyric/sandbox/database` entry for new code.

```ts
const sandbox: {
  setRules(db: Database, rulesJson: { rules: Record<string, unknown> } | null): void;
  setData(db: Database, data: Record<string, unknown>): void;
  snapshotState(db: Database): JsonValue;
};
```

- `setRules(db, rulesJson)` replaces the deployed rules. Pass `null` to clear; the sandbox returns to default-allow. Rules evaluate through the same simulator engine that backs `simulate()` and the `rtdb_simulate_access` tool.
- `setData(db, data)` bulk-loads fixtures bypassing rules. Keys are absolute paths (`'/users/alice'`); values land at those paths.
- `snapshotState(db)` reads the full tree bypassing rules. Usually a keyed object; a primitive when the root holds one.

---
## Connection compatibility helpers

These Firebase-shaped calls are accepted by the in-process mirror:

```ts
function goOffline(db: Database): void;
function goOnline(db: Database): void;
function forceLongPolling(): void;
function forceWebSockets(): void;
function enableLogging(
  logger?: boolean | ((message: string) => void),
  persistent?: boolean,
): void;
function refFromURL(db: Database, url: string): DatabaseReference;
```

The connection and transport controls are no-ops because the sandbox has no
network connection to configure. `refFromURL` parses the URL locally and
returns a reference owned by the supplied sandbox database.

---

## Types

| Type | Shape |
|---|---|
| `Database` | Opaque sandbox handle branded with `TARGET_SYMBOL`. |
| `DatabaseReference` | `key`, `parent`, `root`, `toString()`, and the owning sandbox path. |
| `DataSnapshot` | `key`, `ref`, `size`, `priority`, `exists()`, `val()`, `child()`, `hasChild()`, `hasChildren()`, `exportVal()`, `toJSON()`, and `forEach()`. |
| `TransactionResult` | `{ committed: boolean, snapshot: DataSnapshot }`. |
| `ThenableReference` | A `DatabaseReference` with `then` and `catch`; returned by `push`. |
| `Query` | A reference plus an immutable constraint chain, branded with `QUERY_SYMBOL`. |
| `QueryConstraint` | Opaque ordering, bound, or limit constraint. |
| `Unsubscribe` | `() => void`. |
| `Sandbox`, `SandboxContext`, `AuthState`, `JsonValue` | Sandbox convenience types re-exported by the mirror. |

---

## Boundaries

- **The whole service is experimental.** Sandbox behavior is verified by unit
  probes; only semantics with an oracle citation are pinned to recorded
  production behavior. See the [compatibility matrix](../pyric-database-compat/).
- Production selection happens at package resolution. Direct
  `pyric/database` calls reject real Firebase apps and foreign references.
- `onChildMoved` registers but does not yet fire on reorder.
- The sandbox does not enforce `.indexOn`.
- Priority is not modeled: `DataSnapshot.priority` is always `null`.
- Sandbox transactions run the update function once because there is no
  concurrent writer.
- `connectDatabaseEmulator`, connection-state calls, transport selection,
  and logging configuration are accepted no-ops.
- Owner setup and inspection should use `pyric/sandbox/database`.
- Rules authoring and local analysis should use `pyric/rules`; agent
  simulation and crawling belong to the sandbox/CLI tool layer.

For the RTDB rules workflow, see
[rules-tooling.md](../pyric-database-reference-rules-tooling/). For row-by-row Firebase compatibility,
see the [compatibility matrix](../pyric-database-compat/).
