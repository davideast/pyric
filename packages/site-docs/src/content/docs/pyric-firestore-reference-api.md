---
title: "API reference: pyric/firestore"
navLabel: "pyric/firestore"
group: "API reference"
section: "pyric"
order: 24024
description: "Published declarations for pyric/firestore."
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/firestore"
apiSubpath: "firestore"
apiSymbolCount: 110
apiEvidenceSlug: "pyric-firestore-compat"
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Classes

<a id="bytes"></a>

### Bytes

#### Methods

<a id="isequal"></a>

##### isEqual()

```ts
isEqual(other: Bytes): boolean;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `other` | [`Bytes`](#bytes) |

###### Returns

`boolean`

<a id="tobase64"></a>

##### toBase64()

```ts
toBase64(): string;
```

###### Returns

`string`

<a id="tojson"></a>

##### toJSON()

```ts
toJSON(): object;
```

###### Returns

`object`

<a id="tostring"></a>

##### toString()

```ts
toString(): string;
```

###### Returns

`string`

<a id="touint8array"></a>

##### toUint8Array()

```ts
toUint8Array(): Uint8Array;
```

###### Returns

`Uint8Array`

<a id="frombase64string"></a>

##### fromBase64String()

```ts
static fromBase64String(base64: string): Bytes;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `base64` | `string` |

###### Returns

[`Bytes`](#bytes)

<a id="fromjson"></a>

##### fromJSON()

```ts
static fromJSON(json: object): Bytes;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `json` | `object` |

###### Returns

[`Bytes`](#bytes)

<a id="fromuint8array"></a>

##### fromUint8Array()

```ts
static fromUint8Array(array: Uint8Array): Bytes;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `array` | `Uint8Array` |

###### Returns

[`Bytes`](#bytes)

***

<a id="fieldpath"></a>

### FieldPath

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new FieldPath(...fieldNames: string[]): FieldPath;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`fieldNames` | `string`[] |

###### Returns

[`FieldPath`](#fieldpath)

#### Methods

<a id="isequal-2"></a>

##### isEqual()

```ts
isEqual(other: FieldPath): boolean;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `other` | [`FieldPath`](#fieldpath) |

###### Returns

`boolean`

***

<a id="geopoint"></a>

### GeoPoint

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
new GeoPoint(lat: number, lng: number): GeoPoint;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `lat` | `number` |
| `lng` | `number` |

###### Returns

[`GeoPoint`](#geopoint)

#### Accessors

<a id="latitude"></a>

##### latitude

###### Get Signature

```ts
get latitude(): number;
```

###### Returns

`number`

<a id="longitude"></a>

##### longitude

###### Get Signature

```ts
get longitude(): number;
```

###### Returns

`number`

#### Methods

<a id="isequal-4"></a>

##### isEqual()

```ts
isEqual(other: GeoPoint): boolean;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `other` | [`GeoPoint`](#geopoint) |

###### Returns

`boolean`

<a id="tojson-2"></a>

##### toJSON()

```ts
toJSON(): {
  latitude: number;
  longitude: number;
  type: string;
};
```

###### Returns

```ts
{
  latitude: number;
  longitude: number;
  type: string;
}
```

###### latitude

```ts
latitude: number;
```

###### longitude

```ts
longitude: number;
```

###### type

```ts
type: string;
```

<a id="fromjson-2"></a>

##### fromJSON()

```ts
static fromJSON(json: object): GeoPoint;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `json` | `object` |

###### Returns

[`GeoPoint`](#geopoint)

***

<a id="vectorvalue"></a>

### VectorValue

#### Methods

<a id="isequal-6"></a>

##### isEqual()

```ts
isEqual(other: VectorValue): boolean;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `other` | [`VectorValue`](#vectorvalue) |

###### Returns

`boolean`

<a id="toarray"></a>

##### toArray()

```ts
toArray(): number[];
```

###### Returns

`number`[]

<a id="tojson-4"></a>

##### toJSON()

```ts
toJSON(): object;
```

###### Returns

`object`

<a id="create"></a>

##### create()

```ts
static create(values: number[]): VectorValue;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `values` | `number`[] |

###### Returns

[`VectorValue`](#vectorvalue)

<a id="fromjson-4"></a>

##### fromJSON()

```ts
static fromJSON(json: object): VectorValue;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `json` | `object` |

###### Returns

[`VectorValue`](#vectorvalue)

## Interfaces

<a id="aggregatequerysnapshot"></a>

### AggregateQuerySnapshot

Snapshot returned by `getCountFromServer` /
`getAggregateFromServer`. `.data()` returns the computed numbers
keyed by the spec's aliases (or `{ count: number }` for the
count-only entry point).

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` *extends* `Record`\<`string`, `number` \| `null`\> | `Record`\<`string`, `number` \| `null`\> |

#### Methods

<a id="data"></a>

##### data()

```ts
data(): T;
```

###### Returns

`T`

***

<a id="collectionreference"></a>

### CollectionReference

A reference to a Firestore collection. Backend-opaque.

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `_T` | [`AuthState`](#authstate) |

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="id"></a> `id` | `readonly` | `string` |
| <a id="path"></a> `path` | `readonly` | `string` |

***

<a id="documentreference"></a>

### DocumentReference

A reference to a Firestore document. Backend-opaque.

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `_T` | [`AuthState`](#authstate) |

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="id-1"></a> `id` | `readonly` | `string` |
| <a id="path-1"></a> `path` | `readonly` | `string` |

***

<a id="documentsnapshot"></a>

### DocumentSnapshot

A point-in-time view of one document.

#### Extended by

- [`QueryDocumentSnapshot`](#querydocumentsnapshot)

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | [`AuthState`](#authstate) |

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="exists"></a> `exists` | `readonly` | `boolean` \| () => `boolean` |
| <a id="id-2"></a> `id` | `readonly` | `string` |

#### Methods

<a id="data-2"></a>

##### data()

```ts
data(): T;
```

###### Returns

`T`

***

<a id="firestore"></a>

### Firestore

Opaque sandbox handle carrying its owner via [TARGET\_SYMBOL](#target_symbol-1).

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="target_symbol"></a> `[TARGET_SYMBOL]` | `readonly` | `Target` |
| <a id="app"></a> `app?` | `readonly` | `FirebaseApp` |

***

<a id="firestoredataconverter"></a>

### FirestoreDataConverter

Pair of translators between the consumer's app model and the
underlying Firestore representation. Mirrors `firebase/firestore`'s
`FirestoreDataConverter` shape.

  - `toFirestore(model)` runs on every write (`setDoc`, `addDoc`)
    through a converted ref. Returns the `DocumentData` to send.
  - `fromFirestore(snapshot)` runs on every read (`getDoc`,
    `getDocs`, snapshot listener callback) through a converted ref.
    Receives the raw snapshot, returns the typed model.

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `AppModelType` | - |
| `DbModelType` *extends* [`AuthState`](#authstate) | [`AuthState`](#authstate) |

#### Methods

<a id="fromfirestore"></a>

##### fromFirestore()

```ts
fromFirestore(snapshot: QueryDocumentSnapshot<DbModelType>): AppModelType;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `snapshot` | [`QueryDocumentSnapshot`](#querydocumentsnapshot)\<`DbModelType`\> |

###### Returns

`AppModelType`

<a id="tofirestore"></a>

##### toFirestore()

```ts
toFirestore(modelObject: AppModelType): DbModelType;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `modelObject` | `AppModelType` |

###### Returns

`DbModelType`

***

<a id="firestoredatatooldeps"></a>

### FirestoreDataToolDeps

#### Methods

<a id="resolvedb"></a>

##### resolveDb()

```ts
resolveDb(as?: As): Firestore | Promise<Firestore>;
```

Resolver returning a `Firestore` handle. Called per-dispatch with the
op's `as` value: `'admin'` (or undefined) → an admin-bypass Firestore;
`{ uid, claims? }` → a rules-enforcing Firestore acting as that user.

The host decides the posture; the tool layer does NOT enforce it. A sandbox
resolver may default to admin (rules bypass is the point of seeding), but a
resolver wired to a real backend should require an explicit identity or
confirm-gate admin writes (see the bridge's prod confirm-policy).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `as?` | [`As`](#as) |

###### Returns

[`Firestore`](#firestore) \| `Promise`\<[`Firestore`](#firestore)\>

***

<a id="firestoreinspecttooldeps"></a>

### FirestoreInspectToolDeps

#### Methods

<a id="resolvesandbox"></a>

##### resolveSandbox()

```ts
resolveSandbox(): any;
```

Resolve the sandbox whose Firestore state should be inspected.

###### Returns

`any`

***

<a id="firestoresettings"></a>

### FirestoreSettings

Client-cache/network settings `initializeFirestore` accepts but no-ops
 on sandbox targets — see the tier-1 section rationale above.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="cachesizebytes"></a> `cacheSizeBytes?` | `number` |
| <a id="experimentalautodetectlongpolling"></a> `experimentalAutoDetectLongPolling?` | `boolean` |
| <a id="experimentalforcelongpolling"></a> `experimentalForceLongPolling?` | `boolean` |
| <a id="host"></a> `host?` | `string` |
| <a id="ignoreundefinedproperties"></a> `ignoreUndefinedProperties?` | `boolean` |
| <a id="localcache"></a> `localCache?` | [`LocalCache`](#localcache-1) |
| <a id="ssl"></a> `ssl?` | `boolean` |

***

<a id="localcache-1"></a>

### LocalCache

Opaque local-cache config token accepted by [initializeFirestore](#initializefirestore)'s
 `settings.localCache`. Inert — see the tier-1 section rationale above.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="local_cache_symbol"></a> `[LOCAL_CACHE_SYMBOL]` | `readonly` | `"persistent"` \| `"memory"` |
| <a id="garbagecollector"></a> `garbageCollector?` | `readonly` | [`MemoryGarbageCollector`](#memorygarbagecollector) |
| <a id="tabmanager"></a> `tabManager?` | `readonly` | [`PersistentTabManager`](#persistenttabmanager) |

***

<a id="memorygarbagecollector"></a>

### MemoryGarbageCollector

Opaque garbage-collector config token. Inert for the same reason —
 there is no memory cache tier with GC pressure to tune.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="gc_symbol"></a> `[GC_SYMBOL]` | `readonly` | `"eager"` \| `"lru"` |

***

<a id="persistencesettings"></a>

### PersistenceSettings

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="forceownership"></a> `forceOwnership?` | `boolean` |

***

<a id="persistenttabmanager"></a>

### PersistentTabManager

Opaque tab-manager config token. Inert — persistence is always on,
 and the SharedWorker/`pyric dev` path already is the one shared
 store every tab talks to, so there is no separate multi-tab mode
 to opt into. Carries the requested kind only for debugging.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="tab_manager_symbol"></a> `[TAB_MANAGER_SYMBOL]` | `readonly` | `"single"` \| `"multiple"` |

***

<a id="query"></a>

### Query

A Firestore query (a collection ref or one with where/orderBy/limit applied).

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `_T` | [`AuthState`](#authstate) |

***

<a id="queryconstraint"></a>

### QueryConstraint

#### Methods

<a id="applysandbox"></a>

##### applySandbox()

```ts
applySandbox(q: ChainQuery): ChainQuery;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `q` | `ChainQuery` |

###### Returns

`ChainQuery`

***

<a id="querydocumentsnapshot"></a>

### QueryDocumentSnapshot

`QueryDocumentSnapshot` is a `DocumentSnapshot` known to exist —
`.data()` always returns the typed model, never `undefined`. Yielded
by `QuerySnapshot.docs` and passed to converter `fromFirestore`
callbacks. Mirrors the JS SDK's narrowing.

#### Extends

- [`DocumentSnapshot`](#documentsnapshot)\<`T`\>

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | [`AuthState`](#authstate) |

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="exists-1"></a> `exists` | `readonly` | `boolean` \| () => `boolean` |
| <a id="id-3"></a> `id` | `readonly` | `string` |

#### Methods

<a id="data-4"></a>

##### data()

```ts
data(): T;
```

###### Returns

`T`

###### Overrides

[`DocumentSnapshot`](#documentsnapshot).[`data`](#data-2)

***

<a id="querysnapshot"></a>

### QuerySnapshot

A point-in-time view of a query result.

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | [`AuthState`](#authstate) |

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="docs"></a> `docs` | `readonly` | readonly [`QueryDocumentSnapshot`](#querydocumentsnapshot)\<`T`\>[] |
| <a id="empty"></a> `empty` | `readonly` | `boolean` |
| <a id="size"></a> `size` | `readonly` | `number` |

***

<a id="setoptions"></a>

### SetOptions

Modular Web-SDK-shaped `SetOptions`. Either flag controls how `data`
combines with the existing document; passing nothing replaces the
existing doc entirely (Firestore default).

  - `{ merge: true }` — shallow-merge every top-level field in
    `data` into the existing document, preserving fields not in
    `data`. Equivalent to `firebase/firestore`'s `setDoc(ref, data,
    { merge: true })`.
  - `{ mergeFields: [...] }` — project `data` to just the listed
    top-level fields, then merge. Other fields in `data` are
    ignored; other fields in the existing doc are preserved.

`merge` and `mergeFields` are mutually exclusive; passing both is
a programming error (`mergeFields` wins on the sandbox path,
matching the JS SDK's effective behavior).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="merge"></a> `merge?` | `boolean` |
| <a id="mergefields"></a> `mergeFields?` | readonly `string`[] |

***

<a id="snapshotlistenoptions"></a>

### SnapshotListenOptions

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="includemetadatachanges"></a> `includeMetadataChanges?` | `boolean` |

***

<a id="snapshotobserver"></a>

### SnapshotObserver

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="complete"></a> `complete?` | () => `void` |
| <a id="error"></a> `error?` | (`error`: `unknown`) => `void` |
| <a id="next"></a> `next?` | (`snapshot`: `T`) => `void` |

***

<a id="userauth"></a>

### UserAuth

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="claims"></a> `claims?` | `Record`\<`string`, `unknown`\> |
| <a id="uid"></a> `uid` | `string` |

## Type Aliases

<a id="aggregatefield"></a>

### AggregateField

```ts
type AggregateField =
  | {
  kind: "count";
}
  | {
  field: string;
  kind: "sum";
}
  | {
  field: string;
  kind: "average";
};
```

Aggregate-field descriptor returned by `count()` / `sum(field)` /
`average(field)`.

***

<a id="aggregatespec"></a>

### AggregateSpec

```ts
type AggregateSpec = Record<string, AggregateField>;
```

Spec passed to `getAggregateFromServer(query, spec)`.

***

<a id="appfirestore"></a>

### AppFirestore

```ts
type AppFirestore = Firestore & {
  app: FirebaseApp;
};
```

Firestore handle returned by Firebase-shaped app overloads.

#### Type Declaration

##### app

```ts
readonly app: FirebaseApp;
```

***

<a id="as"></a>

### As

```ts
type As = "admin" | UserAuth;
```

Who a data-plane op runs as. The default (omitted, or the literal `'admin'`)
is an ADMIN write that BYPASSES rules — the right mode for sandbox seeding.
A `{ uid, claims? }` runs as that user with rules ENFORCED. The point of the
explicit literal: bypass is NAMED (`as:'admin'`), not the silent consequence
of omitting an auth field, and acting-as-a-user is named too.

***

<a id="authstate"></a>

### AuthState

```ts
type AuthState = any;
```

***

<a id="loglevel"></a>

### LogLevel

```ts
type LogLevel = "debug" | "verbose" | "info" | "warn" | "error" | "silent";
```

Mirrors `firebase/firestore`'s `LogLevel` union.

***

<a id="transaction"></a>

### Transaction

```ts
type Transaction = AuthState;
```

***

<a id="unsubscribe"></a>

### Unsubscribe()

```ts
type Unsubscribe = () => void;
```

#### Returns

`void`

***

<a id="writebatch"></a>

### WriteBatch

```ts
type WriteBatch = AuthState;
```

## Variables

<a id="target_symbol-1"></a>

### TARGET\_SYMBOL

```ts
const TARGET_SYMBOL: unique symbol;
```

Hidden property on every [Firestore](#firestore) handle. Discriminates
the sandbox backend so free functions can recover their owner.

## Functions

<a id="actingas"></a>

### actingAs()

```ts
function actingAs(sandbox: Sandbox, identity: AuthState): Firestore;
```

A Firestore handle scoped to a specific identity, for multi-user testing.

`actingAs(sandbox, { uid })` returns a `Firestore` whose ops evaluate security
rules as that user (`request.auth.uid === uid`; custom claims via `token`);
`actingAs(sandbox, null)` is the anonymous (signed-out) path. Multiple
identities over ONE sandbox share the same store, so a write by one is
delivered to another's `onSnapshot`: the basis for multi-user sync testing.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `Sandbox` |
| `identity` | `AuthState` |

#### Returns

[`Firestore`](#firestore)

#### Example

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { actingAs, doc, setDoc, onSnapshot } from 'pyric/firestore';
const sandbox = initializeSandbox();
const alice = actingAs(sandbox, { uid: 'alice' });
const bob   = actingAs(sandbox, { uid: 'bob', token: { role: 'member' } });
onSnapshot(doc(bob, 'rooms/r1'), () => {
  // fires when alice writes (same store; rules evaluated as bob)
});
await setDoc(doc(alice, 'rooms/r1'), { owner: 'alice' });
```

Thin sugar over `getFirestore(sandbox.withAuth(identity))`; the value is a
named, discoverable seam for multi-user scenarios. See
the design rationale.

***

<a id="adddoc"></a>

### addDoc()

```ts
function addDoc<T>(coll: CollectionReference<T>, data: T): Promise<DocumentReference<T>>;
```

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | `DocumentData` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `coll` | [`CollectionReference`](#collectionreference)\<`T`\> |
| `data` | `T` |

#### Returns

`Promise`\<[`DocumentReference`](#documentreference)\<`T`\>\>

***

<a id="and"></a>

### and()

```ts
function and(...filters: QueryConstraint[]): QueryConstraint;
```

AND composite. Same shape as `or()` but every inner constraint
must match. Useful inside an `or()` to combine constraints that
would otherwise be at the top level.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`filters` | [`QueryConstraint`](#queryconstraint)[] |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="arrayremove"></a>

### arrayRemove()

```ts
function arrayRemove(...values: unknown[]): FieldValueSentinel;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

#### Returns

`FieldValueSentinel`

***

<a id="arrayunion"></a>

### arrayUnion()

```ts
function arrayUnion(...values: unknown[]): FieldValueSentinel;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

#### Returns

`FieldValueSentinel`

***

<a id="average"></a>

### average()

```ts
function average(field: string): AggregateField;
```

Factory: average-of-`field` aggregate.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

[`AggregateField`](#aggregatefield)

***

<a id="clearindexeddbpersistence"></a>

### clearIndexedDbPersistence()

```ts
function clearIndexedDbPersistence(db: Firestore): Promise<void>;
```

Sandbox: actually clears the sandbox's persisted store via
`Sandbox.clearPersistence()` — the honest mapping, not a no-op. This
wipes the persisted blob (IndexedDB, or whatever backend
`enablePersistence` was configured with) while leaving in-memory
state untouched, matching `clearPersistence`'s own contract. It is
ALREADY a no-op when persistence was never enabled, so callers that
invoke this defensively at startup are safe either way.

`getFirestore(ctx)` (frozen `SandboxContext`) targets don't carry a
live `Sandbox` handle with a `clearPersistence` method reachable the
same way as a `sandbox`/`sandbox-live` target's `.sandbox` field —
both variants do, in fact, so this always has a sandbox to call into.

The real SDK requires this before Firestore starts; the sandbox's mapped
`clearPersistence()` has no such restriction.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |

#### Returns

`Promise`\<`void`\>

***

<a id="collection"></a>

### collection()

```ts
function collection(parent:
  | Firestore
  | DocumentReference<DocumentData>, ...pathSegments: string[]): CollectionReference;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `parent` | \| [`Firestore`](#firestore) \| [`DocumentReference`](#documentreference)\<`DocumentData`\> |
| ...`pathSegments` | `string`[] |

#### Returns

[`CollectionReference`](#collectionreference)

***

<a id="collectiongroup"></a>

### collectionGroup()

```ts
function collectionGroup(db: Firestore, collectionId: string): Query;
```

Cross-collection query — scans every document under every
collection whose final segment matches `collectionId`. Mirrors
`firebase/firestore`'s `collectionGroup(db, id)` shape.

Returned `Query` accepts the same `where` / `orderBy` / `limit`
constraints as any other query.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |
| `collectionId` | `string` |

#### Returns

[`Query`](#query)

***

<a id="connectfirestoreemulator"></a>

### connectFirestoreEmulator()

```ts
function connectFirestoreEmulator(
   db: Firestore,
   host: string,
   port: number,
   options?: {
  mockUserToken?:   | string
     | {
   [claim: string]: unknown;
     firebase?: {
        identities?: Record<string, string[]>;
        sign_in_provider?: string;
     };
     sub?: string;
     user_id?: string;
   };
}): void;
```

No-op in the sandbox mirror because the sandbox already runs locally.

The option shape remains source-compatible with Firebase so canonical
initialization code can call it unconditionally.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |
| `host` | `string` |
| `port` | `number` |
| `options?` | \{ `mockUserToken?`: \| `string` \| \{ \[`claim`: `string`\]: `unknown`; `firebase?`: \{ `identities?`: `Record`\<`string`, `string`[]\>; `sign_in_provider?`: `string`; \}; `sub?`: `string`; `user_id?`: `string`; \}; \} |
| `options.mockUserToken?` | \| `string` \| \{ \[`claim`: `string`\]: `unknown`; `firebase?`: \{ `identities?`: `Record`\<`string`, `string`[]\>; `sign_in_provider?`: `string`; \}; `sub?`: `string`; `user_id?`: `string`; \} |

#### Returns

`void`

***

<a id="count"></a>

### count()

```ts
function count(): AggregateField;
```

Factory: count() aggregate.

#### Returns

[`AggregateField`](#aggregatefield)

***

<a id="createfirestoredatatools"></a>

### createFirestoreDataTools()

```ts
function createFirestoreDataTools(deps: FirestoreDataToolDeps): ToolHandler<unknown, unknown>[];
```

Modular Web-SDK-shaped Firestore data tools — get, list, create,
update, delete. Each tool's `auth` arg is forwarded to the
resolver; omitted = admin mode, supplied = user mode.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `deps` | [`FirestoreDataToolDeps`](#firestoredatatooldeps) |

#### Returns

`ToolHandler`\<`unknown`, `unknown`\>[]

***

<a id="createfirestoreinspecttools"></a>

### createFirestoreInspectTools()

```ts
function createFirestoreInspectTools(deps: FirestoreInspectToolDeps): ToolHandler<unknown, unknown>[];
```

`sandbox_inspect` — the missing-tool tax this entire library
used to charge agents. Without it, debugging "why aren't my rules
working?" took 51 tool calls + 72k tokens of grepping node_modules
(recorded in CLAUDE_DEBUG_SESSION.md). With it, the same diagnosis
is one tool call:

  { rules: { source, sizeBytes, isEmpty, lint: { errors, warnings, findings } },
    documents: { totalCount, byCollection },
    events: { totalCount, recentDenials, recentRequests } }

Returns a snapshot of sandbox state — current rules, lint summary,
document census by collection, and the most-recent denials + requests
from sandbox.history(). Everything an agent needs to localize a
sandbox bug in one round-trip.

Sandbox-only. `resolveSandbox` must return the owning Sandbox.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `deps` | [`FirestoreInspectToolDeps`](#firestoreinspecttooldeps) |

#### Returns

`ToolHandler`\<`unknown`, `unknown`\>[]

***

<a id="deletedoc"></a>

### deleteDoc()

```ts
function deleteDoc(ref: DocumentReference): Promise<void>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocumentReference`](#documentreference) |

#### Returns

`Promise`\<`void`\>

***

<a id="deletefield"></a>

### deleteField()

```ts
function deleteField(): FieldValueSentinel;
```

#### Returns

`FieldValueSentinel`

***

<a id="disablenetwork"></a>

### disableNetwork()

```ts
function disableNetwork(db: Firestore): Promise<void>;
```

Sandbox: no-op success. There is no network in the sandbox — every
op is a local call into the in-memory/IndexedDB-backed store — so
there is nothing to disable. This deliberately does NOT simulate an
offline mode: queued writes still commit immediately rather than
queuing, because the sandbox cannot honestly deliver "queued until
reconnected" when there is no connection to lose in the first place.
App code that calls this to prep for flaky connectivity will not
crash, but it also will not observe write-queuing behavior.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |

#### Returns

`Promise`\<`void`\>

***

<a id="doc"></a>

### doc()

```ts
function doc<T>(parent:
  | Firestore
| CollectionReference<T>, ...pathSegments: string[]): DocumentReference<T>;
```

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | `DocumentData` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `parent` | \| [`Firestore`](#firestore) \| [`CollectionReference`](#collectionreference)\<`T`\> |
| ...`pathSegments` | `string`[] |

#### Returns

[`DocumentReference`](#documentreference)\<`T`\>

***

<a id="documentid"></a>

### documentId()

```ts
function documentId(): FieldPath;
```

#### Returns

[`FieldPath`](#fieldpath)

***

<a id="enableindexeddbpersistence"></a>

### enableIndexedDbPersistence()

```ts
function enableIndexedDbPersistence(db: Firestore, persistenceSettings?: PersistenceSettings): Promise<void>;
```

Sandbox: no-op success. The sandbox's default persistence (IndexedDB
on the SharedWorker/serve path, or whatever backend `enablePersistence`
was configured with) already caches every write — this call has
nothing left to enable. Resolves immediately.

Unlike the real SDK, this does NOT reject with `'failed-precondition'`
when called after other Firestore ops have already run. The guard
exists in the real SDK to protect an actual cache-initialization
race; the sandbox has no such race (there's no cache to initialize),
so enforcing the same restriction would only make app code that
calls this defensively at startup fail for no local reason.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |
| `persistenceSettings?` | [`PersistenceSettings`](#persistencesettings) |

#### Returns

`Promise`\<`void`\>

***

<a id="enablemultitabindexeddbpersistence"></a>

### enableMultiTabIndexedDbPersistence()

```ts
function enableMultiTabIndexedDbPersistence(db: Firestore): Promise<void>;
```

Sandbox: no-op success, same rationale as [enableIndexedDbPersistence](#enableindexeddbpersistence).
Multi-tab coordination is meaningless here too: the sandbox's
SharedWorker path already IS the single shared store every tab talks
to, so there's no separate "multi-tab" mode to opt into.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |

#### Returns

`Promise`\<`void`\>

***

<a id="enablenetwork"></a>

### enableNetwork()

```ts
function enableNetwork(db: Firestore): Promise<void>;
```

Sandbox: no-op success, symmetric with [disableNetwork](#disablenetwork) — since
network was never disabled locally, there is nothing to re-enable.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |

#### Returns

`Promise`\<`void`\>

***

<a id="endat"></a>

### endAt()

#### Call Signature

```ts
function endAt(snapshot: DocumentSnapshot): QueryConstraint;
```

End the query at the document whose ordered field values match
 the cursor. Inclusive — the document at the cursor IS included.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `snapshot` | [`DocumentSnapshot`](#documentsnapshot) |

##### Returns

[`QueryConstraint`](#queryconstraint)

#### Call Signature

```ts
function endAt(...values: unknown[]): QueryConstraint;
```

End the query at the document whose ordered field values match
 the cursor. Inclusive — the document at the cursor IS included.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

##### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="endbefore"></a>

### endBefore()

#### Call Signature

```ts
function endBefore(snapshot: DocumentSnapshot): QueryConstraint;
```

Same as `endAt`, but EXCLUDES the document at the cursor — the
 result ends at the prior ordered position.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `snapshot` | [`DocumentSnapshot`](#documentsnapshot) |

##### Returns

[`QueryConstraint`](#queryconstraint)

#### Call Signature

```ts
function endBefore(...values: unknown[]): QueryConstraint;
```

Same as `endAt`, but EXCLUDES the document at the cursor — the
 result ends at the prior ordered position.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

##### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="getadminfirestore"></a>

### getAdminFirestore()

#### Call Signature

```ts
function getAdminFirestore(sandbox: Sandbox): Firestore;
```

Construct a **rules-bypassing** sandbox Firestore handle — the Pyric
Studio admin lens (Gap #2). Every modular op issued against the returned
handle (`getDoc`/`getDocs`/`setDoc`/`updateDoc`/`deleteDoc`/`addDoc`/
`count`/`writeBatch`/`runTransaction`) SKIPS security-rule evaluation and
is treated as ALLOW, while still going through the same store + emitting
the same events + waking the same listeners. This is the modular sibling
of the path-string `sandbox.admin.*` bypass; it reuses the underlying
`LocalEnvironment` bypass execution path (the `bypassRules` op flag),
not a parallel reimplementation.

Sandbox-only. There is no prod analog (you cannot bypass deployed
security rules from a client), so this overload set accepts only a
`Sandbox`, `SandboxContext`, or a privately-associated `FirebaseApp`.
Admin ops are identity-agnostic (rules are off), so the
handle is a FROZEN `sandbox` target: it does not track
`sandbox.currentUser`.

Intended for Studio's "edit anything as admin" surfaces (F2) and the
serve worker's `{ mode: 'admin' }` auth lens. For rules-applied
impersonation ("act as this user"), use `getFirestore(sandbox.withAuth({
uid }))` instead.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `Sandbox` |

##### Returns

[`Firestore`](#firestore)

##### Example

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore, doc, setDoc } from 'pyric/firestore';
const sandbox = initializeSandbox();
const adminDb = getAdminFirestore(sandbox);
await setDoc(doc(adminDb, 'locked/x'), { a: 1 }); // bypasses rules
```

#### Call Signature

```ts
function getAdminFirestore(ctx: SandboxContext): Firestore;
```

Construct a **rules-bypassing** sandbox Firestore handle — the Pyric
Studio admin lens (Gap #2). Every modular op issued against the returned
handle (`getDoc`/`getDocs`/`setDoc`/`updateDoc`/`deleteDoc`/`addDoc`/
`count`/`writeBatch`/`runTransaction`) SKIPS security-rule evaluation and
is treated as ALLOW, while still going through the same store + emitting
the same events + waking the same listeners. This is the modular sibling
of the path-string `sandbox.admin.*` bypass; it reuses the underlying
`LocalEnvironment` bypass execution path (the `bypassRules` op flag),
not a parallel reimplementation.

Sandbox-only. There is no prod analog (you cannot bypass deployed
security rules from a client), so this overload set accepts only a
`Sandbox`, `SandboxContext`, or a privately-associated `FirebaseApp`.
Admin ops are identity-agnostic (rules are off), so the
handle is a FROZEN `sandbox` target: it does not track
`sandbox.currentUser`.

Intended for Studio's "edit anything as admin" surfaces (F2) and the
serve worker's `{ mode: 'admin' }` auth lens. For rules-applied
impersonation ("act as this user"), use `getFirestore(sandbox.withAuth({
uid }))` instead.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ctx` | `SandboxContext` |

##### Returns

[`Firestore`](#firestore)

##### Example

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore, doc, setDoc } from 'pyric/firestore';
const sandbox = initializeSandbox();
const adminDb = getAdminFirestore(sandbox);
await setDoc(doc(adminDb, 'locked/x'), { a: 1 }); // bypasses rules
```

#### Call Signature

```ts
function getAdminFirestore(app: FirebaseApp): Firestore;
```

Construct a **rules-bypassing** sandbox Firestore handle — the Pyric
Studio admin lens (Gap #2). Every modular op issued against the returned
handle (`getDoc`/`getDocs`/`setDoc`/`updateDoc`/`deleteDoc`/`addDoc`/
`count`/`writeBatch`/`runTransaction`) SKIPS security-rule evaluation and
is treated as ALLOW, while still going through the same store + emitting
the same events + waking the same listeners. This is the modular sibling
of the path-string `sandbox.admin.*` bypass; it reuses the underlying
`LocalEnvironment` bypass execution path (the `bypassRules` op flag),
not a parallel reimplementation.

Sandbox-only. There is no prod analog (you cannot bypass deployed
security rules from a client), so this overload set accepts only a
`Sandbox`, `SandboxContext`, or a privately-associated `FirebaseApp`.
Admin ops are identity-agnostic (rules are off), so the
handle is a FROZEN `sandbox` target: it does not track
`sandbox.currentUser`.

Intended for Studio's "edit anything as admin" surfaces (F2) and the
serve worker's `{ mode: 'admin' }` auth lens. For rules-applied
impersonation ("act as this user"), use `getFirestore(sandbox.withAuth({
uid }))` instead.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `app` | `FirebaseApp` |

##### Returns

[`Firestore`](#firestore)

##### Example

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore, doc, setDoc } from 'pyric/firestore';
const sandbox = initializeSandbox();
const adminDb = getAdminFirestore(sandbox);
await setDoc(doc(adminDb, 'locked/x'), { a: 1 }); // bypasses rules
```

***

<a id="getaggregatefromserver"></a>

### getAggregateFromServer()

```ts
function getAggregateFromServer<S>(source:
  | Query<DocumentData>
| CollectionReference<DocumentData>, spec: S): Promise<AggregateQuerySnapshot<{ [K in string | number | symbol]: number }>>;
```

Run a multi-field aggregate against the query. Spec entries are
keyed by caller-chosen aliases; the returned snapshot's `.data()`
uses the same keys.

The sandbox target dispatches straight into the chainable adapter.

#### Type Parameters

| Type Parameter |
| :------ |
| `S` *extends* [`AggregateSpec`](#aggregatespec) |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | \| [`Query`](#query)\<`DocumentData`\> \| [`CollectionReference`](#collectionreference)\<`DocumentData`\> |
| `spec` | `S` |

#### Returns

`Promise`\<[`AggregateQuerySnapshot`](#aggregatequerysnapshot)\<\{ \[K in string \| number \| symbol\]: number \}\>\>

***

<a id="getcountfromserver"></a>

### getCountFromServer()

```ts
function getCountFromServer(source:
  | Query<DocumentData>
  | CollectionReference<DocumentData>): Promise<AggregateQuerySnapshot<{
  count: number;
}>>;
```

Count documents matching the query. Returns a snapshot whose
`.data()` yields `{ count: N }` — same shape `firebase/firestore`'s
`getCountFromServer` produces.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | \| [`Query`](#query)\<`DocumentData`\> \| [`CollectionReference`](#collectionreference)\<`DocumentData`\> |

#### Returns

`Promise`\<[`AggregateQuerySnapshot`](#aggregatequerysnapshot)\<\{
  `count`: `number`;
\}\>\>

***

<a id="getdoc"></a>

### getDoc()

```ts
function getDoc<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>>;
```

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | `DocumentData` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocumentReference`](#documentreference)\<`T`\> |

#### Returns

`Promise`\<[`DocumentSnapshot`](#documentsnapshot)\<`T`\>\>

***

<a id="getdocfromcache"></a>

### getDocFromCache()

```ts
function getDocFromCache<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>>;
```

Sandbox: delegates to [getDoc](#getdoc). Real Firebase THROWS
`'unavailable'` here on a cache miss (nothing local matches the
ref); pyric never misses — the local store always has whatever is
there — so this never throws for that reason. Documented divergence,
not a claim of parity.

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | `DocumentData` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocumentReference`](#documentreference)\<`T`\> |

#### Returns

`Promise`\<[`DocumentSnapshot`](#documentsnapshot)\<`T`\>\>

***

<a id="getdocfromserver"></a>

### getDocFromServer()

```ts
function getDocFromServer<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>>;
```

Sandbox: delegates to [getDoc](#getdoc). The sandbox store IS the
authoritative, always-fresh source — there is no separate server
round-trip to force, so "from server" and the default read are the
same honest thing.

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | `DocumentData` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocumentReference`](#documentreference)\<`T`\> |

#### Returns

`Promise`\<[`DocumentSnapshot`](#documentsnapshot)\<`T`\>\>

***

<a id="getdocs"></a>

### getDocs()

```ts
function getDocs<T>(query: Query<T>): Promise<QuerySnapshot<T>>;
```

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | `DocumentData` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `query` | [`Query`](#query)\<`T`\> |

#### Returns

`Promise`\<[`QuerySnapshot`](#querysnapshot)\<`T`\>\>

***

<a id="getdocsfromcache"></a>

### getDocsFromCache()

```ts
function getDocsFromCache<T>(query: Query<T>): Promise<QuerySnapshot<T>>;
```

Query-plural form of [getDocFromCache](#getdocfromcache) — same cache-miss divergence.

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | `DocumentData` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `query` | [`Query`](#query)\<`T`\> |

#### Returns

`Promise`\<[`QuerySnapshot`](#querysnapshot)\<`T`\>\>

***

<a id="getdocsfromserver"></a>

### getDocsFromServer()

```ts
function getDocsFromServer<T>(query: Query<T>): Promise<QuerySnapshot<T>>;
```

Query-plural form of [getDocFromServer](#getdocfromserver).

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | `DocumentData` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `query` | [`Query`](#query)\<`T`\> |

#### Returns

`Promise`\<[`QuerySnapshot`](#querysnapshot)\<`T`\>\>

***

<a id="getfirestore"></a>

### getFirestore()

#### Call Signature

```ts
function getFirestore(ctx: SandboxContext): Firestore;
```

Construct a Firestore handle. Three overloads dispatch by the
input's shape:

  - `SandboxContext` → sandbox-backed Firestore with a frozen
    identity (the ctx's `auth` chosen at `getFirestore` time). Best
    for runner/test code that names identity explicitly per
    scenario.
  - `Sandbox` → sandbox-backed Firestore that reads
    `sandbox.currentUser` per-call. Best for app code that drives
    identity through `pyric/auth` — every Firestore op evaluates
    rules under whatever user is currently signed in.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ctx` | `SandboxContext` |

##### Returns

[`Firestore`](#firestore)

##### Example

```ts
// Sandbox, frozen identity (runner / explicit tests).
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, doc, setDoc } from 'pyric/firestore';
const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

// Sandbox, live identity (app code paired with pyric/auth).
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInAnonymously } from 'pyric/auth';
const sandbox = initializeSandbox();
const auth = getAuth(sandbox);
const db = getFirestore(sandbox); // reads sandbox.currentUser per op
await signInAnonymously(auth);    // subsequent db ops use the new identity

// Canonical imports are swapped to this mirror in a sandbox process.
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
const app = initializeApp({ projectId: 'demo-project' });
const db = getFirestore(app);
```

#### Call Signature

```ts
function getFirestore(sandbox: Sandbox): Firestore;
```

Construct a Firestore handle. Three overloads dispatch by the
input's shape:

  - `SandboxContext` → sandbox-backed Firestore with a frozen
    identity (the ctx's `auth` chosen at `getFirestore` time). Best
    for runner/test code that names identity explicitly per
    scenario.
  - `Sandbox` → sandbox-backed Firestore that reads
    `sandbox.currentUser` per-call. Best for app code that drives
    identity through `pyric/auth` — every Firestore op evaluates
    rules under whatever user is currently signed in.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `Sandbox` |

##### Returns

[`Firestore`](#firestore)

##### Example

```ts
// Sandbox, frozen identity (runner / explicit tests).
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, doc, setDoc } from 'pyric/firestore';
const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

// Sandbox, live identity (app code paired with pyric/auth).
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInAnonymously } from 'pyric/auth';
const sandbox = initializeSandbox();
const auth = getAuth(sandbox);
const db = getFirestore(sandbox); // reads sandbox.currentUser per op
await signInAnonymously(auth);    // subsequent db ops use the new identity

// Canonical imports are swapped to this mirror in a sandbox process.
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
const app = initializeApp({ projectId: 'demo-project' });
const db = getFirestore(app);
```

#### Call Signature

```ts
function getFirestore(app: FirebaseApp): AppFirestore;
```

Construct a Firestore handle. Three overloads dispatch by the
input's shape:

  - `SandboxContext` → sandbox-backed Firestore with a frozen
    identity (the ctx's `auth` chosen at `getFirestore` time). Best
    for runner/test code that names identity explicitly per
    scenario.
  - `Sandbox` → sandbox-backed Firestore that reads
    `sandbox.currentUser` per-call. Best for app code that drives
    identity through `pyric/auth` — every Firestore op evaluates
    rules under whatever user is currently signed in.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `app` | `FirebaseApp` |

##### Returns

[`AppFirestore`](#appfirestore)

##### Example

```ts
// Sandbox, frozen identity (runner / explicit tests).
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, doc, setDoc } from 'pyric/firestore';
const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

// Sandbox, live identity (app code paired with pyric/auth).
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInAnonymously } from 'pyric/auth';
const sandbox = initializeSandbox();
const auth = getAuth(sandbox);
const db = getFirestore(sandbox); // reads sandbox.currentUser per op
await signInAnonymously(auth);    // subsequent db ops use the new identity

// Canonical imports are swapped to this mirror in a sandbox process.
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
const app = initializeApp({ projectId: 'demo-project' });
const db = getFirestore(app);
```

#### Call Signature

```ts
function getFirestore(): AppFirestore;
```

Construct a Firestore handle. Three overloads dispatch by the
input's shape:

  - `SandboxContext` → sandbox-backed Firestore with a frozen
    identity (the ctx's `auth` chosen at `getFirestore` time). Best
    for runner/test code that names identity explicitly per
    scenario.
  - `Sandbox` → sandbox-backed Firestore that reads
    `sandbox.currentUser` per-call. Best for app code that drives
    identity through `pyric/auth` — every Firestore op evaluates
    rules under whatever user is currently signed in.

##### Returns

[`AppFirestore`](#appfirestore)

##### Example

```ts
// Sandbox, frozen identity (runner / explicit tests).
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, doc, setDoc } from 'pyric/firestore';
const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

// Sandbox, live identity (app code paired with pyric/auth).
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInAnonymously } from 'pyric/auth';
const sandbox = initializeSandbox();
const auth = getAuth(sandbox);
const db = getFirestore(sandbox); // reads sandbox.currentUser per op
await signInAnonymously(auth);    // subsequent db ops use the new identity

// Canonical imports are swapped to this mirror in a sandbox process.
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
const app = initializeApp({ projectId: 'demo-project' });
const db = getFirestore(app);
```

#### Call Signature

```ts
function getFirestore(target?: any): Firestore;
```

Construct a Firestore handle. Three overloads dispatch by the
input's shape:

  - `SandboxContext` → sandbox-backed Firestore with a frozen
    identity (the ctx's `auth` chosen at `getFirestore` time). Best
    for runner/test code that names identity explicitly per
    scenario.
  - `Sandbox` → sandbox-backed Firestore that reads
    `sandbox.currentUser` per-call. Best for app code that drives
    identity through `pyric/auth` — every Firestore op evaluates
    rules under whatever user is currently signed in.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `target?` | `any` |

##### Returns

[`Firestore`](#firestore)

##### Example

```ts
// Sandbox, frozen identity (runner / explicit tests).
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, doc, setDoc } from 'pyric/firestore';
const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

// Sandbox, live identity (app code paired with pyric/auth).
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInAnonymously } from 'pyric/auth';
const sandbox = initializeSandbox();
const auth = getAuth(sandbox);
const db = getFirestore(sandbox); // reads sandbox.currentUser per op
await signInAnonymously(auth);    // subsequent db ops use the new identity

// Canonical imports are swapped to this mirror in a sandbox process.
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
const app = initializeApp({ projectId: 'demo-project' });
const db = getFirestore(app);
```

***

<a id="increment"></a>

### increment()

```ts
function increment(n: number): FieldValueSentinel;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

`FieldValueSentinel`

***

<a id="initializefirestore"></a>

### initializeFirestore()

```ts
function initializeFirestore(
   app: any,
   _settings?: FirestoreSettings,
   _databaseId?: string): Firestore;
```

Delegates to [getFirestore](#getfirestore) and returns the same handle. Accepts
the `settings` argument (so the explicit-init pattern app code commonly
writes — `initializeFirestore(app, { localCache: persistentLocalCache(...) } )`
— no longer crashes at import) but no-ops the cache/network settings:
persistence is already the sandbox default, so there is nothing left to
configure into existence.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `app` | `any` |
| `_settings?` | [`FirestoreSettings`](#firestoresettings) |
| `_databaseId?` | `string` |

#### Returns

[`Firestore`](#firestore)

***

<a id="limit"></a>

### limit()

```ts
function limit(n: number): QueryConstraint;
```

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

Limit the query to the LAST `n` documents in the ordered result.
Requires at least one `orderBy` on the query (production-aligned —
the simulator throws at execute time without one).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="memoryeagergarbagecollector"></a>

### memoryEagerGarbageCollector()

```ts
function memoryEagerGarbageCollector(): MemoryGarbageCollector;
```

Inert config token accepted by [memoryLocalCache](#memorylocalcache)'s `garbageCollector`.

#### Returns

[`MemoryGarbageCollector`](#memorygarbagecollector)

***

<a id="memorylocalcache"></a>

### memoryLocalCache()

```ts
function memoryLocalCache(settings?: {
  garbageCollector?: MemoryGarbageCollector;
}): LocalCache;
```

Inert config token — the memory-cache counterpart of [persistentLocalCache](#persistentlocalcache).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `settings?` | \{ `garbageCollector?`: [`MemoryGarbageCollector`](#memorygarbagecollector); \} |
| `settings.garbageCollector?` | [`MemoryGarbageCollector`](#memorygarbagecollector) |

#### Returns

[`LocalCache`](#localcache-1)

***

<a id="memorylrugarbagecollector"></a>

### memoryLruGarbageCollector()

```ts
function memoryLruGarbageCollector(_settings?: {
  cacheSizeBytes?: number;
}): MemoryGarbageCollector;
```

Inert config token accepted by [memoryLocalCache](#memorylocalcache)'s `garbageCollector`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `_settings?` | \{ `cacheSizeBytes?`: `number`; \} |
| `_settings.cacheSizeBytes?` | `number` |

#### Returns

[`MemoryGarbageCollector`](#memorygarbagecollector)

***

<a id="onsnapshot"></a>

### onSnapshot()

#### Call Signature

```ts
function onSnapshot<T>(
   ref: T,
   observerOrNext:
  | SnapshotObserver<unknown>
  | (snap: unknown) => void,
   errorOrNothing?: (error: unknown) => void): Unsubscribe;
```

##### Type Parameters

| Type Parameter |
| :------ |
| `T` *extends* \| [`DocumentReference`](#documentreference)\<`DocumentData`\> \| [`Query`](#query)\<`DocumentData`\> |

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | `T` |
| `observerOrNext` | \| [`SnapshotObserver`](#snapshotobserver)\<`unknown`\> \| (`snap`: `unknown`) => `void` |
| `errorOrNothing?` | (`error`: `unknown`) => `void` |

##### Returns

[`Unsubscribe`](#unsubscribe)

#### Call Signature

```ts
function onSnapshot<T>(
   ref: T,
   options: SnapshotListenOptions,
   observerOrNext:
  | SnapshotObserver<unknown>
  | (snap: unknown) => void,
   errorOrNothing?: (error: unknown) => void): Unsubscribe;
```

##### Type Parameters

| Type Parameter |
| :------ |
| `T` *extends* \| [`DocumentReference`](#documentreference)\<`DocumentData`\> \| [`Query`](#query)\<`DocumentData`\> |

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | `T` |
| `options` | [`SnapshotListenOptions`](#snapshotlistenoptions) |
| `observerOrNext` | \| [`SnapshotObserver`](#snapshotobserver)\<`unknown`\> \| (`snap`: `unknown`) => `void` |
| `errorOrNothing?` | (`error`: `unknown`) => `void` |

##### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="onsnapshotsinsync"></a>

### onSnapshotsInSync()

```ts
function onSnapshotsInSync(db: Firestore, observerOrCallback:
  | () => void
  | {
  complete?: () => void;
  error?: (error: unknown) => void;
  next?: () => void;
}): Unsubscribe;
```

Sandbox: fires the callback once the current snapshot-delivery
microtask queue settles — the closest honest approximation of "every
active listener has delivered its latest state" available without a
true cross-listener sync signal (the sandbox doesn't track one).
This is NOT the real SDK's guarantee (which is scoped to actual
server round-trips); it is scoped to local delivery only.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |
| `observerOrCallback` | \| () => `void` \| \{ `complete?`: () => `void`; `error?`: (`error`: `unknown`) => `void`; `next?`: () => `void`; \} |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="or"></a>

### or()

```ts
function or(...filters: QueryConstraint[]): QueryConstraint;
```

OR composite — at least one of the inner constraints must match.
Each argument must itself be a filter constraint (`where()`, or
nested `or()` / `and()`); passing `orderBy()` or `limit()` here is
a type error at runtime.

Mirrors `firebase/firestore`'s `or(...filters)` shape.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`filters` | [`QueryConstraint`](#queryconstraint)[] |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="orderby"></a>

### orderBy()

```ts
function orderBy(field: string | FieldPath, direction?: OrderDirection): QueryConstraint;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` \| [`FieldPath`](#fieldpath) |
| `direction?` | `OrderDirection` |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="persistentlocalcache"></a>

### persistentLocalCache()

```ts
function persistentLocalCache(settings?: {
  cacheSizeBytes?: number;
  tabManager?: PersistentTabManager;
}): LocalCache;
```

Inert config token. Real Firebase uses this to select an on-disk,
persistent IndexedDB cache tier; the sandbox has no separate cache
tier — persistence is already the default — so this just returns a
tagged token `initializeFirestore` can accept without crashing.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `settings?` | \{ `cacheSizeBytes?`: `number`; `tabManager?`: [`PersistentTabManager`](#persistenttabmanager); \} |
| `settings.cacheSizeBytes?` | `number` |
| `settings.tabManager?` | [`PersistentTabManager`](#persistenttabmanager) |

#### Returns

[`LocalCache`](#localcache-1)

***

<a id="persistentmultipletabmanager"></a>

### persistentMultipleTabManager()

```ts
function persistentMultipleTabManager(): PersistentTabManager;
```

Inert config token accepted by [persistentLocalCache](#persistentlocalcache)'s `tabManager`.

#### Returns

[`PersistentTabManager`](#persistenttabmanager)

***

<a id="persistentsingletabmanager"></a>

### persistentSingleTabManager()

```ts
function persistentSingleTabManager(_settings?: {
  forceOwnership?: boolean;
}): PersistentTabManager;
```

Inert config token accepted by [persistentLocalCache](#persistentlocalcache)'s `tabManager`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `_settings?` | \{ `forceOwnership?`: `boolean`; \} |
| `_settings.forceOwnership?` | `boolean` |

#### Returns

[`PersistentTabManager`](#persistenttabmanager)

***

<a id="query-1"></a>

### query()

```ts
function query<T>(source:
  | CollectionReference<T>
| Query<T>, ...constraints: QueryConstraint[]): Query<T>;
```

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | `DocumentData` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | \| [`CollectionReference`](#collectionreference)\<`T`\> \| [`Query`](#query)\<`T`\> |
| ...`constraints` | [`QueryConstraint`](#queryconstraint)[] |

#### Returns

[`Query`](#query)\<`T`\>

***

<a id="queryequal"></a>

### queryEqual()

```ts
function queryEqual(a: Query, b: Query): boolean;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `a` | [`Query`](#query) |
| `b` | [`Query`](#query) |

#### Returns

`boolean`

***

<a id="refequal"></a>

### refEqual()

```ts
function refEqual(a: DocumentReference, b: DocumentReference): boolean;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `a` | [`DocumentReference`](#documentreference) |
| `b` | [`DocumentReference`](#documentreference) |

#### Returns

`boolean`

***

<a id="runtransaction"></a>

### runTransaction()

```ts
function runTransaction<R>(db: Firestore, fn: (tx: ChainTransaction) => R | Promise<R>): Promise<R>;
```

#### Type Parameters

| Type Parameter |
| :------ |
| `R` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |
| `fn` | (`tx`: `ChainTransaction`) => `R` \| `Promise`\<`R`\> |

#### Returns

`Promise`\<`R`\>

***

<a id="servertimestamp"></a>

### serverTimestamp()

```ts
function serverTimestamp(): FieldValueSentinel;
```

#### Returns

`FieldValueSentinel`

***

<a id="setdoc"></a>

### setDoc()

```ts
function setDoc<T>(
   ref: DocumentReference<T>,
   data: T,
options?: SetOptions): Promise<void>;
```

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` | `DocumentData` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocumentReference`](#documentreference)\<`T`\> |
| `data` | `T` |
| `options?` | [`SetOptions`](#setoptions) |

#### Returns

`Promise`\<`void`\>

***

<a id="setloglevel"></a>

### setLogLevel()

```ts
function setLogLevel(logLevel: LogLevel): void;
```

Accepted no-op: the sandbox has no modular-SDK-style logger to wire
a level into (it uses host-level `console` logging directly, gated
by `pyric dev`'s own flags, not this call). Exists purely so app
code that calls this defensively at startup doesn't crash on a
missing export.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `logLevel` | [`LogLevel`](#loglevel) |

#### Returns

`void`

***

<a id="snapshotequal"></a>

### snapshotEqual()

```ts
function snapshotEqual(a:
  | DocumentSnapshot<DocumentData>
  | QuerySnapshot<DocumentData>, b:
  | DocumentSnapshot<DocumentData>
  | QuerySnapshot<DocumentData>): boolean;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `a` | \| [`DocumentSnapshot`](#documentsnapshot)\<`DocumentData`\> \| [`QuerySnapshot`](#querysnapshot)\<`DocumentData`\> |
| `b` | \| [`DocumentSnapshot`](#documentsnapshot)\<`DocumentData`\> \| [`QuerySnapshot`](#querysnapshot)\<`DocumentData`\> |

#### Returns

`boolean`

***

<a id="startafter"></a>

### startAfter()

#### Call Signature

```ts
function startAfter(snapshot: DocumentSnapshot): QueryConstraint;
```

Same as `startAt`, but EXCLUDES the document at the cursor — the
 result starts at the next ordered position.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `snapshot` | [`DocumentSnapshot`](#documentsnapshot) |

##### Returns

[`QueryConstraint`](#queryconstraint)

#### Call Signature

```ts
function startAfter(...values: unknown[]): QueryConstraint;
```

Same as `startAt`, but EXCLUDES the document at the cursor — the
 result starts at the next ordered position.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

##### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="startat"></a>

### startAt()

#### Call Signature

```ts
function startAt(snapshot: DocumentSnapshot): QueryConstraint;
```

Start the query at the document whose ordered field values match
the cursor. Inclusive — the document at the cursor IS included in
the result. Two overloads:

  `startAt(snapshot)` — values come from `snapshot.data()` indexed
    by the query's orderBy fields.
  `startAt(...values)` — explicit positional values (one per
    orderBy clause).

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `snapshot` | [`DocumentSnapshot`](#documentsnapshot) |

##### Returns

[`QueryConstraint`](#queryconstraint)

#### Call Signature

```ts
function startAt(...values: unknown[]): QueryConstraint;
```

Start the query at the document whose ordered field values match
the cursor. Inclusive — the document at the cursor IS included in
the result. Two overloads:

  `startAt(snapshot)` — values come from `snapshot.data()` indexed
    by the query's orderBy fields.
  `startAt(...values)` — explicit positional values (one per
    orderBy clause).

##### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

##### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="sum"></a>

### sum()

```ts
function sum(field: string): AggregateField;
```

Factory: sum-of-`field` aggregate.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

[`AggregateField`](#aggregatefield)

***

<a id="terminate"></a>

### terminate()

```ts
function terminate(db: Firestore): Promise<void>;
```

Sandbox: genuinely tears the target down by calling
`Sandbox.dispose()` — NOT a pure no-op like the rest of this family.
`dispose()` tears down listener registries on the sandbox's
environment without replacing it (idempotent, doesn't touch data).
This is the honest mapping of "terminate this Firestore instance":
a real app that calls `terminate(db)` expects listeners to stop and
the instance to be unusable for further meaningful work, and
`dispose()` delivers exactly that for the sandbox.

Caveat: `dispose()` operates on the whole `Sandbox`, not a
Firestore-only slice of it — if `pyric/database` or `pyric/storage`
share the same `Sandbox`, their listener registries are torn down
too. This differs from the real SDK, where `terminate()` only
affects the one `Firestore` instance. Documented divergence.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |

#### Returns

`Promise`\<`void`\>

***

<a id="updatedoc"></a>

### updateDoc()

```ts
function updateDoc(ref: DocumentReference, data: DocumentData): Promise<void>;
```

`updateDoc` does NOT run the converter. Matches `firebase/firestore`'s
Web SDK shape — partial updates can target any subset of fields, so
a translator built around a full `AppModelType` would be a type-shape
mismatch. Use the underlying `DocumentData` view (`withConverter(ref,
null)`) for typed-and-untyped mixed access if you need both styles
against the same path.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocumentReference`](#documentreference) |
| `data` | `DocumentData` |

#### Returns

`Promise`\<`void`\>

***

<a id="vector"></a>

### vector()

```ts
function vector(values?: number[]): VectorValue;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `values?` | `number`[] |

#### Returns

[`VectorValue`](#vectorvalue)

***

<a id="waitforpendingwrites"></a>

### waitForPendingWrites()

```ts
function waitForPendingWrites(db: Firestore): Promise<void>;
```

Sandbox: resolves immediately. The real SDK's version waits for
queued writes to reach the server; the sandbox has no server to wait
on — every write it accepts is already committed to the local store
by the time the write's own promise resolves, so by the time this is
called there are, honestly, never any writes still pending a round
trip.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |

#### Returns

`Promise`\<`void`\>

***

<a id="where"></a>

### where()

```ts
function where(
   field: string | FieldPath,
   op: WhereFilterOp,
   value: unknown): QueryConstraint;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` \| [`FieldPath`](#fieldpath) |
| `op` | `WhereFilterOp` |
| `value` | `unknown` |

#### Returns

[`QueryConstraint`](#queryconstraint)

***

<a id="withconverter"></a>

### withConverter()

#### Call Signature

```ts
function withConverter<AppModel, DbModel>(ref: DocumentReference<DocumentData>, converter: FirestoreDataConverter<AppModel, DbModel>): DocumentReference<AppModel>;
```

##### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `AppModel` | - |
| `DbModel` *extends* `DocumentData` | `DocumentData` |

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocumentReference`](#documentreference)\<`DocumentData`\> |
| `converter` | [`FirestoreDataConverter`](#firestoredataconverter)\<`AppModel`, `DbModel`\> |

##### Returns

[`DocumentReference`](#documentreference)\<`AppModel`\>

#### Call Signature

```ts
function withConverter(ref: DocumentReference<unknown>, converter: null): DocumentReference<DocumentData>;
```

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocumentReference`](#documentreference)\<`unknown`\> |
| `converter` | `null` |

##### Returns

[`DocumentReference`](#documentreference)\<`DocumentData`\>

#### Call Signature

```ts
function withConverter<AppModel, DbModel>(ref: CollectionReference<DocumentData>, converter: FirestoreDataConverter<AppModel, DbModel>): CollectionReference<AppModel>;
```

##### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `AppModel` | - |
| `DbModel` *extends* `DocumentData` | `DocumentData` |

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`CollectionReference`](#collectionreference)\<`DocumentData`\> |
| `converter` | [`FirestoreDataConverter`](#firestoredataconverter)\<`AppModel`, `DbModel`\> |

##### Returns

[`CollectionReference`](#collectionreference)\<`AppModel`\>

#### Call Signature

```ts
function withConverter(ref: CollectionReference<unknown>, converter: null): CollectionReference<DocumentData>;
```

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`CollectionReference`](#collectionreference)\<`unknown`\> |
| `converter` | `null` |

##### Returns

[`CollectionReference`](#collectionreference)\<`DocumentData`\>

#### Call Signature

```ts
function withConverter<AppModel, DbModel>(q: Query<DocumentData>, converter: FirestoreDataConverter<AppModel, DbModel>): Query<AppModel>;
```

##### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `AppModel` | - |
| `DbModel` *extends* `DocumentData` | `DocumentData` |

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `q` | [`Query`](#query)\<`DocumentData`\> |
| `converter` | [`FirestoreDataConverter`](#firestoredataconverter)\<`AppModel`, `DbModel`\> |

##### Returns

[`Query`](#query)\<`AppModel`\>

#### Call Signature

```ts
function withConverter(q: Query<unknown>, converter: null): Query<DocumentData>;
```

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `q` | [`Query`](#query)\<`unknown`\> |
| `converter` | `null` |

##### Returns

[`Query`](#query)\<`DocumentData`\>

***

<a id="writebatch-1"></a>

### writeBatch()

```ts
function writeBatch(db: Firestore): ChainWriteBatch;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`Firestore`](#firestore) |

#### Returns

`ChainWriteBatch`

## References

<a id="documentdata"></a>

### DocumentData

Renames and re-exports [AuthState](#authstate)

***

<a id="fieldvalue"></a>

### FieldValue

Renames and re-exports [AuthState](#authstate)

***

<a id="fieldvaluesentinel"></a>

### FieldValueSentinel

Renames and re-exports [AuthState](#authstate)

***

<a id="lintresult"></a>

### LintResult

Renames and re-exports [AuthState](#authstate)

***

<a id="orderdirection"></a>

### OrderDirection

Renames and re-exports [AuthState](#authstate)

***

<a id="sandbox"></a>

### Sandbox

Renames and re-exports [AuthState](#authstate)

***

<a id="sandboxcontext"></a>

### SandboxContext

Renames and re-exports [AuthState](#authstate)

***

<a id="sandboxerror"></a>

### SandboxError

Renames and re-exports [AuthState](#authstate)

***

<a id="timestamp"></a>

### Timestamp

Renames and re-exports [AuthState](#authstate)

***

<a id="wherefilterop"></a>

### WhereFilterOp

Renames and re-exports [AuthState](#authstate)
