<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# pyric/database

## Interfaces

### Database

Opaque RTDB handle. Routes via [TARGET\_SYMBOL](#target_symbol-1).

#### Properties

##### \[TARGET\_SYMBOL\]

> `readonly` **\[TARGET\_SYMBOL\]**: `Target`

##### app?

> `readonly` `optional` **app**: `FirebaseApp`

***

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

##### \_path

> `readonly` **\_path**: `string`

Internal — the canonical path (`'/users/alice'`).

##### key

> `readonly` **key**: `string`

##### parent

> `readonly` **parent**: [`DatabaseReference`](#databasereference)

##### root

> `readonly` **root**: [`DatabaseReference`](#databasereference)

#### Methods

##### toString()

> **toString**(): `string`

###### Returns

`string`

***

### DataSnapshot

Lightweight `DataSnapshot` — matches the subset of
`firebase/database`'s `DataSnapshot` we surface synchronously on a
`get()`. Methods are the load-bearing ones (`val`, `exists`, `key`,
`child`) plus a few utilities consumer code routinely reads.

#### Properties

##### key

> `readonly` **key**: `string`

##### priority

> `readonly` **priority**: `string` \| `number`

The node's priority, or `null`. The sandbox does not model RTDB's
priority values, so this is always `null`, matching
the common case (no `.priority` set). Mirrors `api/Reference_impl.ts:312`.

##### ref

> `readonly` **ref**: [`DatabaseReference`](#databasereference)

The ref the snap was taken from.

##### size

> `readonly` **size**: `number`

Number of child properties of this snapshot. A getter (NOT a
`numChildren()` method — that was the legacy namespaced API). Locked
by oracle `rtdb-modular-get-snapshot-shape.json`
(`hasSize: true, hasNumChildren: false`) + upstream
`api/Reference_impl.ts:331-333`.

#### Methods

##### child()

> **child**(`path`): [`DataSnapshot`](#datasnapshot)

###### Parameters

###### path

`string`

###### Returns

[`DataSnapshot`](#datasnapshot)

##### exists()

> **exists**(): `boolean`

###### Returns

`boolean`

##### exportVal()

> **exportVal**(): [`JsonValue`](#jsonvalue)

Like `val()` but includes priority info (for backups). With no
priority modeled, this equals `val()`. Mirrors
`api/Reference_impl.ts:374-376`.

###### Returns

[`JsonValue`](#jsonvalue)

##### forEach()

> **forEach**(`cb`): `boolean`

Iterate the snapshot's immediate children. The callback is invoked
with a child `DataSnapshot` for each child; return `true` to stop
iteration early (matches the `firebase/database` contract).

For a snapshot built from a [Query](#query), children are visited in
the order the query's `orderBy*` constraint computed — the windowed
+ filtered + limited sequence. For a plain ref snapshot, children
are visited in key-insertion order (V8 object iteration order; the
RTDB SDK does NOT guarantee an order on plain refs either).

###### Parameters

###### cb

(`child`) => `boolean` \| `void`

###### Returns

`boolean`

##### hasChild()

> **hasChild**(`path`): `boolean`

###### Parameters

###### path

`string`

###### Returns

`boolean`

##### hasChildren()

> **hasChildren**(): `boolean`

###### Returns

`boolean`

##### toJSON()

> **toJSON**(): [`JsonValue`](#jsonvalue)

###### Returns

[`JsonValue`](#jsonvalue)

##### val()

> **val**(): [`JsonValue`](#jsonvalue)

###### Returns

[`JsonValue`](#jsonvalue)

***

### Query

RTDB-shaped Query — a ref + an immutable constraint chain. Mirrors
`firebase/database`'s `Query` for the subset of methods the modular
SDK uses idiomatically.

Construct with [query](#query-1); pass to [get](#get) or [onValue](#onvalue).

#### Properties

##### \_spec

> `readonly` **\_spec**: `QuerySpec`

Internal — the constraint chain that built this query (sandbox path).

##### \[QUERY\_SYMBOL\]

> `readonly` **\[QUERY\_SYMBOL\]**: `true`

##### ref

> `readonly` **ref**: [`DatabaseReference`](#databasereference)

The Query's location. Used by `query()` chaining + listener fan-out.

#### Methods

##### toString()

> **toString**(): `string`

Resolves to the same URL the ref would.

###### Returns

`string`

***

### QueryConstraint

Opaque constraint produced by `orderByChild` / `equalTo` / `limitToFirst`
etc. Pass to [query](#query-1).

#### Properties

##### \[CONSTRAINT\_SYMBOL\]

> `readonly` **\[CONSTRAINT\_SYMBOL\]**: `Constraint`

##### type

> `readonly` **type**: `"orderByChild"` \| `"orderByKey"` \| `"orderByValue"` \| `"startAt"` \| `"startAfter"` \| `"endAt"` \| `"endBefore"` \| `"equalTo"` \| `"limitToFirst"` \| `"limitToLast"`

The constraint's variant — surfaces as the SDK's
 `QueryConstraintType` strings.

***

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

##### \_path

> `readonly` **\_path**: `string`

Internal — the canonical path (`'/users/alice'`).

###### Inherited from

[`DatabaseReference`](#databasereference).[`_path`](#_path)

##### key

> `readonly` **key**: `string`

###### Inherited from

[`DatabaseReference`](#databasereference).[`key`](#key)

##### parent

> `readonly` **parent**: [`DatabaseReference`](#databasereference)

###### Inherited from

[`DatabaseReference`](#databasereference).[`parent`](#parent)

##### root

> `readonly` **root**: [`DatabaseReference`](#databasereference)

###### Inherited from

[`DatabaseReference`](#databasereference).[`root`](#root)

#### Methods

##### catch()

> **catch**\<`TResult`\>(`onrejected?`): `Promise`\<[`DatabaseReference`](#databasereference) \| `TResult`\>

###### Type Parameters

###### TResult

`TResult` = `never`

###### Parameters

###### onrejected?

(`reason`) => `TResult` \| `PromiseLike`\<`TResult`\>

###### Returns

`Promise`\<[`DatabaseReference`](#databasereference) \| `TResult`\>

##### then()

> **then**\<`TResult1`, `TResult2`\>(`onfulfilled?`, `onrejected?`): `Promise`\<`TResult1` \| `TResult2`\>

###### Type Parameters

###### TResult1

`TResult1` = [`DatabaseReference`](#databasereference)

###### TResult2

`TResult2` = `never`

###### Parameters

###### onfulfilled?

(`value`) => `TResult1` \| `PromiseLike`\<`TResult1`\>

###### onrejected?

(`reason`) => `TResult2` \| `PromiseLike`\<`TResult2`\>

###### Returns

`Promise`\<`TResult1` \| `TResult2`\>

##### toString()

> **toString**(): `string`

###### Returns

`string`

###### Inherited from

[`DatabaseReference`](#databasereference).[`toString`](#tostring)

***

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

##### committed

> `readonly` **committed**: `boolean`

##### snapshot

> `readonly` **snapshot**: [`DataSnapshot`](#datasnapshot)

## Type Aliases

### AppDatabase

> **AppDatabase** = [`Database`](#database) & `object`

Database handle returned by Firebase-shaped app overloads.

#### Type Declaration

##### app

> `readonly` **app**: `FirebaseApp`

***

### JsonValue

> **JsonValue** = `null` \| `boolean` \| `number` \| `string` \| [`JsonValue`](#jsonvalue)[] \| \{\[`key`: `string`\]: [`JsonValue`](#jsonvalue); \}

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

### Sandbox

> **Sandbox** = `any`

***

### Unsubscribe()

> **Unsubscribe** = () => `void`

#### Returns

`void`

## Variables

### QUERY\_SYMBOL

> `const` **QUERY\_SYMBOL**: unique `symbol`

Hidden brand on every [Query](#query) (and on every QueryConstraint).
Distinct from `TARGET_SYMBOL`; this brand is only used to dispatch
`get` / `onValue` between plain refs and query-wrapped refs.

***

### sandbox

> `const` **sandbox**: `object`

#### Type Declaration

##### setData()

> **setData**(`db`, `data`): `void`

Bulk-load data bypassing rules. The supplied map's keys are
absolute paths (`'/users/alice'`) and the values land at those
paths. Convenient for test fixtures.

###### Parameters

###### db

[`Database`](#database)

###### data

`Record`\<`string`, `unknown`\>

###### Returns

`void`

##### setRules()

> **setRules**(`db`, `rulesJson`): `void`

Replace deployed rules. Pass `null` to clear (sandbox returns to
default-allow). Rules are evaluated through the existing
RTDB rules simulator — the same engine used by the rules tooling.

###### Parameters

###### db

[`Database`](#database)

###### rulesJson

###### rules

`Record`\<`string`, `unknown`\>

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

##### snapshotState()

> **snapshotState**(`db`): [`JsonValue`](#jsonvalue)

Snapshot the full sandbox tree (rule-bypass read). Usually a keyed
 object; may be a primitive when the root holds one (DB-B13).

###### Parameters

###### db

[`Database`](#database)

###### Returns

[`JsonValue`](#jsonvalue)

***

### TARGET\_SYMBOL

> `const` **TARGET\_SYMBOL**: unique `symbol`

Hidden brand on every [Database](#database) handle.

## Functions

### child()

> **child**(`parent`, `path`): [`DatabaseReference`](#databasereference)

Sub-path constructor. `child(ref, 'sub/path')` returns a ref at
`<ref>/sub/path`.

Mirrors `firebase/database`'s `child(parent, path)` — leading +
empty segments stripped; the result inherits the parent's target.

#### Parameters

##### parent

[`DatabaseReference`](#databasereference)

##### path

`string`

#### Returns

[`DatabaseReference`](#databasereference)

***

### connectDatabaseEmulator()

> **connectDatabaseEmulator**(`_db`, `_host`, `_port`, `_options?`): `void`

`connectDatabaseEmulator(db, host, port)` is an accepted no-op because the
selected backend already is the local sandbox.

#### Parameters

##### \_db

[`Database`](#database)

##### \_host

`string`

##### \_port

`number`

##### \_options?

###### mockUserToken?

`string` \| `Record`\<`string`, `unknown`\>

#### Returns

`void`

***

### enableLogging()

> **enableLogging**(`logger?`, `persistent?`): `void`

`enableLogging(logger?, persistent?)` — toggle RTDB SDK logging.

Accepted no-op: the sandbox has no modular-SDK-style logger to wire a
level/sink into (it uses host-level `console` logging directly, gated
by `pyric dev`'s own flags — matching `pyric/firestore`'s
`setLogLevel`). Accepted so init code that calls it compiles + runs.

#### Parameters

##### logger?

`boolean` | (`message`) => `void`

##### persistent?

`boolean`

#### Returns

`void`

***

### endAt()

> **endAt**(`value`, `key?`): [`QueryConstraint`](#queryconstraint)

`endAt(value, key?)` — INCLUSIVE upper bound. Adjacent to startAt;
 same key tie-breaker semantics.

#### Parameters

##### value

[`JsonValue`](#jsonvalue)

##### key?

`string`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### endBefore()

> **endBefore**(`value`, `key?`): [`QueryConstraint`](#queryconstraint)

`endBefore(value, key?)` — EXCLUSIVE upper bound. Locked by
 `rtdb-modular-startafter-endbefore-exclusive.json`.

#### Parameters

##### value

[`JsonValue`](#jsonvalue)

##### key?

`string`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### equalTo()

> **equalTo**(`value`, `key?`): [`QueryConstraint`](#queryconstraint)

`equalTo(value, key?)` — sugar for `startAt(value, key) +
 endAt(value, key)`. Returns ALL matching children (no uniqueness).
 Locked by oracle observation `rtdb-modular-equalTo-filter.json`.

#### Parameters

##### value

[`JsonValue`](#jsonvalue)

##### key?

`string`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### forceLongPolling()

> **forceLongPolling**(): `void`

`forceLongPolling()` — force the long-polling transport for all
subsequent `getDatabase` connections.

No-op: transport selection is meaningless to the in-process/worker
sandbox, which never opens a real socket. Accepted so init code that
calls it unconditionally compiles + runs.

#### Returns

`void`

***

### forceWebSockets()

> **forceWebSockets**(): `void`

`forceWebSockets()` — force the WebSocket transport for all
subsequent `getDatabase` connections.

No-op: transport selection is not applicable to the in-process/worker
sandbox (see [forceLongPolling](#forcelongpolling)).

#### Returns

`void`

***

### get()

> **get**(`r`): `Promise`\<[`DataSnapshot`](#datasnapshot)\>

`get(ref)` — one-shot read at the ref's path. Resolves to a
`DataSnapshot`-shaped object.

Runs through the sandbox rule engine; denial throws the plain-`Error`
shape locked by the oracle.

Absent path → `snap.val() === null && snap.exists() === false`.
Matches the SDK's `DataSnapshot.val()` contract.

#### Parameters

##### r

[`DatabaseReference`](#databasereference) | [`Query`](#query)

#### Returns

`Promise`\<[`DataSnapshot`](#datasnapshot)\>

***

### getAdminDatabase()

#### Call Signature

> **getAdminDatabase**(`sandbox`): [`Database`](#database)

Sandbox-only rules-bypass RTDB handle. Mirrors Firestore's
`getAdminFirestore(sandbox)` for Studio/Playground data browsers and
controlled admin tools.

##### Parameters

###### sandbox

`Sandbox`

##### Returns

[`Database`](#database)

#### Call Signature

> **getAdminDatabase**(`ctx`): [`Database`](#database)

Sandbox-only rules-bypass RTDB handle. Mirrors Firestore's
`getAdminFirestore(sandbox)` for Studio/Playground data browsers and
controlled admin tools.

##### Parameters

###### ctx

`SandboxContext`

##### Returns

[`Database`](#database)

#### Call Signature

> **getAdminDatabase**(`app`): [`Database`](#database)

Sandbox-only rules-bypass RTDB handle. Mirrors Firestore's
`getAdminFirestore(sandbox)` for Studio/Playground data browsers and
controlled admin tools.

##### Parameters

###### app

`FirebaseApp`

##### Returns

[`Database`](#database)

***

### getDatabase()

#### Call Signature

> **getDatabase**(`ctx`): [`Database`](#database)

Build a sandbox Database handle:

  - `SandboxContext` → sandbox-backed, frozen identity.
  - `Sandbox` → sandbox-backed, live identity (per-op `currentUser`).

##### Parameters

###### ctx

`SandboxContext`

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

> **getDatabase**(`sandbox`): [`Database`](#database)

Build a sandbox Database handle:

  - `SandboxContext` → sandbox-backed, frozen identity.
  - `Sandbox` → sandbox-backed, live identity (per-op `currentUser`).

##### Parameters

###### sandbox

`Sandbox`

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

> **getDatabase**(`app`): [`AppDatabase`](#appdatabase)

Build a sandbox Database handle:

  - `SandboxContext` → sandbox-backed, frozen identity.
  - `Sandbox` → sandbox-backed, live identity (per-op `currentUser`).

##### Parameters

###### app

`FirebaseApp`

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

> **getDatabase**(): [`AppDatabase`](#appdatabase)

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

### goOffline()

> **goOffline**(`_db`): `void`

`goOffline(db)` — disconnect the client from the RTDB backend.

No-op on sandbox handles: there is NO network connection in the local
sandbox to toggle, so honest behavior is to accept the call and do
nothing (we deliberately do NOT simulate a disconnect — pending
writes, listeners, and `get()` all keep working exactly as before).

#### Parameters

##### \_db

[`Database`](#database)

#### Returns

`void`

***

### goOnline()

> **goOnline**(`_db`): `void`

`goOnline(db)` — reconnect the client to the RTDB backend.

No-op on sandbox handles (there is no connection to reopen — see
[goOffline](#gooffline)).

#### Parameters

##### \_db

[`Database`](#database)

#### Returns

`void`

***

### increment()

> **increment**(`delta`): `IncrementSentinel`

`increment(delta)` — returns the `{ ".sv": { increment: delta } }`
sentinel that atomically adds `delta` to the current value at the
write's field. Starts from `0` when the field is absent or
non-numeric (oracle: `rtdb-modular-increment-from-missing.json`).

The sandbox backend resolves it against the field's prior value at write
time. Mirrors `firebase/database`'s `increment` (`api/ServerValue.ts:38-44`).

#### Parameters

##### delta

`number`

#### Returns

`IncrementSentinel`

***

### limitToFirst()

> **limitToFirst**(`n`): [`QueryConstraint`](#queryconstraint)

`limitToFirst(n)` — keep the first N children of the ordered window.
 Locked by oracle observation `rtdb-modular-limittofirst-vs-limittolast.json`.

#### Parameters

##### n

`number`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### limitToLast()

> **limitToLast**(`n`): [`QueryConstraint`](#queryconstraint)

`limitToLast(n)` — keep the last N children of the ordered window.
 Locked by oracle observation `rtdb-modular-limittofirst-vs-limittolast.json`.

#### Parameters

##### n

`number`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### off()

> **off**(`r`, `eventType?`, `callback?`): `void`

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

##### r

[`DatabaseReference`](#databasereference)

##### eventType?

`"value"` | `ChildEvent`

##### callback?

(`snap`) => `void`

#### Returns

`void`

***

### onChildAdded()

> **onChildAdded**(`r`, `cb`): [`Unsubscribe`](#unsubscribe)

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

##### r

[`DatabaseReference`](#databasereference) | [`Query`](#query)

##### cb

(`snap`) => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### onChildChanged()

> **onChildChanged**(`r`, `cb`): [`Unsubscribe`](#unsubscribe)

`onChildChanged(ref, cb)` — subscribe to child-changed events.

Semantics (oracle: `rtdb-modular-onchildchanged-fires-on-update`):

  - No initial replay.
  - Fires when an existing direct child's value transitions to a
    NEW non-null value. Snapshot carries the NEW value.
  - Does NOT fire for added or removed children.

Also accepts a [Query](#query): fires when a child that is IN the query
window changes value (an in-window update).

#### Parameters

##### r

[`DatabaseReference`](#databasereference) | [`Query`](#query)

##### cb

(`snap`) => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### onChildMoved()

> **onChildMoved**(`r`, `cb`): [`Unsubscribe`](#unsubscribe)

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

##### r

[`DatabaseReference`](#databasereference) | [`Query`](#query)

##### cb

(`snap`) => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### onChildRemoved()

> **onChildRemoved**(`r`, `cb`): [`Unsubscribe`](#unsubscribe)

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

##### r

[`DatabaseReference`](#databasereference) | [`Query`](#query)

##### cb

(`snap`) => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### onValue()

> **onValue**(`r`, `cb`, `options?`): [`Unsubscribe`](#unsubscribe)

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

##### r

[`DatabaseReference`](#databasereference) | [`Query`](#query)

##### cb

(`snap`) => `void`

##### options?

###### onlyOnce?

`boolean`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### orderByChild()

> **orderByChild**(`path`): [`QueryConstraint`](#queryconstraint)

`orderByChild('path')` — order children by the value at the nested
 child path. Locked by oracle observation
 `rtdb-modular-orderbychild-window.json`.

#### Parameters

##### path

`string`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### orderByKey()

> **orderByKey**(): [`QueryConstraint`](#queryconstraint)

`orderByKey()` — order children lexicographically by key string.
 Locked by oracle observation `rtdb-modular-orderbykey-window.json`.

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### orderByValue()

> **orderByValue**(): [`QueryConstraint`](#queryconstraint)

`orderByValue()` — order children by primitive value. Prod requires
 `.indexOn: ".value"` (oracle: `rtdb-modular-orderbyvalue-numeric.json`
 threw `Index not defined` against blockingfun); sandbox does NOT
 enforce indexes (the rules engine here checks read-allow only, not
 query-index conformance).

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### push()

> **push**(`r`, `value?`): [`ThenableReference`](#thenablereference)

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

##### r

[`DatabaseReference`](#databasereference)

##### value?

`unknown`

#### Returns

[`ThenableReference`](#thenablereference)

***

### pushKey()

> **pushKey**(): `string`

Pre-mint a push key without writing. Used by callers that need the
key for a multi-path update (`update(rootRef, { [\`/users/${key}\`]: ... })`).
Returns a freshly-minted key.

#### Returns

`string`

***

### query()

> **query**(`refOrQuery`, ...`constraints`): [`Query`](#query)

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

##### refOrQuery

[`DatabaseReference`](#databasereference) | [`Query`](#query)

##### constraints

...[`QueryConstraint`](#queryconstraint)[]

#### Returns

[`Query`](#query)

***

### ref()

> **ref**(`db`, `path?`): [`DatabaseReference`](#databasereference)

Build a [DatabaseReference](#databasereference) at `path` (default root).

Path normalisation: leading + trailing slashes are stripped;
empty path / `'/'` becomes the root.

#### Parameters

##### db

[`Database`](#database)

##### path?

`string`

#### Returns

[`DatabaseReference`](#databasereference)

***

### refFromURL()

> **refFromURL**(`db`, `url`): [`DatabaseReference`](#databasereference)

`refFromURL(db, url)` — build a [DatabaseReference](#databasereference) from an
absolute database URL (`https://<namespace>.firebaseio.com/path`).

Real alias with real behavior: parses the path out of the URL and
delegates to [ref](#ref-2), so the returned ref resolves + reads exactly
like `ref(db, path)`. The sandbox is single-database and has no host /
namespace, so the URL's HOST is not validated against the handle (the
real SDK throws if the host doesn't match the db's namespace); only
the path component is honored.

#### Parameters

##### db

[`Database`](#database)

##### url

`string`

#### Returns

[`DatabaseReference`](#databasereference)

***

### remove()

> **remove**(`r`): `Promise`\<`void`\>

`remove(ref)` — delete the subtree at the ref's path.

RTDB invariant (oracle: `rtdb-remove-vs-set-null.json`): equivalent
to `set(ref, null)`. The sandbox backend dispatches `remove` through
the same code path as `set(_, null)`.

#### Parameters

##### r

[`DatabaseReference`](#databasereference)

#### Returns

`Promise`\<`void`\>

***

### runTransaction()

> **runTransaction**\<`T`\>(`r`, `transactionUpdate`, `options?`): `Promise`\<[`TransactionResult`](#transactionresult)\>

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

##### T

`T`

#### Parameters

##### r

[`DatabaseReference`](#databasereference)

##### transactionUpdate

(`current`) => `T`

##### options?

###### applyLocally?

`boolean`

#### Returns

`Promise`\<[`TransactionResult`](#transactionresult)\>

***

### serverTimestamp()

> **serverTimestamp**(): `ServerTimestampSentinel`

`serverTimestamp()` — returns the `{ ".sv": "timestamp" }` sentinel
the wire encoder recognises. Resolves to `Date.now()` (epoch ms) on
write — locked by the prod SDK's resolved-as-number contract
(oracle: `rtdb-servertimestamp-resolves.json`).

The sandbox backend recognises the marker.

#### Returns

`ServerTimestampSentinel`

***

### set()

> **set**(`r`, `value`): `Promise`\<`void`\>

`set(ref, value)` — replace the value at `ref`'s path. `null`
deletes (matches the RTDB invariant — locked by oracle observation
`rtdb-remove-vs-set-null.json`).

`serverTimestamp()` sentinels are resolved at write time.

#### Parameters

##### r

[`DatabaseReference`](#databasereference)

##### value

`unknown`

#### Returns

`Promise`\<`void`\>

***

### startAfter()

> **startAfter**(`value`, `key?`): [`QueryConstraint`](#queryconstraint)

`startAfter(value, key?)` — EXCLUSIVE lower bound. Locked by
 `rtdb-modular-startafter-endbefore-exclusive.json`.

#### Parameters

##### value

[`JsonValue`](#jsonvalue)

##### key?

`string`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### startAt()

> **startAt**(`value`, `key?`): [`QueryConstraint`](#queryconstraint)

`startAt(value, key?)` — INCLUSIVE lower bound under the active
 ordering. Optional `key` is the tie-breaker when ordering by
 child/value and multiple children share the bound's value.

#### Parameters

##### value

[`JsonValue`](#jsonvalue)

##### key?

`string`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### update()

> **update**(`r`, `values`): `Promise`\<`void`\>

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

##### r

[`DatabaseReference`](#databasereference)

##### values

`Record`\<`string`, `unknown`\>

#### Returns

`Promise`\<`void`\>

## References

### AuthState

Renames and re-exports [Sandbox](#sandbox)

***

### SandboxContext

Renames and re-exports [Sandbox](#sandbox)
