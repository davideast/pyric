<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# pyric/firestore

## Classes

### Bytes

#### Methods

##### isEqual()

> **isEqual**(`other`): `boolean`

###### Parameters

###### other

[`Bytes`](#bytes)

###### Returns

`boolean`

##### toBase64()

> **toBase64**(): `string`

###### Returns

`string`

##### toJSON()

> **toJSON**(): `object`

###### Returns

`object`

##### toString()

> **toString**(): `string`

###### Returns

`string`

##### toUint8Array()

> **toUint8Array**(): `Uint8Array`

###### Returns

`Uint8Array`

##### fromBase64String()

> `static` **fromBase64String**(`base64`): [`Bytes`](#bytes)

###### Parameters

###### base64

`string`

###### Returns

[`Bytes`](#bytes)

##### fromJSON()

> `static` **fromJSON**(`json`): [`Bytes`](#bytes)

###### Parameters

###### json

`object`

###### Returns

[`Bytes`](#bytes)

##### fromUint8Array()

> `static` **fromUint8Array**(`array`): [`Bytes`](#bytes)

###### Parameters

###### array

`Uint8Array`

###### Returns

[`Bytes`](#bytes)

***

### FieldPath

#### Constructors

##### Constructor

> **new FieldPath**(...`fieldNames`): [`FieldPath`](#fieldpath)

###### Parameters

###### fieldNames

...`string`[]

###### Returns

[`FieldPath`](#fieldpath)

#### Properties

##### \_internalPath

> `readonly` **\_internalPath**: `object`

###### len

> **len**: `number`

###### offset

> **offset**: `number`

###### segments

> **segments**: `string`[]

#### Methods

##### isEqual()

> **isEqual**(`other`): `boolean`

###### Parameters

###### other

[`FieldPath`](#fieldpath)

###### Returns

`boolean`

***

### GeoPoint

#### Constructors

##### Constructor

> **new GeoPoint**(`lat`, `lng`): [`GeoPoint`](#geopoint)

###### Parameters

###### lat

`number`

###### lng

`number`

###### Returns

[`GeoPoint`](#geopoint)

#### Accessors

##### latitude

###### Get Signature

> **get** **latitude**(): `number`

###### Returns

`number`

##### longitude

###### Get Signature

> **get** **longitude**(): `number`

###### Returns

`number`

#### Methods

##### isEqual()

> **isEqual**(`other`): `boolean`

###### Parameters

###### other

[`GeoPoint`](#geopoint)

###### Returns

`boolean`

##### toJSON()

> **toJSON**(): `object`

###### Returns

`object`

###### latitude

> **latitude**: `number`

###### longitude

> **longitude**: `number`

###### type

> **type**: `string`

##### fromJSON()

> `static` **fromJSON**(`json`): [`GeoPoint`](#geopoint)

###### Parameters

###### json

`object`

###### Returns

[`GeoPoint`](#geopoint)

***

### VectorValue

#### Properties

##### \_values

> `readonly` **\_values**: `number`[]

#### Methods

##### isEqual()

> **isEqual**(`other`): `boolean`

###### Parameters

###### other

[`VectorValue`](#vectorvalue)

###### Returns

`boolean`

##### toArray()

> **toArray**(): `number`[]

###### Returns

`number`[]

##### toJSON()

> **toJSON**(): `object`

###### Returns

`object`

##### create()

> `static` **create**(`values`): [`VectorValue`](#vectorvalue)

###### Parameters

###### values

`number`[]

###### Returns

[`VectorValue`](#vectorvalue)

##### fromJSON()

> `static` **fromJSON**(`json`): [`VectorValue`](#vectorvalue)

###### Parameters

###### json

`object`

###### Returns

[`VectorValue`](#vectorvalue)

## Interfaces

### AggregateQuerySnapshot

Snapshot returned by `getCountFromServer` /
`getAggregateFromServer`. `.data()` returns the computed numbers
keyed by the spec's aliases (or `{ count: number }` for the
count-only entry point).

#### Type Parameters

##### T

`T` *extends* `Record`\<`string`, `number` \| `null`\> = `Record`\<`string`, `number` \| `null`\>

#### Methods

##### data()

> **data**(): `T`

###### Returns

`T`

***

### CollectionReference

A reference to a Firestore collection. Backend-opaque.

#### Type Parameters

##### _T

`_T` = [`AuthState`](#authstate)

#### Properties

##### id

> `readonly` **id**: `string`

##### path

> `readonly` **path**: `string`

***

### DocumentReference

A reference to a Firestore document. Backend-opaque.

#### Type Parameters

##### _T

`_T` = [`AuthState`](#authstate)

#### Properties

##### id

> `readonly` **id**: `string`

##### path

> `readonly` **path**: `string`

***

### DocumentSnapshot

A point-in-time view of one document.

#### Extended by

- [`QueryDocumentSnapshot`](#querydocumentsnapshot)

#### Type Parameters

##### T

`T` = [`AuthState`](#authstate)

#### Properties

##### exists

> `readonly` **exists**: `boolean` \| () => `boolean`

##### id

> `readonly` **id**: `string`

#### Methods

##### data()

> **data**(): `T`

###### Returns

`T`

***

### Firestore

Opaque sandbox handle carrying its owner via [TARGET\_SYMBOL](#target_symbol-1).

#### Properties

##### \[TARGET\_SYMBOL\]

> `readonly` **\[TARGET\_SYMBOL\]**: `Target`

***

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

##### AppModelType

`AppModelType`

##### DbModelType

`DbModelType` *extends* [`AuthState`](#authstate) = [`AuthState`](#authstate)

#### Methods

##### fromFirestore()

> **fromFirestore**(`snapshot`): `AppModelType`

###### Parameters

###### snapshot

[`QueryDocumentSnapshot`](#querydocumentsnapshot)\<`DbModelType`\>

###### Returns

`AppModelType`

##### toFirestore()

> **toFirestore**(`modelObject`): `DbModelType`

###### Parameters

###### modelObject

`AppModelType`

###### Returns

`DbModelType`

***

### FirestoreDataToolDeps

#### Methods

##### resolveDb()

> **resolveDb**(`as?`): [`Firestore`](#firestore) \| `Promise`\<[`Firestore`](#firestore)\>

Resolver returning a `Firestore` handle. Called per-dispatch with the
op's `as` value: `'admin'` (or undefined) → an admin-bypass Firestore;
`{ uid, claims? }` → a rules-enforcing Firestore acting as that user.

The host decides the posture; the tool layer does NOT enforce it. A sandbox
resolver may default to admin (rules bypass is the point of seeding), but a
resolver wired to a real backend should require an explicit identity or
confirm-gate admin writes (see the bridge's prod confirm-policy).

###### Parameters

###### as?

[`As`](#as)

###### Returns

[`Firestore`](#firestore) \| `Promise`\<[`Firestore`](#firestore)\>

***

### FirestoreInspectToolDeps

#### Methods

##### resolveSandbox()

> **resolveSandbox**(): `any`

Resolve the sandbox whose Firestore state should be inspected.

###### Returns

`any`

***

### FirestoreSettings

Client-cache/network settings `initializeFirestore` accepts but no-ops
 on sandbox targets — see the tier-1 section rationale above.

#### Properties

##### cacheSizeBytes?

> `optional` **cacheSizeBytes**: `number`

##### experimentalAutoDetectLongPolling?

> `optional` **experimentalAutoDetectLongPolling**: `boolean`

##### experimentalForceLongPolling?

> `optional` **experimentalForceLongPolling**: `boolean`

##### host?

> `optional` **host**: `string`

##### ignoreUndefinedProperties?

> `optional` **ignoreUndefinedProperties**: `boolean`

##### localCache?

> `optional` **localCache**: [`LocalCache`](#localcache-1)

##### ssl?

> `optional` **ssl**: `boolean`

***

### LocalCache

Opaque local-cache config token accepted by [initializeFirestore](#initializefirestore)'s
 `settings.localCache`. Inert — see the tier-1 section rationale above.

#### Properties

##### \[LOCAL\_CACHE\_SYMBOL\]

> `readonly` **\[LOCAL\_CACHE\_SYMBOL\]**: `"persistent"` \| `"memory"`

##### garbageCollector?

> `readonly` `optional` **garbageCollector**: [`MemoryGarbageCollector`](#memorygarbagecollector)

##### tabManager?

> `readonly` `optional` **tabManager**: [`PersistentTabManager`](#persistenttabmanager)

***

### MemoryGarbageCollector

Opaque garbage-collector config token. Inert for the same reason —
 there is no memory cache tier with GC pressure to tune.

#### Properties

##### \[GC\_SYMBOL\]

> `readonly` **\[GC\_SYMBOL\]**: `"eager"` \| `"lru"`

***

### PersistenceSettings

#### Properties

##### forceOwnership?

> `optional` **forceOwnership**: `boolean`

***

### PersistentTabManager

Opaque tab-manager config token. Inert — persistence is always on,
 and the SharedWorker/`pyric dev` path already is the one shared
 store every tab talks to, so there is no separate multi-tab mode
 to opt into. Carries the requested kind only for debugging.

#### Properties

##### \[TAB\_MANAGER\_SYMBOL\]

> `readonly` **\[TAB\_MANAGER\_SYMBOL\]**: `"single"` \| `"multiple"`

***

### Query

A Firestore query (a collection ref or one with where/orderBy/limit applied).

#### Type Parameters

##### _T

`_T` = [`AuthState`](#authstate)

#### Properties

##### \_isQuery?

> `readonly` `optional` **\_isQuery**: `true`

***

### QueryConstraint

#### Properties

##### \_sandboxFilter?

> `optional` **\_sandboxFilter**: `ChainFilter`

Internal — the filter representation for composite-filter
composition. `where()` populates it as a leaf; `or()` / `and()`
combine sub-constraints' filters into a composite tree. Non-filter
constraints (`orderBy`, `limit`) leave it undefined; passing one
to `or()` / `and()` throws.

#### Methods

##### applySandbox()

> **applySandbox**(`q`): `ChainQuery`

###### Parameters

###### q

`ChainQuery`

###### Returns

`ChainQuery`

***

### QueryDocumentSnapshot

`QueryDocumentSnapshot` is a `DocumentSnapshot` known to exist —
`.data()` always returns the typed model, never `undefined`. Yielded
by `QuerySnapshot.docs` and passed to converter `fromFirestore`
callbacks. Mirrors the JS SDK's narrowing.

#### Extends

- [`DocumentSnapshot`](#documentsnapshot)\<`T`\>

#### Type Parameters

##### T

`T` = [`AuthState`](#authstate)

#### Properties

##### exists

> `readonly` **exists**: `boolean` \| () => `boolean`

###### Inherited from

[`DocumentSnapshot`](#documentsnapshot).[`exists`](#exists)

##### id

> `readonly` **id**: `string`

###### Inherited from

[`DocumentSnapshot`](#documentsnapshot).[`id`](#id-2)

#### Methods

##### data()

> **data**(): `T`

###### Returns

`T`

###### Overrides

[`DocumentSnapshot`](#documentsnapshot).[`data`](#data-2)

***

### QuerySnapshot

A point-in-time view of a query result.

#### Type Parameters

##### T

`T` = [`AuthState`](#authstate)

#### Properties

##### docs

> `readonly` **docs**: readonly [`QueryDocumentSnapshot`](#querydocumentsnapshot)\<`T`\>[]

##### empty

> `readonly` **empty**: `boolean`

##### size

> `readonly` **size**: `number`

***

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

##### merge?

> `optional` **merge**: `boolean`

##### mergeFields?

> `optional` **mergeFields**: readonly `string`[]

***

### SnapshotListenOptions

#### Properties

##### includeMetadataChanges?

> `optional` **includeMetadataChanges**: `boolean`

***

### SnapshotObserver

#### Type Parameters

##### T

`T`

#### Properties

##### complete()?

> `optional` **complete**: () => `void`

###### Returns

`void`

##### error()?

> `optional` **error**: (`error`) => `void`

###### Parameters

###### error

`unknown`

###### Returns

`void`

##### next()?

> `optional` **next**: (`snapshot`) => `void`

###### Parameters

###### snapshot

`T`

###### Returns

`void`

***

### UserAuth

#### Properties

##### claims?

> `optional` **claims**: `Record`\<`string`, `unknown`\>

##### uid

> **uid**: `string`

## Type Aliases

### AggregateField

> **AggregateField** = \{ `kind`: `"count"`; \} \| \{ `field`: `string`; `kind`: `"sum"`; \} \| \{ `field`: `string`; `kind`: `"average"`; \}

Aggregate-field descriptor returned by `count()` / `sum(field)` /
`average(field)`.

***

### AggregateSpec

> **AggregateSpec** = `Record`\<`string`, [`AggregateField`](#aggregatefield)\>

Spec passed to `getAggregateFromServer(query, spec)`.

***

### As

> **As** = `"admin"` \| [`UserAuth`](#userauth)

Who a data-plane op runs as. The default (omitted, or the literal `'admin'`)
is an ADMIN write that BYPASSES rules — the right mode for sandbox seeding.
A `{ uid, claims? }` runs as that user with rules ENFORCED. The point of the
explicit literal: bypass is NAMED (`as:'admin'`), not the silent consequence
of omitting an auth field, and acting-as-a-user is named too.

***

### AuthState

> **AuthState** = `any`

***

### LogLevel

> **LogLevel** = `"debug"` \| `"verbose"` \| `"info"` \| `"warn"` \| `"error"` \| `"silent"`

Mirrors `firebase/firestore`'s `LogLevel` union.

***

### Transaction

> **Transaction** = [`AuthState`](#authstate)

***

### Unsubscribe()

> **Unsubscribe** = () => `void`

#### Returns

`void`

***

### WriteBatch

> **WriteBatch** = [`AuthState`](#authstate)

## Variables

### TARGET\_SYMBOL

> `const` **TARGET\_SYMBOL**: unique `symbol`

Hidden property on every [Firestore](#firestore) handle. Discriminates
the sandbox backend so free functions can recover their owner.

## Functions

### actingAs()

> **actingAs**(`sandbox`, `identity`): [`Firestore`](#firestore)

A Firestore handle scoped to a specific identity, for multi-user testing.

`actingAs(sandbox, { uid })` returns a `Firestore` whose ops evaluate security
rules as that user (`request.auth.uid === uid`; custom claims via `token`);
`actingAs(sandbox, null)` is the anonymous (signed-out) path. Multiple
identities over ONE sandbox share the same store, so a write by one is
delivered to another's `onSnapshot`: the basis for multi-user sync testing.

#### Parameters

##### sandbox

`Sandbox`

##### identity

`AuthState`

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

### addDoc()

> **addDoc**\<`T`\>(`coll`, `data`): `Promise`\<[`DocumentReference`](#documentreference)\<`T`\>\>

#### Type Parameters

##### T

`T` = `DocumentData`

#### Parameters

##### coll

[`CollectionReference`](#collectionreference)\<`T`\>

##### data

`T`

#### Returns

`Promise`\<[`DocumentReference`](#documentreference)\<`T`\>\>

***

### and()

> **and**(...`filters`): [`QueryConstraint`](#queryconstraint)

AND composite. Same shape as `or()` but every inner constraint
must match. Useful inside an `or()` to combine constraints that
would otherwise be at the top level.

#### Parameters

##### filters

...[`QueryConstraint`](#queryconstraint)[]

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### arrayRemove()

> **arrayRemove**(...`values`): `FieldValueSentinel`

#### Parameters

##### values

...`unknown`[]

#### Returns

`FieldValueSentinel`

***

### arrayUnion()

> **arrayUnion**(...`values`): `FieldValueSentinel`

#### Parameters

##### values

...`unknown`[]

#### Returns

`FieldValueSentinel`

***

### average()

> **average**(`field`): [`AggregateField`](#aggregatefield)

Factory: average-of-`field` aggregate.

#### Parameters

##### field

`string`

#### Returns

[`AggregateField`](#aggregatefield)

***

### clearIndexedDbPersistence()

> **clearIndexedDbPersistence**(`db`): `Promise`\<`void`\>

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

##### db

[`Firestore`](#firestore)

#### Returns

`Promise`\<`void`\>

***

### collection()

> **collection**(`parent`, ...`pathSegments`): [`CollectionReference`](#collectionreference)

#### Parameters

##### parent

[`Firestore`](#firestore) | [`DocumentReference`](#documentreference)\<`DocumentData`\>

##### pathSegments

...`string`[]

#### Returns

[`CollectionReference`](#collectionreference)

***

### collectionGroup()

> **collectionGroup**(`db`, `collectionId`): [`Query`](#query)

Cross-collection query — scans every document under every
collection whose final segment matches `collectionId`. Mirrors
`firebase/firestore`'s `collectionGroup(db, id)` shape.

Returned `Query` accepts the same `where` / `orderBy` / `limit`
constraints as any other query.

#### Parameters

##### db

[`Firestore`](#firestore)

##### collectionId

`string`

#### Returns

[`Query`](#query)

***

### connectFirestoreEmulator()

> **connectFirestoreEmulator**(`db`, `host`, `port`, `options?`): `void`

No-op in the sandbox mirror because the sandbox already runs locally.

The option shape remains source-compatible with Firebase so canonical
initialization code can call it unconditionally.

#### Parameters

##### db

[`Firestore`](#firestore)

##### host

`string`

##### port

`number`

##### options?

###### mockUserToken?

`string` \| \{\[`claim`: `string`\]: `unknown`; `firebase?`: \{ `identities?`: `Record`\<`string`, `string`[]\>; `sign_in_provider?`: `string`; \}; `sub?`: `string`; `user_id?`: `string`; \}

#### Returns

`void`

***

### count()

> **count**(): [`AggregateField`](#aggregatefield)

Factory: count() aggregate.

#### Returns

[`AggregateField`](#aggregatefield)

***

### createFirestoreDataTools()

> **createFirestoreDataTools**(`deps`): `ToolHandler`\<`unknown`, `unknown`\>[]

Modular Web-SDK-shaped Firestore data tools — get, list, create,
update, delete. Each tool's `auth` arg is forwarded to the
resolver; omitted = admin mode, supplied = user mode.

#### Parameters

##### deps

[`FirestoreDataToolDeps`](#firestoredatatooldeps)

#### Returns

`ToolHandler`\<`unknown`, `unknown`\>[]

***

### createFirestoreInspectTools()

> **createFirestoreInspectTools**(`deps`): `ToolHandler`\<`unknown`, `unknown`\>[]

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

##### deps

[`FirestoreInspectToolDeps`](#firestoreinspecttooldeps)

#### Returns

`ToolHandler`\<`unknown`, `unknown`\>[]

***

### deleteDoc()

> **deleteDoc**(`ref`): `Promise`\<`void`\>

#### Parameters

##### ref

[`DocumentReference`](#documentreference)

#### Returns

`Promise`\<`void`\>

***

### deleteField()

> **deleteField**(): `FieldValueSentinel`

#### Returns

`FieldValueSentinel`

***

### disableNetwork()

> **disableNetwork**(`db`): `Promise`\<`void`\>

Sandbox: no-op success. There is no network in the sandbox — every
op is a local call into the in-memory/IndexedDB-backed store — so
there is nothing to disable. This deliberately does NOT simulate an
offline mode: queued writes still commit immediately rather than
queuing, because the sandbox cannot honestly deliver "queued until
reconnected" when there is no connection to lose in the first place.
App code that calls this to prep for flaky connectivity will not
crash, but it also will not observe write-queuing behavior.

#### Parameters

##### db

[`Firestore`](#firestore)

#### Returns

`Promise`\<`void`\>

***

### doc()

> **doc**\<`T`\>(`parent`, ...`pathSegments`): [`DocumentReference`](#documentreference)\<`T`\>

#### Type Parameters

##### T

`T` = `DocumentData`

#### Parameters

##### parent

[`Firestore`](#firestore) | [`CollectionReference`](#collectionreference)\<`T`\>

##### pathSegments

...`string`[]

#### Returns

[`DocumentReference`](#documentreference)\<`T`\>

***

### documentId()

> **documentId**(): [`FieldPath`](#fieldpath)

#### Returns

[`FieldPath`](#fieldpath)

***

### enableIndexedDbPersistence()

> **enableIndexedDbPersistence**(`db`, `persistenceSettings?`): `Promise`\<`void`\>

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

##### db

[`Firestore`](#firestore)

##### persistenceSettings?

[`PersistenceSettings`](#persistencesettings)

#### Returns

`Promise`\<`void`\>

***

### enableMultiTabIndexedDbPersistence()

> **enableMultiTabIndexedDbPersistence**(`db`): `Promise`\<`void`\>

Sandbox: no-op success, same rationale as [enableIndexedDbPersistence](#enableindexeddbpersistence).
Multi-tab coordination is meaningless here too: the sandbox's
SharedWorker path already IS the single shared store every tab talks
to, so there's no separate "multi-tab" mode to opt into.

#### Parameters

##### db

[`Firestore`](#firestore)

#### Returns

`Promise`\<`void`\>

***

### enableNetwork()

> **enableNetwork**(`db`): `Promise`\<`void`\>

Sandbox: no-op success, symmetric with [disableNetwork](#disablenetwork) — since
network was never disabled locally, there is nothing to re-enable.

#### Parameters

##### db

[`Firestore`](#firestore)

#### Returns

`Promise`\<`void`\>

***

### endAt()

#### Call Signature

> **endAt**(`snapshot`): [`QueryConstraint`](#queryconstraint)

End the query at the document whose ordered field values match
 the cursor. Inclusive — the document at the cursor IS included.

##### Parameters

###### snapshot

[`DocumentSnapshot`](#documentsnapshot)

##### Returns

[`QueryConstraint`](#queryconstraint)

#### Call Signature

> **endAt**(...`values`): [`QueryConstraint`](#queryconstraint)

End the query at the document whose ordered field values match
 the cursor. Inclusive — the document at the cursor IS included.

##### Parameters

###### values

...`unknown`[]

##### Returns

[`QueryConstraint`](#queryconstraint)

***

### endBefore()

#### Call Signature

> **endBefore**(`snapshot`): [`QueryConstraint`](#queryconstraint)

Same as `endAt`, but EXCLUDES the document at the cursor — the
 result ends at the prior ordered position.

##### Parameters

###### snapshot

[`DocumentSnapshot`](#documentsnapshot)

##### Returns

[`QueryConstraint`](#queryconstraint)

#### Call Signature

> **endBefore**(...`values`): [`QueryConstraint`](#queryconstraint)

Same as `endAt`, but EXCLUDES the document at the cursor — the
 result ends at the prior ordered position.

##### Parameters

###### values

...`unknown`[]

##### Returns

[`QueryConstraint`](#queryconstraint)

***

### getAdminFirestore()

#### Call Signature

> **getAdminFirestore**(`sandbox`): [`Firestore`](#firestore)

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
`Sandbox` / `SandboxContext` / `PyricApp` — never a `FirebaseApp`.
Admin ops are identity-agnostic (rules are off), so the
handle is a FROZEN `sandbox` target: it does not track
`sandbox.currentUser`.

Intended for Studio's "edit anything as admin" surfaces (F2) and the
serve worker's `{ mode: 'admin' }` auth lens. For rules-applied
impersonation ("act as this user"), use `getFirestore(sandbox.withAuth({
uid }))` instead.

##### Parameters

###### sandbox

`Sandbox`

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

> **getAdminFirestore**(`ctx`): [`Firestore`](#firestore)

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
`Sandbox` / `SandboxContext` / `PyricApp` — never a `FirebaseApp`.
Admin ops are identity-agnostic (rules are off), so the
handle is a FROZEN `sandbox` target: it does not track
`sandbox.currentUser`.

Intended for Studio's "edit anything as admin" surfaces (F2) and the
serve worker's `{ mode: 'admin' }` auth lens. For rules-applied
impersonation ("act as this user"), use `getFirestore(sandbox.withAuth({
uid }))` instead.

##### Parameters

###### ctx

`SandboxContext`

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

> **getAdminFirestore**(`app`): [`Firestore`](#firestore)

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
`Sandbox` / `SandboxContext` / `PyricApp` — never a `FirebaseApp`.
Admin ops are identity-agnostic (rules are off), so the
handle is a FROZEN `sandbox` target: it does not track
`sandbox.currentUser`.

Intended for Studio's "edit anything as admin" surfaces (F2) and the
serve worker's `{ mode: 'admin' }` auth lens. For rules-applied
impersonation ("act as this user"), use `getFirestore(sandbox.withAuth({
uid }))` instead.

##### Parameters

###### app

`PyricApp`

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

### getAggregateFromServer()

> **getAggregateFromServer**\<`S`\>(`source`, `spec`): `Promise`\<[`AggregateQuerySnapshot`](#aggregatequerysnapshot)\<\{ \[K in string \| number \| symbol\]: number \}\>\>

Run a multi-field aggregate against the query. Spec entries are
keyed by caller-chosen aliases; the returned snapshot's `.data()`
uses the same keys.

The sandbox target dispatches straight into the chainable adapter.

#### Type Parameters

##### S

`S` *extends* [`AggregateSpec`](#aggregatespec)

#### Parameters

##### source

[`Query`](#query)\<`DocumentData`\> | [`CollectionReference`](#collectionreference)\<`DocumentData`\>

##### spec

`S`

#### Returns

`Promise`\<[`AggregateQuerySnapshot`](#aggregatequerysnapshot)\<\{ \[K in string \| number \| symbol\]: number \}\>\>

***

### getCountFromServer()

> **getCountFromServer**(`source`): `Promise`\<[`AggregateQuerySnapshot`](#aggregatequerysnapshot)\<\{ `count`: `number`; \}\>\>

Count documents matching the query. Returns a snapshot whose
`.data()` yields `{ count: N }` — same shape `firebase/firestore`'s
`getCountFromServer` produces.

#### Parameters

##### source

[`Query`](#query)\<`DocumentData`\> | [`CollectionReference`](#collectionreference)\<`DocumentData`\>

#### Returns

`Promise`\<[`AggregateQuerySnapshot`](#aggregatequerysnapshot)\<\{ `count`: `number`; \}\>\>

***

### getDoc()

> **getDoc**\<`T`\>(`ref`): `Promise`\<[`DocumentSnapshot`](#documentsnapshot)\<`T`\>\>

#### Type Parameters

##### T

`T` = `DocumentData`

#### Parameters

##### ref

[`DocumentReference`](#documentreference)\<`T`\>

#### Returns

`Promise`\<[`DocumentSnapshot`](#documentsnapshot)\<`T`\>\>

***

### getDocFromCache()

> **getDocFromCache**\<`T`\>(`ref`): `Promise`\<[`DocumentSnapshot`](#documentsnapshot)\<`T`\>\>

Sandbox: delegates to [getDoc](#getdoc). Real Firebase THROWS
`'unavailable'` here on a cache miss (nothing local matches the
ref); pyric never misses — the local store always has whatever is
there — so this never throws for that reason. Documented divergence,
not a claim of parity.

#### Type Parameters

##### T

`T` = `DocumentData`

#### Parameters

##### ref

[`DocumentReference`](#documentreference)\<`T`\>

#### Returns

`Promise`\<[`DocumentSnapshot`](#documentsnapshot)\<`T`\>\>

***

### getDocFromServer()

> **getDocFromServer**\<`T`\>(`ref`): `Promise`\<[`DocumentSnapshot`](#documentsnapshot)\<`T`\>\>

Sandbox: delegates to [getDoc](#getdoc). The sandbox store IS the
authoritative, always-fresh source — there is no separate server
round-trip to force, so "from server" and the default read are the
same honest thing.

#### Type Parameters

##### T

`T` = `DocumentData`

#### Parameters

##### ref

[`DocumentReference`](#documentreference)\<`T`\>

#### Returns

`Promise`\<[`DocumentSnapshot`](#documentsnapshot)\<`T`\>\>

***

### getDocs()

> **getDocs**\<`T`\>(`query`): `Promise`\<[`QuerySnapshot`](#querysnapshot)\<`T`\>\>

#### Type Parameters

##### T

`T` = `DocumentData`

#### Parameters

##### query

[`Query`](#query)\<`T`\>

#### Returns

`Promise`\<[`QuerySnapshot`](#querysnapshot)\<`T`\>\>

***

### getDocsFromCache()

> **getDocsFromCache**\<`T`\>(`query`): `Promise`\<[`QuerySnapshot`](#querysnapshot)\<`T`\>\>

Query-plural form of [getDocFromCache](#getdocfromcache) — same cache-miss divergence.

#### Type Parameters

##### T

`T` = `DocumentData`

#### Parameters

##### query

[`Query`](#query)\<`T`\>

#### Returns

`Promise`\<[`QuerySnapshot`](#querysnapshot)\<`T`\>\>

***

### getDocsFromServer()

> **getDocsFromServer**\<`T`\>(`query`): `Promise`\<[`QuerySnapshot`](#querysnapshot)\<`T`\>\>

Query-plural form of [getDocFromServer](#getdocfromserver).

#### Type Parameters

##### T

`T` = `DocumentData`

#### Parameters

##### query

[`Query`](#query)\<`T`\>

#### Returns

`Promise`\<[`QuerySnapshot`](#querysnapshot)\<`T`\>\>

***

### getFirestore()

#### Call Signature

> **getFirestore**(`ctx`): [`Firestore`](#firestore)

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

###### ctx

`SandboxContext`

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

> **getFirestore**(`sandbox`): [`Firestore`](#firestore)

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

###### sandbox

`Sandbox`

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

> **getFirestore**(`app`): [`Firestore`](#firestore)

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

###### app

`PyricApp`

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

> **getFirestore**(`target`): [`Firestore`](#firestore)

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

###### target

`any`

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

### increment()

> **increment**(`n`): `FieldValueSentinel`

#### Parameters

##### n

`number`

#### Returns

`FieldValueSentinel`

***

### initializeFirestore()

> **initializeFirestore**(`app`, `_settings?`, `_databaseId?`): [`Firestore`](#firestore)

Delegates to [getFirestore](#getfirestore) and returns the same handle. Accepts
the `settings` argument (so the explicit-init pattern app code commonly
writes — `initializeFirestore(app, { localCache: persistentLocalCache(...) } )`
— no longer crashes at import) but no-ops the cache/network settings:
persistence is already the sandbox default, so there is nothing left to
configure into existence.

#### Parameters

##### app

`any`

##### \_settings?

[`FirestoreSettings`](#firestoresettings)

##### \_databaseId?

`string`

#### Returns

[`Firestore`](#firestore)

***

### limit()

> **limit**(`n`): [`QueryConstraint`](#queryconstraint)

#### Parameters

##### n

`number`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### limitToLast()

> **limitToLast**(`n`): [`QueryConstraint`](#queryconstraint)

Limit the query to the LAST `n` documents in the ordered result.
Requires at least one `orderBy` on the query (production-aligned —
the simulator throws at execute time without one).

#### Parameters

##### n

`number`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### memoryEagerGarbageCollector()

> **memoryEagerGarbageCollector**(): [`MemoryGarbageCollector`](#memorygarbagecollector)

Inert config token accepted by [memoryLocalCache](#memorylocalcache)'s `garbageCollector`.

#### Returns

[`MemoryGarbageCollector`](#memorygarbagecollector)

***

### memoryLocalCache()

> **memoryLocalCache**(`settings?`): [`LocalCache`](#localcache-1)

Inert config token — the memory-cache counterpart of [persistentLocalCache](#persistentlocalcache).

#### Parameters

##### settings?

###### garbageCollector?

[`MemoryGarbageCollector`](#memorygarbagecollector)

#### Returns

[`LocalCache`](#localcache-1)

***

### memoryLruGarbageCollector()

> **memoryLruGarbageCollector**(`_settings?`): [`MemoryGarbageCollector`](#memorygarbagecollector)

Inert config token accepted by [memoryLocalCache](#memorylocalcache)'s `garbageCollector`.

#### Parameters

##### \_settings?

###### cacheSizeBytes?

`number`

#### Returns

[`MemoryGarbageCollector`](#memorygarbagecollector)

***

### onSnapshot()

#### Call Signature

> **onSnapshot**\<`T`\>(`ref`, `observerOrNext`, `errorOrNothing?`): [`Unsubscribe`](#unsubscribe)

##### Type Parameters

###### T

`T` *extends* [`DocumentReference`](#documentreference)\<`DocumentData`\> \| [`Query`](#query)\<`DocumentData`\>

##### Parameters

###### ref

`T`

###### observerOrNext

[`SnapshotObserver`](#snapshotobserver)\<`unknown`\> | (`snap`) => `void`

###### errorOrNothing?

(`error`) => `void`

##### Returns

[`Unsubscribe`](#unsubscribe)

#### Call Signature

> **onSnapshot**\<`T`\>(`ref`, `options`, `observerOrNext`, `errorOrNothing?`): [`Unsubscribe`](#unsubscribe)

##### Type Parameters

###### T

`T` *extends* [`DocumentReference`](#documentreference)\<`DocumentData`\> \| [`Query`](#query)\<`DocumentData`\>

##### Parameters

###### ref

`T`

###### options

[`SnapshotListenOptions`](#snapshotlistenoptions)

###### observerOrNext

[`SnapshotObserver`](#snapshotobserver)\<`unknown`\> | (`snap`) => `void`

###### errorOrNothing?

(`error`) => `void`

##### Returns

[`Unsubscribe`](#unsubscribe)

***

### onSnapshotsInSync()

> **onSnapshotsInSync**(`db`, `observerOrCallback`): [`Unsubscribe`](#unsubscribe)

Sandbox: fires the callback once the current snapshot-delivery
microtask queue settles — the closest honest approximation of "every
active listener has delivered its latest state" available without a
true cross-listener sync signal (the sandbox doesn't track one).
This is NOT the real SDK's guarantee (which is scoped to actual
server round-trips); it is scoped to local delivery only.

#### Parameters

##### db

[`Firestore`](#firestore)

##### observerOrCallback

() => `void` | \{ `complete?`: () => `void`; `error?`: (`error`) => `void`; `next?`: () => `void`; \}

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### or()

> **or**(...`filters`): [`QueryConstraint`](#queryconstraint)

OR composite — at least one of the inner constraints must match.
Each argument must itself be a filter constraint (`where()`, or
nested `or()` / `and()`); passing `orderBy()` or `limit()` here is
a type error at runtime.

Mirrors `firebase/firestore`'s `or(...filters)` shape.

#### Parameters

##### filters

...[`QueryConstraint`](#queryconstraint)[]

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### orderBy()

> **orderBy**(`field`, `direction?`): [`QueryConstraint`](#queryconstraint)

#### Parameters

##### field

`string` | [`FieldPath`](#fieldpath)

##### direction?

`OrderDirection`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### persistentLocalCache()

> **persistentLocalCache**(`settings?`): [`LocalCache`](#localcache-1)

Inert config token. Real Firebase uses this to select an on-disk,
persistent IndexedDB cache tier; the sandbox has no separate cache
tier — persistence is already the default — so this just returns a
tagged token `initializeFirestore` can accept without crashing.

#### Parameters

##### settings?

###### cacheSizeBytes?

`number`

###### tabManager?

[`PersistentTabManager`](#persistenttabmanager)

#### Returns

[`LocalCache`](#localcache-1)

***

### persistentMultipleTabManager()

> **persistentMultipleTabManager**(): [`PersistentTabManager`](#persistenttabmanager)

Inert config token accepted by [persistentLocalCache](#persistentlocalcache)'s `tabManager`.

#### Returns

[`PersistentTabManager`](#persistenttabmanager)

***

### persistentSingleTabManager()

> **persistentSingleTabManager**(`_settings?`): [`PersistentTabManager`](#persistenttabmanager)

Inert config token accepted by [persistentLocalCache](#persistentlocalcache)'s `tabManager`.

#### Parameters

##### \_settings?

###### forceOwnership?

`boolean`

#### Returns

[`PersistentTabManager`](#persistenttabmanager)

***

### query()

> **query**\<`T`\>(`source`, ...`constraints`): [`Query`](#query)\<`T`\>

#### Type Parameters

##### T

`T` = `DocumentData`

#### Parameters

##### source

[`CollectionReference`](#collectionreference)\<`T`\> | [`Query`](#query)\<`T`\>

##### constraints

...[`QueryConstraint`](#queryconstraint)[]

#### Returns

[`Query`](#query)\<`T`\>

***

### queryEqual()

> **queryEqual**(`a`, `b`): `boolean`

#### Parameters

##### a

[`Query`](#query)

##### b

[`Query`](#query)

#### Returns

`boolean`

***

### refEqual()

> **refEqual**(`a`, `b`): `boolean`

#### Parameters

##### a

[`DocumentReference`](#documentreference)

##### b

[`DocumentReference`](#documentreference)

#### Returns

`boolean`

***

### runTransaction()

> **runTransaction**\<`R`\>(`db`, `fn`): `Promise`\<`R`\>

#### Type Parameters

##### R

`R`

#### Parameters

##### db

[`Firestore`](#firestore)

##### fn

(`tx`) => `R` \| `Promise`\<`R`\>

#### Returns

`Promise`\<`R`\>

***

### serverTimestamp()

> **serverTimestamp**(): `FieldValueSentinel`

#### Returns

`FieldValueSentinel`

***

### setDoc()

> **setDoc**\<`T`\>(`ref`, `data`, `options?`): `Promise`\<`void`\>

#### Type Parameters

##### T

`T` = `DocumentData`

#### Parameters

##### ref

[`DocumentReference`](#documentreference)\<`T`\>

##### data

`T`

##### options?

[`SetOptions`](#setoptions)

#### Returns

`Promise`\<`void`\>

***

### setLogLevel()

> **setLogLevel**(`logLevel`): `void`

Accepted no-op: the sandbox has no modular-SDK-style logger to wire
a level into (it uses host-level `console` logging directly, gated
by `pyric dev`'s own flags, not this call). Exists purely so app
code that calls this defensively at startup doesn't crash on a
missing export.

#### Parameters

##### logLevel

[`LogLevel`](#loglevel)

#### Returns

`void`

***

### snapshotEqual()

> **snapshotEqual**(`a`, `b`): `boolean`

#### Parameters

##### a

[`DocumentSnapshot`](#documentsnapshot)\<`DocumentData`\> | [`QuerySnapshot`](#querysnapshot)\<`DocumentData`\>

##### b

[`DocumentSnapshot`](#documentsnapshot)\<`DocumentData`\> | [`QuerySnapshot`](#querysnapshot)\<`DocumentData`\>

#### Returns

`boolean`

***

### startAfter()

#### Call Signature

> **startAfter**(`snapshot`): [`QueryConstraint`](#queryconstraint)

Same as `startAt`, but EXCLUDES the document at the cursor — the
 result starts at the next ordered position.

##### Parameters

###### snapshot

[`DocumentSnapshot`](#documentsnapshot)

##### Returns

[`QueryConstraint`](#queryconstraint)

#### Call Signature

> **startAfter**(...`values`): [`QueryConstraint`](#queryconstraint)

Same as `startAt`, but EXCLUDES the document at the cursor — the
 result starts at the next ordered position.

##### Parameters

###### values

...`unknown`[]

##### Returns

[`QueryConstraint`](#queryconstraint)

***

### startAt()

#### Call Signature

> **startAt**(`snapshot`): [`QueryConstraint`](#queryconstraint)

Start the query at the document whose ordered field values match
the cursor. Inclusive — the document at the cursor IS included in
the result. Two overloads:

  `startAt(snapshot)` — values come from `snapshot.data()` indexed
    by the query's orderBy fields.
  `startAt(...values)` — explicit positional values (one per
    orderBy clause).

##### Parameters

###### snapshot

[`DocumentSnapshot`](#documentsnapshot)

##### Returns

[`QueryConstraint`](#queryconstraint)

#### Call Signature

> **startAt**(...`values`): [`QueryConstraint`](#queryconstraint)

Start the query at the document whose ordered field values match
the cursor. Inclusive — the document at the cursor IS included in
the result. Two overloads:

  `startAt(snapshot)` — values come from `snapshot.data()` indexed
    by the query's orderBy fields.
  `startAt(...values)` — explicit positional values (one per
    orderBy clause).

##### Parameters

###### values

...`unknown`[]

##### Returns

[`QueryConstraint`](#queryconstraint)

***

### sum()

> **sum**(`field`): [`AggregateField`](#aggregatefield)

Factory: sum-of-`field` aggregate.

#### Parameters

##### field

`string`

#### Returns

[`AggregateField`](#aggregatefield)

***

### terminate()

> **terminate**(`db`): `Promise`\<`void`\>

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

##### db

[`Firestore`](#firestore)

#### Returns

`Promise`\<`void`\>

***

### updateDoc()

> **updateDoc**(`ref`, `data`): `Promise`\<`void`\>

`updateDoc` does NOT run the converter. Matches `firebase/firestore`'s
Web SDK shape — partial updates can target any subset of fields, so
a translator built around a full `AppModelType` would be a type-shape
mismatch. Use the underlying `DocumentData` view (`withConverter(ref,
null)`) for typed-and-untyped mixed access if you need both styles
against the same path.

#### Parameters

##### ref

[`DocumentReference`](#documentreference)

##### data

`DocumentData`

#### Returns

`Promise`\<`void`\>

***

### vector()

> **vector**(`values?`): [`VectorValue`](#vectorvalue)

#### Parameters

##### values?

`number`[]

#### Returns

[`VectorValue`](#vectorvalue)

***

### waitForPendingWrites()

> **waitForPendingWrites**(`db`): `Promise`\<`void`\>

Sandbox: resolves immediately. The real SDK's version waits for
queued writes to reach the server; the sandbox has no server to wait
on — every write it accepts is already committed to the local store
by the time the write's own promise resolves, so by the time this is
called there are, honestly, never any writes still pending a round
trip.

#### Parameters

##### db

[`Firestore`](#firestore)

#### Returns

`Promise`\<`void`\>

***

### where()

> **where**(`field`, `op`, `value`): [`QueryConstraint`](#queryconstraint)

#### Parameters

##### field

`string` | [`FieldPath`](#fieldpath)

##### op

`WhereFilterOp`

##### value

`unknown`

#### Returns

[`QueryConstraint`](#queryconstraint)

***

### withConverter()

#### Call Signature

> **withConverter**\<`AppModel`, `DbModel`\>(`ref`, `converter`): [`DocumentReference`](#documentreference)\<`AppModel`\>

##### Type Parameters

###### AppModel

`AppModel`

###### DbModel

`DbModel` *extends* `DocumentData` = `DocumentData`

##### Parameters

###### ref

[`DocumentReference`](#documentreference)\<`DocumentData`\>

###### converter

[`FirestoreDataConverter`](#firestoredataconverter)\<`AppModel`, `DbModel`\>

##### Returns

[`DocumentReference`](#documentreference)\<`AppModel`\>

#### Call Signature

> **withConverter**(`ref`, `converter`): [`DocumentReference`](#documentreference)\<`DocumentData`\>

##### Parameters

###### ref

[`DocumentReference`](#documentreference)\<`unknown`\>

###### converter

`null`

##### Returns

[`DocumentReference`](#documentreference)\<`DocumentData`\>

#### Call Signature

> **withConverter**\<`AppModel`, `DbModel`\>(`ref`, `converter`): [`CollectionReference`](#collectionreference)\<`AppModel`\>

##### Type Parameters

###### AppModel

`AppModel`

###### DbModel

`DbModel` *extends* `DocumentData` = `DocumentData`

##### Parameters

###### ref

[`CollectionReference`](#collectionreference)\<`DocumentData`\>

###### converter

[`FirestoreDataConverter`](#firestoredataconverter)\<`AppModel`, `DbModel`\>

##### Returns

[`CollectionReference`](#collectionreference)\<`AppModel`\>

#### Call Signature

> **withConverter**(`ref`, `converter`): [`CollectionReference`](#collectionreference)\<`DocumentData`\>

##### Parameters

###### ref

[`CollectionReference`](#collectionreference)\<`unknown`\>

###### converter

`null`

##### Returns

[`CollectionReference`](#collectionreference)\<`DocumentData`\>

#### Call Signature

> **withConverter**\<`AppModel`, `DbModel`\>(`q`, `converter`): [`Query`](#query)\<`AppModel`\>

##### Type Parameters

###### AppModel

`AppModel`

###### DbModel

`DbModel` *extends* `DocumentData` = `DocumentData`

##### Parameters

###### q

[`Query`](#query)\<`DocumentData`\>

###### converter

[`FirestoreDataConverter`](#firestoredataconverter)\<`AppModel`, `DbModel`\>

##### Returns

[`Query`](#query)\<`AppModel`\>

#### Call Signature

> **withConverter**(`q`, `converter`): [`Query`](#query)\<`DocumentData`\>

##### Parameters

###### q

[`Query`](#query)\<`unknown`\>

###### converter

`null`

##### Returns

[`Query`](#query)\<`DocumentData`\>

***

### writeBatch()

> **writeBatch**(`db`): `ChainWriteBatch`

#### Parameters

##### db

[`Firestore`](#firestore)

#### Returns

`ChainWriteBatch`

## References

### DocumentData

Renames and re-exports [AuthState](#authstate)

***

### FieldValue

Renames and re-exports [AuthState](#authstate)

***

### FieldValueSentinel

Renames and re-exports [AuthState](#authstate)

***

### LintResult

Renames and re-exports [AuthState](#authstate)

***

### OrderDirection

Renames and re-exports [AuthState](#authstate)

***

### Sandbox

Renames and re-exports [AuthState](#authstate)

***

### SandboxContext

Renames and re-exports [AuthState](#authstate)

***

### SandboxError

Renames and re-exports [AuthState](#authstate)

***

### Timestamp

Renames and re-exports [AuthState](#authstate)

***

### WhereFilterOp

Renames and re-exports [AuthState](#authstate)
