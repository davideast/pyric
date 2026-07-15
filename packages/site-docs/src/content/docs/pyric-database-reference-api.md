---
title: "API reference: pyric/database"
navLabel: "pyric/database"
group: "API reference"
section: "pyric"
order: 24023
description: "Published declarations for pyric/database."
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/database"
apiSubpath: "database"
apiSymbolCount: 53
apiEvidenceSlug: "pyric-database-compat"
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="database"></a>

### Database

Opaque RTDB handle. Routes via [TARGET\_SYMBOL](#target_symbol-1).

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="target_symbol"></a> `[TARGET_SYMBOL]` | `readonly` | `Target` |
| <a id="app"></a> `app?` | `readonly` | `FirebaseApp` |

***

<a id="databasereference"></a>

### DatabaseReference

RTDB-shaped reference. Backend-opaque to consumers; mirrors
`firebase/database`'s `DatabaseReference` for the subset of methods
the modular SDK uses idiomatically as plain free-function args.

`key` is the last path segment (matches `DatabaseReference.key`).
`null` for the root ref. `parent` is the ref one segment up
(`null` at root). `root` is always the root ref.

`toString()` returns a stable `sandbox://` URL.

#### Extended by

- [`ThenableReference`](#thenablereference)

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="key"></a> `key` | `readonly` | `string` |
| <a id="parent"></a> `parent` | `readonly` | [`DatabaseReference`](#databasereference) |
| <a id="root"></a> `root` | `readonly` | [`DatabaseReference`](#databasereference) |

#### Methods

<a id="tostring"></a>

##### toString()

```ts
toString(): string;
```

###### Returns

`string`

***

<a id="datasnapshot"></a>

### DataSnapshot

Lightweight `DataSnapshot` — matches the subset of
`firebase/database`'s `DataSnapshot` we surface synchronously on a
`get()`. Methods are the load-bearing ones (`val`, `exists`, `key`,
`child`) plus a few utilities consumer code routinely reads.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="key-1"></a> `key` | `readonly` | `string` | - |
| <a id="priority"></a> `priority` | `readonly` | `string` \| `number` | The node's priority, or `null`. The sandbox does not model RTDB's priority (deny-listed — see COMPAT) so this is always `null`, matching the common case (no `.priority` set). Mirrors `api/Reference_impl.ts:312`. |
| <a id="ref"></a> `ref` | `readonly` | [`DatabaseReference`](#databasereference) | The ref the snap was taken from. |
| <a id="size"></a> `size` | `readonly` | `number` | Number of child properties of this snapshot. A getter (NOT a `numChildren()` method — that was the legacy namespaced API). Locked by oracle `rtdb-modular-get-snapshot-shape.json` (`hasSize: true, hasNumChildren: false`) + upstream `api/Reference_impl.ts:331-333`. |

#### Methods

<a id="child"></a>

##### child()

```ts
child(path: string): DataSnapshot;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

[`DataSnapshot`](#datasnapshot)

<a id="exists"></a>

##### exists()

```ts
exists(): boolean;
```

###### Returns

`boolean`

<a id="exportval"></a>

##### exportVal()

```ts
exportVal(): JsonValue;
```

Like `val()` but includes priority info (for backups). With no
priority modeled, this equals `val()`. Mirrors
`api/Reference_impl.ts:374-376`.

###### Returns

[`JsonValue`](#jsonvalue)

<a id="foreach"></a>

##### forEach()

```ts
forEach(cb: (child: DataSnapshot) => boolean | void): boolean;
```

Iterate the snapshot's immediate children. The callback is invoked
with a child `DataSnapshot` for each child; return `true` to stop
iteration early (matches the `firebase/database` contract).

For a snapshot built from a [Query](#query), children are visited in
the order the query's `orderBy*` constraint computed — the windowed
+ filtered + limited sequence. For a plain ref snapshot, children
are visited in key-insertion order (V8 object iteration order; the
RTDB SDK does NOT guarantee an order on plain refs either).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `cb` | (`child`: [`DataSnapshot`](#datasnapshot)) => `boolean` \| `void` |

###### Returns

`boolean`

<a id="haschild"></a>

##### hasChild()

```ts
hasChild(path: string): boolean;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`boolean`

<a id="haschildren"></a>

##### hasChildren()

```ts
hasChildren(): boolean;
```

###### Returns

`boolean`

<a id="tojson"></a>

##### toJSON()

```ts
toJSON(): JsonValue;
```

###### Returns

[`JsonValue`](#jsonvalue)

<a id="val"></a>

##### val()

```ts
val(): JsonValue;
```

###### Returns

[`JsonValue`](#jsonvalue)

***

<a id="query"></a>

### Query

RTDB-shaped Query — a ref + an immutable constraint chain. Mirrors
`firebase/database`'s `Query` for the subset of methods the modular
SDK uses idiomatically.

Construct with [query](#query-1); pass to [get](#get) or [onValue](#onvalue).

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="query_symbol"></a> `[QUERY_SYMBOL]` | `readonly` | `true` | - |
| <a id="ref-1"></a> `ref` | `readonly` | [`DatabaseReference`](#databasereference) | The Query's location. Used by `query()` chaining + listener fan-out. |

#### Methods

<a id="tostring-2"></a>

##### toString()

```ts
toString(): string;
```

Resolves to the same URL the ref would.

###### Returns

`string`

***

<a id="queryconstraint"></a>

### QueryConstraint

Opaque constraint produced by `orderByChild` / `equalTo` / `limitToFirst`
etc. Pass to [query](#query-1).

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="constraint_symbol"></a> `[CONSTRAINT_SYMBOL]` | `readonly` | `Constraint` | - |
| <a id="type"></a> `type` | `readonly` | \| `"orderByChild"` \| `"orderByKey"` \| `"orderByValue"` \| `"startAt"` \| `"startAfter"` \| `"endAt"` \| `"endBefore"` \| `"equalTo"` \| `"limitToFirst"` \| `"limitToLast"` | The constraint's variant — surfaces as the SDK's `QueryConstraintType` strings. |

***

<a id="thenablereference"></a>

### ThenableReference

The return type of [push](#push) — a regular [DatabaseReference](#databasereference)
with `.then` / `.catch` attached so it can be `await`ed. Mirrors
`firebase/database`'s `ThenableReference` (`api/Reference_impl.ts:569`).

Critical (DB-B7): the ref + its `.key` are available SYNCHRONOUSLY —
the key is minted client-side. The promise covers only the optional
value write; a rules-denied write rejects the promise (it does NOT
throw synchronously and lose the key). Oracle:
`rtdb-push-autoid-format.json`.

#### Extends

- [`DatabaseReference`](#databasereference)

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="key-2"></a> `key` | `readonly` | `string` |
| <a id="parent-1"></a> `parent` | `readonly` | [`DatabaseReference`](#databasereference) |
| <a id="root-1"></a> `root` | `readonly` | [`DatabaseReference`](#databasereference) |

#### Methods

<a id="catch"></a>

##### catch()

```ts
catch<TResult>(onrejected?: (reason: unknown) => TResult | PromiseLike<TResult>): Promise<DatabaseReference | TResult>;
```

###### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `TResult` | `never` |

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `onrejected?` | (`reason`: `unknown`) => `TResult` \| `PromiseLike`\<`TResult`\> |

###### Returns

`Promise`\<[`DatabaseReference`](#databasereference) \| `TResult`\>

<a id="then"></a>

##### then()

```ts
then<TResult1, TResult2>(onfulfilled?: (value: DatabaseReference) => TResult1 | PromiseLike<TResult1>, onrejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>): Promise<TResult1 | TResult2>;
```

###### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `TResult1` | [`DatabaseReference`](#databasereference) |
| `TResult2` | `never` |

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `onfulfilled?` | (`value`: [`DatabaseReference`](#databasereference)) => `TResult1` \| `PromiseLike`\<`TResult1`\> |
| `onrejected?` | (`reason`: `unknown`) => `TResult2` \| `PromiseLike`\<`TResult2`\> |

###### Returns

`Promise`\<`TResult1` \| `TResult2`\>

<a id="tostring-4"></a>

##### toString()

```ts
toString(): string;
```

###### Returns

`string`

###### Inherited from

[`DatabaseReference`](#databasereference).[`toString`](#tostring)

***

<a id="transactionresult"></a>

### TransactionResult

Result of [runTransaction](#runtransaction). Matches `firebase/database`'s
`TransactionResult` for the fields agent / playground code reads
idiomatically.

`committed === false` when the update fn aborted by returning
`undefined`. The snapshot still resolves — it reflects the **pre-
transaction** value (oracle:
`rtdb-modular-runtransaction-abort-undefined.json` →
`afterValOnServer: 100` preserved).

On rule denial the promise rejects with a plain `Error` whose
`message === 'permission_denied'` (lowercase, no `.code`); see
`rtdb-modular-runtransaction-on-rules-denied-path.json`.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="committed"></a> `committed` | `readonly` | `boolean` |
| <a id="snapshot"></a> `snapshot` | `readonly` | [`DataSnapshot`](#datasnapshot) |

## Type Aliases

<a id="appdatabase"></a>

### AppDatabase

```ts
type AppDatabase = Database & {
  app: FirebaseApp;
};
```

Database handle returned by Firebase-shaped app overloads.

#### Type Declaration

##### app

```ts
readonly app: FirebaseApp;
```

***

<a id="jsonvalue"></a>

### JsonValue

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
[key: string]: JsonValue;
};
```

RTDB-shaped in-memory JSON tree.

The data layer for the modular SDK's sandbox target. RTDB stores a
single nested JSON tree; reads name a path and walk; writes either
replace a subtree (`set`) or merge top-level keys (`update`).

Path semantics (matches `firebase/database`):
  - `'/'` is the root.
  - Leading + trailing slashes are stripped; empty segments are
    ignored.
  - `null` at any level erases that subtree. Locked by oracle
    observation
    `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` which
    says `set(ref, null)` and `remove(ref)` produce equivalent end
    states.
  - A read of an absent path returns `null` (NOT an error). Matches
    the `DataSnapshot.val()` contract.

Trimming: when a write or delete leaves a sibling-less empty branch,
the empty branch is removed. RTDB's documented invariant: "Empty
nodes don't exist". The crawl + listener layers count on this so
`exists()` and `hasChildren()` match prod.

This module is identity-agnostic — rules evaluation happens in
`local-environment.ts`. The tree just stores bytes.

***

<a id="sandbox"></a>

### Sandbox

```ts
type Sandbox = any;
```

***

<a id="unsubscribe"></a>

### Unsubscribe()

```ts
type Unsubscribe = () => void;
```

#### Returns

`void`

## Variables

<a id="query_symbol-1"></a>

### QUERY\_SYMBOL

```ts
const QUERY_SYMBOL: unique symbol;
```

Hidden brand on every [Query](#query) (and on every QueryConstraint).
Distinct from `TARGET_SYMBOL`; this brand is only used to dispatch
`get` / `onValue` between plain refs and query-wrapped refs.

***

<a id="sandbox-1"></a>

### sandbox

```ts
const sandbox: {
  setData: void;
  setRules: void;
  snapshotState: JsonValue;
};
```

#### Type Declaration

<a id="setdata"></a>

##### setData()

```ts
setData(db: Database, data: Record<string, unknown>): void;
```

Bulk-load data bypassing rules. The supplied map's keys are
absolute paths (`'/users/alice'`) and the values land at those
paths. Convenient for test fixtures.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Database`](#database) |
| `data` | `Record`\<`string`, `unknown`\> |

###### Returns

`void`

<a id="setrules"></a>

##### setRules()

```ts
setRules(db: Database, rulesJson: {
  rules: Record<string, unknown>;
}): void;
```

Replace deployed rules. Pass `null` to clear (sandbox returns to
default-allow). Rules are evaluated through the existing
RTDB rules simulator — the same engine used by the rules tooling.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Database`](#database) |
| `rulesJson` | \{ `rules`: `Record`\<`string`, `unknown`\>; \} |
| `rulesJson.rules` | `Record`\<`string`, `unknown`\> |

###### Returns

`void`

###### Example

```ts
sandbox.setRules(db, {
  rules: {
    '.read': 'auth != null',
    '.write': 'auth != null',
  },
});
```

<a id="snapshotstate"></a>

##### snapshotState()

```ts
snapshotState(db: Database): JsonValue;
```

Snapshot the full sandbox tree (rule-bypass read). Usually a keyed
 object; may be a primitive when the root holds one (DB-B13).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Database`](#database) |

###### Returns

[`JsonValue`](#jsonvalue)

***

<a id="target_symbol-1"></a>

### TARGET\_SYMBOL

```ts
const TARGET_SYMBOL: unique symbol;
```

Hidden brand on every [Database](#database) handle.

## Functions

<a id="child-2"></a>

### child()

```ts
function child(parent: DatabaseReference, path: string): DatabaseReference;
```

Sub-path constructor. `child(ref, 'sub/path')` returns a ref at
`<ref>/sub/path`.

Mirrors `firebase/database`'s `child(parent, path)` — leading +
empty segments stripped; the result inherits the parent's target.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `parent` | [`DatabaseReference`](#databasereference) |
| `path` | `string` |

#### Returns

[`DatabaseReference`](#databasereference)

***

<a id="connectdatabaseemulator"></a>

### connectDatabaseEmulator()

```ts
function connectDatabaseEmulator(
   _db: Database,
   _host: string,
   _port: number,
   _options?: {
  mockUserToken?: string | Record<string, unknown>;
}): void;
```

`connectDatabaseEmulator(db, host, port)` is an accepted no-op because the
selected backend already is the local sandbox.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `_db` | [`Database`](#database) |
| `_host` | `string` |
| `_port` | `number` |
| `_options?` | \{ `mockUserToken?`: `string` \| `Record`\<`string`, `unknown`\>; \} |
| `_options.mockUserToken?` | `string` \| `Record`\<`string`, `unknown`\> |

#### Returns

`void`

***

<a id="enablelogging"></a>

### enableLogging()

```ts
function enableLogging(logger?: boolean | (message: string) => void, persistent?: boolean): void;
```

`enableLogging(logger?, persistent?)` — toggle RTDB SDK logging.

Accepted no-op: the sandbox has no modular-SDK-style logger to wire a
level/sink into (it uses host-level `console` logging directly, gated
by `pyric dev`'s own flags — matching `pyric/firestore`'s
`setLogLevel`). Accepted so init code that calls it compiles + runs.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `logger?` | `boolean` \| (`message`: `string`) => `void` |
| `persistent?` | `boolean` |

#### Returns

`void`

***

<a id="endat"></a>

### endAt()

```ts
function endAt(value: JsonValue, key?: string): QueryConstraint;
```

`endAt(value, key?)` — INCLUSIVE upper bound. Adjacent to startAt;
 same key tie-breaker semantics.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | [`JsonValue`](#jsonvalue) |
| `key?` | `string` |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="endbefore"></a>

### endBefore()

```ts
function endBefore(value: JsonValue, key?: string): QueryConstraint;
```

`endBefore(value, key?)` — EXCLUSIVE upper bound. Locked by
 `rtdb-modular-startafter-endbefore-exclusive.json`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | [`JsonValue`](#jsonvalue) |
| `key?` | `string` |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="equalto"></a>

### equalTo()

```ts
function equalTo(value: JsonValue, key?: string): QueryConstraint;
```

`equalTo(value, key?)` — sugar for `startAt(value, key) +
 endAt(value, key)`. Returns ALL matching children (no uniqueness).
 Locked by oracle observation `rtdb-modular-equalTo-filter.json`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | [`JsonValue`](#jsonvalue) |
| `key?` | `string` |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="forcelongpolling"></a>

### forceLongPolling()

```ts
function forceLongPolling(): void;
```

`forceLongPolling()` — force the long-polling transport for all
subsequent `getDatabase` connections.

No-op: transport selection is meaningless to the in-process/worker
sandbox, which never opens a real socket. Accepted so init code that
calls it unconditionally compiles + runs.

#### Returns

`void`

***

<a id="forcewebsockets"></a>

### forceWebSockets()

```ts
function forceWebSockets(): void;
```

`forceWebSockets()` — force the WebSocket transport for all
subsequent `getDatabase` connections.

No-op: transport selection is not applicable to the in-process/worker
sandbox (see [forceLongPolling](#forcelongpolling)).

#### Returns

`void`

***

<a id="get"></a>

### get()

```ts
function get(r: DatabaseReference | Query): Promise<DataSnapshot>;
```

`get(ref)` — one-shot read at the ref's path. Resolves to a
`DataSnapshot`-shaped object.

Runs through the sandbox rule engine; denial throws the plain-`Error`
shape locked by the oracle.

Absent path → `snap.val() === null && snap.exists() === false`.
Matches the SDK's `DataSnapshot.val()` contract.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) \| [`Query`](#query) |

#### Returns

`Promise`\<[`DataSnapshot`](#datasnapshot)\>

***

<a id="getadmindatabase"></a>

### getAdminDatabase()

#### Call Signature

```ts
function getAdminDatabase(sandbox: Sandbox): Database;
```

Sandbox-only rules-bypass RTDB handle. Mirrors Firestore's
`getAdminFirestore(sandbox)` for Studio/Playground data browsers and
controlled admin tools.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `Sandbox` |

##### Returns

[`Database`](#database)

#### Call Signature

```ts
function getAdminDatabase(ctx: SandboxContext): Database;
```

Sandbox-only rules-bypass RTDB handle. Mirrors Firestore's
`getAdminFirestore(sandbox)` for Studio/Playground data browsers and
controlled admin tools.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ctx` | `SandboxContext` |

##### Returns

[`Database`](#database)

#### Call Signature

```ts
function getAdminDatabase(app: FirebaseApp): Database;
```

Sandbox-only rules-bypass RTDB handle. Mirrors Firestore's
`getAdminFirestore(sandbox)` for Studio/Playground data browsers and
controlled admin tools.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `app` | `FirebaseApp` |

##### Returns

[`Database`](#database)

***

<a id="getdatabase"></a>

### getDatabase()

#### Call Signature

```ts
function getDatabase(ctx: SandboxContext): Database;
```

Build a sandbox Database handle:

  - `SandboxContext` → sandbox-backed, frozen identity.
  - `Sandbox` → sandbox-backed, live identity (per-op `currentUser`).

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ctx` | `SandboxContext` |

##### Returns

[`Database`](#database)

##### Example

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, get } from 'pyric/database';

const sandbox = initializeSandbox();
const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
await set(ref(db, 'greetings/hello'), { text: 'hi' });
const snap = await get(ref(db, 'greetings/hello'));
console.log(snap.val()); // { text: 'hi' }
```

#### Call Signature

```ts
function getDatabase(sandbox: Sandbox): Database;
```

Build a sandbox Database handle:

  - `SandboxContext` → sandbox-backed, frozen identity.
  - `Sandbox` → sandbox-backed, live identity (per-op `currentUser`).

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `Sandbox` |

##### Returns

[`Database`](#database)

##### Example

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, get } from 'pyric/database';

const sandbox = initializeSandbox();
const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
await set(ref(db, 'greetings/hello'), { text: 'hi' });
const snap = await get(ref(db, 'greetings/hello'));
console.log(snap.val()); // { text: 'hi' }
```

#### Call Signature

```ts
function getDatabase(app: FirebaseApp): AppDatabase;
```

Build a sandbox Database handle:

  - `SandboxContext` → sandbox-backed, frozen identity.
  - `Sandbox` → sandbox-backed, live identity (per-op `currentUser`).

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `app` | `FirebaseApp` |

##### Returns

[`AppDatabase`](#appdatabase)

##### Example

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, get } from 'pyric/database';

const sandbox = initializeSandbox();
const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
await set(ref(db, 'greetings/hello'), { text: 'hi' });
const snap = await get(ref(db, 'greetings/hello'));
console.log(snap.val()); // { text: 'hi' }
```

#### Call Signature

```ts
function getDatabase(): AppDatabase;
```

Build a sandbox Database handle:

  - `SandboxContext` → sandbox-backed, frozen identity.
  - `Sandbox` → sandbox-backed, live identity (per-op `currentUser`).

##### Returns

[`AppDatabase`](#appdatabase)

##### Example

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, get } from 'pyric/database';

const sandbox = initializeSandbox();
const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
await set(ref(db, 'greetings/hello'), { text: 'hi' });
const snap = await get(ref(db, 'greetings/hello'));
console.log(snap.val()); // { text: 'hi' }
```

***

<a id="gooffline"></a>

### goOffline()

```ts
function goOffline(_db: Database): void;
```

`goOffline(db)` — disconnect the client from the RTDB backend.

No-op on sandbox handles: there is NO network connection in the local
sandbox to toggle, so honest behavior is to accept the call and do
nothing (we deliberately do NOT simulate a disconnect — pending
writes, listeners, and `get()` all keep working exactly as before).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `_db` | [`Database`](#database) |

#### Returns

`void`

***

<a id="goonline"></a>

### goOnline()

```ts
function goOnline(_db: Database): void;
```

`goOnline(db)` — reconnect the client to the RTDB backend.

No-op on sandbox handles (there is no connection to reopen — see
[goOffline](#gooffline)).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `_db` | [`Database`](#database) |

#### Returns

`void`

***

<a id="increment"></a>

### increment()

```ts
function increment(delta: number): IncrementSentinel;
```

`increment(delta)` — returns the `{ ".sv": { increment: delta } }`
sentinel that atomically adds `delta` to the current value at the
write's field. Starts from `0` when the field is absent or
non-numeric (oracle: `rtdb-modular-increment-from-missing.json`).

The sandbox backend resolves it against the field's prior value at write
time. Mirrors `firebase/database`'s `increment` (`api/ServerValue.ts:38-44`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `delta` | `number` |

#### Returns

`IncrementSentinel`

***

<a id="limittofirst"></a>

### limitToFirst()

```ts
function limitToFirst(n: number): QueryConstraint;
```

`limitToFirst(n)` — keep the first N children of the ordered window.
 Locked by oracle observation `rtdb-modular-limittofirst-vs-limittolast.json`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="limittolast"></a>

### limitToLast()

```ts
function limitToLast(n: number): QueryConstraint;
```

`limitToLast(n)` — keep the last N children of the ordered window.
 Locked by oracle observation `rtdb-modular-limittofirst-vs-limittolast.json`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="off"></a>

### off()

```ts
function off(
   r: DatabaseReference,
   eventType?: "value" | ChildEvent,
   callback?: (snap: DataSnapshot) => void): void;
```

`off(ref, eventType?, callback?)` — unsubscribe variant.

Semantics (locked by oracle observation
`packages/conformance/observations/rtdb-modular/rtdb-modular-off-stops-child-fires.json`):

  - `off(ref)` (no eventType) removes ALL listeners at that ref —
    value + every child event variety.
  - `off(ref, 'value')` removes only `value` listeners.
  - `off(ref, 'child_added')` (or any child event type) removes only
    that variety.
  - `off(ref, eventType, cb)` removes only the matching callback.

The returned-unsubscribe pattern from `onValue` / `onChild*` is
functionally equivalent to `off(ref, eventType, cb)` for a specific
registration — both are supported.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) |
| `eventType?` | `"value"` \| `ChildEvent` |
| `callback?` | (`snap`: [`DataSnapshot`](#datasnapshot)) => `void` |

#### Returns

`void`

***

<a id="onchildadded"></a>

### onChildAdded()

```ts
function onChildAdded(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```

`onChildAdded(ref, cb)` — subscribe to child-added events at the
ref's path.

Semantics (locked by oracle observations under
`packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-*.json`):

  - On subscribe, replays every existing direct child of `ref`'s path
    (one fire per existing key, in `orderByKey`-default order).
  - After subscribe, fires exactly once per new direct child write.

Also accepts a [Query](#query) (a `query(ref, ...)` with `orderBy*` /
`limitTo*` constraints): child events are then computed against the
ordered, windowed result — a child ENTERING the window fires
`child_added`; on subscribe the current window is replayed in window
order.

Returns an unsubscribe; calling it twice is a no-op.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) \| [`Query`](#query) |
| `cb` | (`snap`: [`DataSnapshot`](#datasnapshot)) => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="onchildchanged"></a>

### onChildChanged()

```ts
function onChildChanged(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```

`onChildChanged(ref, cb)` — subscribe to child-changed events.

Semantics (oracle: `rtdb-modular-onchildchanged-fires-on-update`):

  - No initial replay.
  - Fires when an existing direct child's value transitions to a
    NEW non-null value. Snapshot carries the NEW value.
  - Does NOT fire for added or removed children.

Also accepts a [Query](#query): fires when a child that is IN the query
window changes value (an in-window update).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) \| [`Query`](#query) |
| `cb` | (`snap`: [`DataSnapshot`](#datasnapshot)) => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="onchildmoved"></a>

### onChildMoved()

```ts
function onChildMoved(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```

`onChildMoved(ref, cb)` — subscribe to child-moved events.

Semantics (oracle: `rtdb-modular-onchildmoved-with-orderby`):

  - Only fires under an ordered query (`query(ref, orderByChild(...))`).
  - Under a plain ref, this listener is effectively a no-op — the
    upstream SDK accepts the subscription but never fires it
    (matches RTDB docs).

Accepts a [Query](#query) WITHOUT throwing, but the sandbox deliberately
does NOT fire `child_moved` on reorder yet: prod fires here (matrix row
`rtdb-modular#137`) while the sandbox holds — the reorder /
`previousChildName` ordering semantics are pending two new oracle
captures. This is a documented, pinned divergence (both sides asserted
in `test/database/modular/sandbox-child-events.test.ts`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) \| [`Query`](#query) |
| `cb` | (`snap`: [`DataSnapshot`](#datasnapshot)) => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="onchildremoved"></a>

### onChildRemoved()

```ts
function onChildRemoved(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```

`onChildRemoved(ref, cb)` — subscribe to child-removed events.

Semantics (oracle: `rtdb-modular-onchildremoved-fires-on-delete`):

  - No initial replay.
  - Fires when a direct child is deleted (via `remove(child)` or
    `set(child, null)`).
  - Snapshot carries the PRIOR (now-removed) value — the listener
    sees what was there before deletion.

Also accepts a [Query](#query): a child LEAVING the query window (e.g.
displaced past a `limitTo*` boundary or filtered out) fires
`child_removed` carrying its prior value.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) \| [`Query`](#query) |
| `cb` | (`snap`: [`DataSnapshot`](#datasnapshot)) => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="onvalue"></a>

### onValue()

```ts
function onValue(
   r: DatabaseReference | Query,
   cb: (snap: DataSnapshot) => void,
   options?: {
  onlyOnce?: boolean;
}): Unsubscribe;
```

`onValue(ref, cb)` — subscribe to value changes at the ref's path.

Fires immediately on subscribe with the current value (or
`null` + `exists: false` for an absent path), then on every
subsequent write that touches the path or any descendant.

Returns an unsubscribe function. The unsubscribe is idempotent;
calling it twice is a no-op.

`options.onlyOnce` (DB-B12): when `true`, the listener auto-unsubscribes
after its first fire (mirrors `api/Reference_impl.ts:975-980`).

Errors path: subscribing under rules that deny the read throws the
plain-`Error` `PERMISSION_DENIED` shape synchronously (matching the
production behavior where the subscribe path immediately errors).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) \| [`Query`](#query) |
| `cb` | (`snap`: [`DataSnapshot`](#datasnapshot)) => `void` |
| `options?` | \{ `onlyOnce?`: `boolean`; \} |
| `options.onlyOnce?` | `boolean` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="orderbychild"></a>

### orderByChild()

```ts
function orderByChild(path: string): QueryConstraint;
```

`orderByChild('path')` — order children by the value at the nested
 child path. Locked by oracle observation
 `rtdb-modular-orderbychild-window.json`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="orderbykey"></a>

### orderByKey()

```ts
function orderByKey(): QueryConstraint;
```

`orderByKey()` — order children lexicographically by key string.
 Locked by oracle observation `rtdb-modular-orderbykey-window.json`.

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="orderbyvalue"></a>

### orderByValue()

```ts
function orderByValue(): QueryConstraint;
```

`orderByValue()` — order children by primitive value. Prod requires
 `.indexOn: ".value"` (oracle: `rtdb-modular-orderbyvalue-numeric.json`
 threw `Index not defined` against blockingfun); sandbox does NOT
 enforce indexes (the rules engine here checks read-allow only, not
 query-index conformance).

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="push"></a>

### push()

```ts
function push(r: DatabaseReference, value?: unknown): ThenableReference;
```

`push(ref, value?)` — mint an auto-id child key under `ref`'s path,
optionally writing `value` at the new child.

Returns a ref at the new child path. The ref's `key` is the minted
id (locked by oracle observation `rtdb-push-autoid-format.json`:
20 chars, leading `-`, lex-sortable).

Production note: the key is minted **client-side** (no server
round-trip required); it's available synchronously on the returned
ref even when the optional write is denied by rules. The oracle
observation confirms this — the sandbox matches.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) |
| `value?` | `unknown` |

#### Returns

[`ThenableReference`](#thenablereference)

***

<a id="pushkey"></a>

### pushKey()

```ts
function pushKey(): string;
```

Pre-mint a push key without writing. Used by callers that need the
key for a multi-path update (`update(rootRef, { [\`/users/${key}\`]: ... })`).
Returns a freshly-minted key.

#### Returns

`string`

***

<a id="query-1"></a>

### query()

```ts
function query(refOrQuery: DatabaseReference | Query, ...constraints: QueryConstraint[]): Query;
```

`query(ref, ...constraints)` — wrap a ref in an immutable
constraint chain. The resulting [Query](#query) routes through
[get](#get)/[onValue](#onvalue) and applies the ordering + filtering +
limit pipeline on the sandbox backend.

Chaining is supported — `query(query(ref, orderByChild('x')),
limitToFirst(2))` folds both constraints into one spec.

Locked semantics (oracle):
  - `orderByChild('p') + startAt(v) + endAt(w)` is BOTH-inclusive
    (`rtdb-modular-orderbychild-window.json`).
  - `orderByKey() + startAt('b') + endAt('d')` matches `[b, c, d]`
    (`rtdb-modular-orderbykey-window.json`).
  - `orderByValue() + limitToFirst(3)` returns the 3 smallest by
    value (`rtdb-modular-orderbyvalue-numeric.json` — note: prod
    requires `.indexOn: ".value"`; sandbox does not enforce indexes).
  - `orderByChild('group') + equalTo('b')` returns ALL matching
    children (`rtdb-modular-equalTo-filter.json`).
  - `limitToFirst(N)` / `limitToLast(N)` take from the start / end of
    the ordered window (`rtdb-modular-limittofirst-vs-limittolast.json`).
  - `startAfter` / `endBefore` are EXCLUSIVE
    (`rtdb-modular-startafter-endbefore-exclusive.json`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `refOrQuery` | [`DatabaseReference`](#databasereference) \| [`Query`](#query) |
| ...`constraints` | [`QueryConstraint`](#queryconstraint)[] |

#### Returns

[`Query`](#query)

***

<a id="ref-2"></a>

### ref()

```ts
function ref(db: Database, path?: string): DatabaseReference;
```

Build a [DatabaseReference](#databasereference) at `path` (default root).

Path normalisation: leading + trailing slashes are stripped;
empty path / `'/'` becomes the root.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Database`](#database) |
| `path?` | `string` |

#### Returns

[`DatabaseReference`](#databasereference)

***

<a id="reffromurl"></a>

### refFromURL()

```ts
function refFromURL(db: Database, url: string): DatabaseReference;
```

`refFromURL(db, url)` — build a [DatabaseReference](#databasereference) from an
absolute database URL (`https://<namespace>.firebaseio.com/path`).

Real alias with real behavior: parses the path out of the URL and
delegates to [ref](#ref-2), so the returned ref resolves + reads exactly
like `ref(db, path)`. The sandbox is single-database and has no host /
namespace, so the URL's HOST is not validated against the handle (the
real SDK throws if the host doesn't match the db's namespace); only
the path component is honored.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Database`](#database) |
| `url` | `string` |

#### Returns

[`DatabaseReference`](#databasereference)

***

<a id="remove"></a>

### remove()

```ts
function remove(r: DatabaseReference): Promise<void>;
```

`remove(ref)` — delete the subtree at the ref's path.

RTDB invariant (oracle: `rtdb-remove-vs-set-null.json`): equivalent
to `set(ref, null)`. The sandbox backend dispatches `remove` through
the same code path as `set(_, null)`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) |

#### Returns

`Promise`\<`void`\>

***

<a id="runtransaction"></a>

### runTransaction()

```ts
function runTransaction<T>(
   r: DatabaseReference,
   transactionUpdate: (current: T) => T,
   options?: {
  applyLocally?: boolean;
}): Promise<TransactionResult>;
```

`runTransaction(ref, transactionUpdate, options?)` — atomic
read-modify-write.

Contract (oracle-locked):

  1. `transactionUpdate` is called with the CURRENT value at `ref`'s
     path. For an absent path the arg is `null` (NOT `undefined`);
     oracle:
     `rtdb-modular-runtransaction-current-value-arg.json` →
     `missingFirstWasNull: true`.
  2. Returning `undefined` from the update fn ABORTS the transaction:
     resolves `{ committed: false, snapshot }` where the snapshot is
     the pre-transaction value; oracle:
     `rtdb-modular-runtransaction-abort-undefined.json` → `committed:
     false, snapVal: null`.
  3. Returning any defined value WRITES that value (rules-checked);
     resolves `{ committed: true, snapshot }` where `snapshot.val()`
     is the committed value; oracle:
     `rtdb-modular-runtransaction-success.json` → `committedNewValue:
     true` and
     `rtdb-modular-runtransaction-returns-committed-snapshot.json`.
  4. If rules deny the write, the promise REJECTS with a plain
     `Error` whose `message === 'permission_denied'` and NO `.code`
     field (distinct from `set`/`get`'s `'PERMISSION_DENIED:
     Permission denied'`); oracle:
     `rtdb-modular-runtransaction-on-rules-denied-path.json`.

`options.applyLocally` (default `true`): when `false`, the
intermediate optimistic value is NOT fanned out to listeners — they
see only the committed value. In a single-client harness this is
usually invisible; we honor the flag for prod-parity. Oracle
observation `rtdb-modular-runtransaction-options-applylocally.json`
confirms both branches commit and end at the same value; the
intermediate-fire difference isn't observable from a single client.

Single-client sandbox doesn't model concurrency conflicts; the
documented "retry on conflict" path is degenerate (no other writer
exists to conflict with). The fn is invoked once.

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) |
| `transactionUpdate` | (`current`: `T`) => `T` |
| `options?` | \{ `applyLocally?`: `boolean`; \} |
| `options.applyLocally?` | `boolean` |

#### Returns

`Promise`\<[`TransactionResult`](#transactionresult)\>

***

<a id="servertimestamp"></a>

### serverTimestamp()

```ts
function serverTimestamp(): ServerTimestampSentinel;
```

`serverTimestamp()` — returns the `{ ".sv": "timestamp" }` sentinel
the wire encoder recognises. Resolves to `Date.now()` (epoch ms) on
write — locked by the prod SDK's resolved-as-number contract
(oracle: `rtdb-servertimestamp-resolves.json`).

The sandbox backend recognises the marker.

#### Returns

`ServerTimestampSentinel`

***

<a id="set"></a>

### set()

```ts
function set(r: DatabaseReference, value: unknown): Promise<void>;
```

`set(ref, value)` — replace the value at `ref`'s path. `null`
deletes (matches the RTDB invariant — locked by oracle observation
`rtdb-remove-vs-set-null.json`).

`serverTimestamp()` sentinels are resolved at write time.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) |
| `value` | `unknown` |

#### Returns

`Promise`\<`void`\>

***

<a id="startafter"></a>

### startAfter()

```ts
function startAfter(value: JsonValue, key?: string): QueryConstraint;
```

`startAfter(value, key?)` — EXCLUSIVE lower bound. Locked by
 `rtdb-modular-startafter-endbefore-exclusive.json`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | [`JsonValue`](#jsonvalue) |
| `key?` | `string` |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="startat"></a>

### startAt()

```ts
function startAt(value: JsonValue, key?: string): QueryConstraint;
```

`startAt(value, key?)` — INCLUSIVE lower bound under the active
 ordering. Optional `key` is the tie-breaker when ordering by
 child/value and multiple children share the bound's value.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | [`JsonValue`](#jsonvalue) |
| `key?` | `string` |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="update"></a>

### update()

```ts
function update(r: DatabaseReference, values: Record<string, unknown>): Promise<void>;
```

`update(ref, values)` — partial update.

  - When `values` keys contain `/`, the call is a **multi-path atomic
    update**: every listed path is written as one transaction (any
    denial fails the whole batch).
  - Otherwise it's a **shallow merge** at the ref's path: each
    top-level key replaces the corresponding child. `null` values
    delete.

Both behaviors are sandbox-implemented per the RtdbBackend's
`update` method (`rtdb-modular`-spec atomic claim, matrix row #23).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `r` | [`DatabaseReference`](#databasereference) |
| `values` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<`void`\>

## References

<a id="authstate"></a>

### AuthState

Renames and re-exports [Sandbox](#sandbox)

***

<a id="sandboxcontext"></a>

### SandboxContext

Renames and re-exports [Sandbox](#sandbox)
