<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# @pyric/cli/serve/worker

## Interfaces

### ClientAuth

Client-side Auth handle. Holds the port + a local `currentUser` mirror.
Returned by `getAuth(db | workerUrl)`. Mirrors `firebase/auth`'s `Auth`.

#### Properties

##### \_\_kind

> `readonly` **\_\_kind**: `"client-auth"`

##### currentUser

> **currentUser**: [`ClientUser`](#clientuser)

Local mirror of the worker's currentUser, updated from the stream.

##### port

> `readonly` **port**: `MessagePort`

***

### ClientDb

Opaque client-side Firestore handle. Holds the MessagePort to the worker.

#### Properties

##### \_\_kind

> `readonly` **\_\_kind**: `"client-db"`

##### port

> `readonly` **port**: `MessagePort`

***

### ClientDocSnapshot

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Properties

##### id

> `readonly` **id**: `string`

##### path

> `readonly` **path**: `string`

##### ref

> `readonly` **ref**: [`DocRefHandle`](#docrefhandle)

Full port-carrying reference, usable by write APIs.

#### Methods

##### data()

> **data**(): `Record`\<`string`, `unknown`\>

###### Returns

`Record`\<`string`, `unknown`\>

##### exists()

> **exists**(): `boolean`

###### Returns

`boolean`

***

### ClientFirebaseStorage

Worker-backed Storage handle (carries the shared `MessagePort`).

#### Properties

##### \_\_kind

> `readonly` **\_\_kind**: `"client-storage"`

##### port

> `readonly` **port**: `MessagePort`

***

### ClientQuerySnapshot

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Properties

##### docs

> `readonly` **docs**: [`ClientDocSnapshot`](#clientdocsnapshot)[]

##### empty

> `readonly` **empty**: `boolean`

##### size

> `readonly` **size**: `number`

***

### ClientRtdb

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Properties

##### \_\_kind

> `readonly` **\_\_kind**: `"client-rtdb"`

##### port

> `readonly` **port**: `MessagePort`

***

### ClientSettableMetadata

Mirror of `pyric/storage`'s `SettableMetadata` (plain JSON on the wire).

#### Properties

##### cacheControl?

> `optional` **cacheControl**: `string`

##### contentDisposition?

> `optional` **contentDisposition**: `string`

##### contentEncoding?

> `optional` **contentEncoding**: `string`

##### contentLanguage?

> `optional` **contentLanguage**: `string`

##### contentType?

> `optional` **contentType**: `string`

##### customMetadata?

> `optional` **customMetadata**: `object`

###### Index Signature

\[`key`: `string`\]: `string`

***

### ClientStorageReference

Worker-backed Storage reference (path + name; carries the port for ops).

#### Properties

##### \_\_kind

> `readonly` **\_\_kind**: `"storage-ref"`

##### fullPath

> `readonly` **fullPath**: `string`

##### name

> `readonly` **name**: `string`

##### port

> `readonly` **port**: `MessagePort`

***

### ClientTransaction

Client-side transaction handle.

#### Methods

##### delete()

> **delete**(`ref`): `void`

###### Parameters

###### ref

[`DocRefHandle`](#docrefhandle)

###### Returns

`void`

##### get()

> **get**(`ref`): `Promise`\<[`ClientDocSnapshot`](#clientdocsnapshot)\>

###### Parameters

###### ref

[`DocRefHandle`](#docrefhandle)

###### Returns

`Promise`\<[`ClientDocSnapshot`](#clientdocsnapshot)\>

##### set()

> **set**(`ref`, `data`, `options?`): `void`

###### Parameters

###### ref

[`DocRefHandle`](#docrefhandle)

###### data

`Record`\<`string`, `unknown`\>

###### options?

###### merge?

`boolean`

###### mergeFields?

`string`[]

###### Returns

`void`

##### update()

> **update**(`ref`, `data`): `void`

###### Parameters

###### ref

[`DocRefHandle`](#docrefhandle)

###### data

`Record`\<`string`, `unknown`\>

###### Returns

`void`

***

### ClientUser

Client-side User — a snapshot of the worker's `User` with token accessors
that RPC back to the worker. Mirrors `firebase/auth`'s `User` shape.

#### Properties

##### displayName

> `readonly` **displayName**: `string`

##### email

> `readonly` **email**: `string`

##### emailVerified

> `readonly` **emailVerified**: `boolean`

##### isAnonymous

> `readonly` **isAnonymous**: `boolean`

##### phoneNumber

> `readonly` **phoneNumber**: `string`

##### photoURL

> `readonly` **photoURL**: `string`

##### providerData

> `readonly` **providerData**: readonly `object`[]

##### providerId

> `readonly` **providerId**: `string`

##### uid

> `readonly` **uid**: `string`

#### Methods

##### getIdToken()

> **getIdToken**(`forceRefresh?`): `Promise`\<`string`\>

###### Parameters

###### forceRefresh?

`boolean`

###### Returns

`Promise`\<`string`\>

##### getIdTokenResult()

> **getIdTokenResult**(`forceRefresh?`): `Promise`\<[`SerializedIdTokenResult`](#serializedidtokenresult)\>

###### Parameters

###### forceRefresh?

`boolean`

###### Returns

`Promise`\<[`SerializedIdTokenResult`](#serializedidtokenresult)\>

***

### ClientUserCredential

Client-side UserCredential — mirrors `firebase/auth`.

#### Properties

##### operationType

> **operationType**: `"signIn"` \| `"reauthenticate"` \| `"link"`

##### providerId

> **providerId**: `string`

##### user

> **user**: [`ClientUser`](#clientuser)

***

### ClientWriteBatch

Client-side write batch. Buffers `set`/`update`/`delete` calls and
sends them all to the worker on `.commit()`.

Mirrors `pyric/firestore`'s `writeBatch(db)` shape:
  const batch = writeBatch(db);
  batch.set(ref, { ... });
  batch.delete(ref2);
  await batch.commit();

#### Methods

##### commit()

> **commit**(): `Promise`\<`void`\>

###### Returns

`Promise`\<`void`\>

##### delete()

> **delete**(`ref`): [`ClientWriteBatch`](#clientwritebatch)

###### Parameters

###### ref

[`DocRefHandle`](#docrefhandle)

###### Returns

[`ClientWriteBatch`](#clientwritebatch)

##### set()

> **set**(`ref`, `data`, `options?`): [`ClientWriteBatch`](#clientwritebatch)

###### Parameters

###### ref

[`DocRefHandle`](#docrefhandle)

###### data

`Record`\<`string`, `unknown`\>

###### options?

###### merge?

`boolean`

###### mergeFields?

`string`[]

###### Returns

[`ClientWriteBatch`](#clientwritebatch)

##### update()

> **update**(`ref`, `data`): [`ClientWriteBatch`](#clientwritebatch)

###### Parameters

###### ref

[`DocRefHandle`](#docrefhandle)

###### data

`Record`\<`string`, `unknown`\>

###### Returns

[`ClientWriteBatch`](#clientwritebatch)

***

### CollRefHandle

Client-side collection reference.

#### Properties

##### \_\_kind

> `readonly` **\_\_kind**: `"coll-ref"`

##### descriptor

> `readonly` **descriptor**: `CollRef`

##### id

> `readonly` **id**: `string`

##### path

> `readonly` **path**: `string`

##### port

> `readonly` **port**: `MessagePort`

***

### DocRefHandle

Client-side document reference — carries a DocRef descriptor + port.

#### Properties

##### \_\_kind

> `readonly` **\_\_kind**: `"doc-ref"`

##### descriptor

> `readonly` **descriptor**: `DocRef`

##### id

> `readonly` **id**: `string`

##### path

> `readonly` **path**: `string`

##### port

> `readonly` **port**: `MessagePort`

***

### PresenceSession

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Properties

##### clientId

> `readonly` **clientId**: `string`

Logical page id — Studio uses this to label "This page".

##### kind

> `readonly` **kind**: [`PresenceClientKind`](#presenceclientkind)

#### Methods

##### stop()

> **stop**(): `void`

Stop heartbeats, listeners, and send a best-effort disconnect.

###### Returns

`void`

***

### PresenceSnapshot

Authoritative presence snapshot owned by the SharedWorker host.

#### Properties

##### clients

> **clients**: `PresenceClientRecord`[]

***

### QueryHandle

Client-side query.

#### Properties

##### \_\_kind

> `readonly` **\_\_kind**: `"query"`

##### descriptor

> `readonly` **descriptor**: `QueryDescriptor`

##### port

> `readonly` **port**: `MessagePort`

***

### ResolvedIdentity

A provider identity resolved IN-PAGE (by the `ServeAuthHelper`'s
popup/redirect picker) and handed to the worker for sign-in. Provider flows
(`signInWithPopup`/`signInWithRedirect`) can't cross the worker port — the
`AuthFlowResolver` lives in-page — so the page resolves the picked identity
and bridges it here; the worker seeds it + `restoreSession`s it (no password
— provider users never sign in with one). See `auth.acceptIdentity`.

#### Properties

##### customClaims

> `readonly` **customClaims**: `Record`\<`string`, `unknown`\>

##### displayName

> `readonly` **displayName**: `string`

##### email

> `readonly` **email**: `string`

##### providerId

> `readonly` **providerId**: `string`

##### uid

> `readonly` **uid**: `string`

***

### RtdbDataSnapshot

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Properties

##### key

> `readonly` **key**: `string`

##### ref

> `readonly` **ref**: [`RtdbRefHandle`](#rtdbrefhandle)

##### size

> `readonly` **size**: `number`

#### Methods

##### child()

> **child**(`path`): [`RtdbDataSnapshot`](#rtdbdatasnapshot)

###### Parameters

###### path

`string`

###### Returns

[`RtdbDataSnapshot`](#rtdbdatasnapshot)

##### exists()

> **exists**(): `boolean`

###### Returns

`boolean`

##### exportVal()

> **exportVal**(): `unknown`

###### Returns

`unknown`

##### forEach()

> **forEach**(`cb`): `boolean`

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

> **toJSON**(): `unknown`

###### Returns

`unknown`

##### val()

> **val**(): `unknown`

###### Returns

`unknown`

***

### RtdbRefHandle

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Properties

##### \_\_kind

> `readonly` **\_\_kind**: `"rtdb-ref"`

##### key

> `readonly` **key**: `string`

##### parent

> `readonly` **parent**: [`RtdbRefHandle`](#rtdbrefhandle)

##### path

> `readonly` **path**: `string`

##### port

> `readonly` **port**: `MessagePort`

##### root

> `readonly` **root**: [`RtdbRefHandle`](#rtdbrefhandle)

#### Methods

##### toString()

> **toString**(): `string`

###### Returns

`string`

***

### SerializedIdTokenResult

Wire form of `getIdTokenResult()`.

#### Properties

##### authTime

> `readonly` **authTime**: `string`

##### claims

> `readonly` **claims**: `Record`\<`string`, `unknown`\>

##### expirationTime

> `readonly` **expirationTime**: `string`

##### issuedAtTime

> `readonly` **issuedAtTime**: `string`

##### signInProvider

> `readonly` **signInProvider**: `string`

##### token

> `readonly` **token**: `string`

***

### SerializedUser

Wire representation of a signed-in `User`. The real `pyric/auth` `User`
carries methods (`getIdToken`, `getIdTokenResult`) that don't survive
structured clone, so the worker flattens the fields the client mirror
needs into a plain object. Token accessors on the client re-RPC to the
worker (the worker holds the one real user).

`null` means "signed out" — there is no current user.

#### Properties

##### displayName

> `readonly` **displayName**: `string`

##### email

> `readonly` **email**: `string`

##### emailVerified

> `readonly` **emailVerified**: `boolean`

##### isAnonymous

> `readonly` **isAnonymous**: `boolean`

##### phoneNumber

> `readonly` **phoneNumber**: `string`

##### photoURL

> `readonly` **photoURL**: `string`

##### providerData

> `readonly` **providerData**: readonly `object`[]

##### providerId

> `readonly` **providerId**: `string`

##### uid

> `readonly` **uid**: `string`

***

### SerializedUserCredential

Wire form of a `UserCredential` returned by the sign-in/create ops.

#### Properties

##### operationType

> `readonly` **operationType**: `"signIn"` \| `"reauthenticate"` \| `"link"`

##### providerId

> `readonly` **providerId**: `string`

##### user

> `readonly` **user**: [`SerializedUser`](#serializeduser)

## Type Aliases

### AnyHandle

> **AnyHandle** = [`ClientDb`](#clientdb) \| [`DocRefHandle`](#docrefhandle) \| [`CollRefHandle`](#collrefhandle) \| [`QueryHandle`](#queryhandle)

Union of all client handles.

***

### AuthPersistenceMode

> **AuthPersistenceMode** = `"LOCAL"` \| `"SESSION"` \| `"NONE"`

Persistence mode for the worker's shared auth session.
Mirrors `pyric/auth`'s `Persistence.type`. `'NONE'` (inMemoryPersistence)
disables the IndexedDB session record so a full close does NOT keep the
user signed in; `'LOCAL'` and `'SESSION'` both persist the session in
this single-backend model (see SESSION/LOCAL collapse note in host.ts).

***

### PresenceClientKind

> **PresenceClientKind** = `"app"` \| `"studio"`

Logical page kind for presence (#227).

***

### PresenceVisibility

> **PresenceVisibility** = `"visible"` \| `"hidden"`

Page Visibility API state carried on presence records.

***

### Unsubscribe()

> **Unsubscribe** = () => `void`

Unsubscribe function returned by every streaming subscription.

#### Returns

`void`

## Variables

### browserLocalPersistence

> `const` **browserLocalPersistence**: `object`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Type Declaration

##### type

> `readonly` **type**: `"LOCAL"`

***

### browserSessionPersistence

> `const` **browserSessionPersistence**: `object`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Type Declaration

##### type

> `readonly` **type**: `"SESSION"`

***

### inMemoryPersistence

> `const` **inMemoryPersistence**: `object`

Persistence markers — mirror `firebase/auth` / `pyric/auth`.

#### Type Declaration

##### type

> `readonly` **type**: `"NONE"`

***

### PRESENCE\_HEARTBEAT\_INTERVAL\_MS

> `const` **PRESENCE\_HEARTBEAT\_INTERVAL\_MS**: `15000` = `15000`

Suggested client heartbeat interval.

***

### PRESENCE\_STALE\_MS

> `const` **PRESENCE\_STALE\_MS**: `90000` = `90000`

Lease TTL. Sized to tolerate one delayed background-tab heartbeat under
typical timer throttling (~1/min) without falsely evicting a live page.

## Functions

### acceptProviderCredential()

> **acceptProviderCredential**(`auth`, `identity`): `Promise`\<[`ClientUserCredential`](#clientusercredential)\>

Bridge a provider identity resolved IN-PAGE to the worker (the provider
sign-in seam). The entry adapter's worker-path `signInWithPopup`/
`signInWithRedirect` runs the in-page `AuthFlowResolver` (which can't cross
the worker port), then calls this with the picked identity; the worker seeds
it + signs it in, returning a worker-backed credential. The mirror updates
eagerly (like the email/anon paths) so a synchronous `auth.currentUser`
read right after the await reflects the new user.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

##### identity

[`ResolvedIdentity`](#resolvedidentity)

#### Returns

`Promise`\<[`ClientUserCredential`](#clientusercredential)\>

***

### addDoc()

> **addDoc**(`coll`, `data`): `Promise`\<[`DocRefHandle`](#docrefhandle)\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### coll

[`CollRefHandle`](#collrefhandle)

##### data

`Record`\<`string`, `unknown`\>

#### Returns

`Promise`\<[`DocRefHandle`](#docrefhandle)\>

***

### adminClearUsers()

> **adminClearUsers**(`auth`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

#### Returns

`Promise`\<`void`\>

***

### adminCreateUser()

> **adminCreateUser**(`auth`, `request`): `Promise`\<`AuthUserRecord`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

##### request

`CreateUserRequest`

#### Returns

`Promise`\<`AuthUserRecord`\>

***

### adminDeleteDocument()

> **adminDeleteDocument**(`db`, `path`): `Promise`\<`boolean`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### path

`string`

#### Returns

`Promise`\<`boolean`\>

***

### adminDeleteRtdbValue()

> **adminDeleteRtdbValue**(`db`, `path`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb) | [`ClientRtdb`](#clientrtdb)

##### path

`string`

#### Returns

`Promise`\<`void`\>

***

### adminDeleteUser()

> **adminDeleteUser**(`auth`, `uid`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

##### uid

`string`

#### Returns

`Promise`\<`void`\>

***

### adminGetDocument()

> **adminGetDocument**(`db`, `path`): `Promise`\<`Record`\<`string`, `unknown`\>\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### path

`string`

#### Returns

`Promise`\<`Record`\<`string`, `unknown`\>\>

***

### adminListDocuments()

> **adminListDocuments**(`db`, `path`): `Promise`\<`object`[]\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### path

`string`

#### Returns

`Promise`\<`object`[]\>

***

### adminReadRtdbState()

> **adminReadRtdbState**(`db`): `Promise`\<`unknown`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb) | [`ClientRtdb`](#clientrtdb)

#### Returns

`Promise`\<`unknown`\>

***

### adminReadState()

> **adminReadState**(`db`, `opts?`): `Promise`\<`Record`\<`string`, `unknown`\>\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### opts?

###### maxDepth?

`number`

###### path?

`string`

#### Returns

`Promise`\<`Record`\<`string`, `unknown`\>\>

***

### adminSetDocument()

> **adminSetDocument**(`db`, `path`, `data`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### path

`string`

##### data

`unknown`

#### Returns

`Promise`\<`void`\>

***

### adminSetRtdbValue()

> **adminSetRtdbValue**(`db`, `path`, `value`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb) | [`ClientRtdb`](#clientrtdb)

##### path

`string`

##### value

`unknown`

#### Returns

`Promise`\<`void`\>

***

### adminSubscribeRtdbValue()

> **adminSubscribeRtdbValue**(`db`, `path`, `next`, `error?`): [`Unsubscribe`](#unsubscribe)

Subscribe to the raw value at an RTDB path with the ADMIN lens (Pyric Studio
data viewer). Rides the same `{service:'rtdb'}` value-subscription channel as
`rtdbOnValue`, but pins `actAs: {mode:'admin'}` per-sub instead of following
the module default lens, so Studio's viewer stays admin (PRINCIPLES M3) while
the page's own listeners keep their session semantics.

`next` receives the plain JSON value at `path` (`null` when absent) on
subscribe and again after every write that changes the subtree.

#### Parameters

##### db

[`ClientDb`](#clientdb) | [`ClientRtdb`](#clientrtdb)

##### path

`string`

##### next

(`value`) => `void`

##### error?

(`err`) => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### adminUpdateRtdbValue()

> **adminUpdateRtdbValue**(`db`, `path`, `values`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb) | [`ClientRtdb`](#clientrtdb)

##### path

`string`

##### values

`Record`\<`string`, `unknown`\>

#### Returns

`Promise`\<`void`\>

***

### adminUpdateUser()

> **adminUpdateUser**(`auth`, `uid`, `request`): `Promise`\<`AuthUserRecord`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

##### uid

`string`

##### request

`UpdateUserRequest`

#### Returns

`Promise`\<`AuthUserRecord`\>

***

### and()

> **and**(...`filters`): `QueryConstraintHandle`

AND composite filter — every operand must match. See [or](#or).

#### Parameters

##### filters

...`QueryConstraintHandle`[]

#### Returns

`QueryConstraintHandle`

***

### arrayRemove()

> **arrayRemove**(...`values`): `SentinelMarker`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### values

...`unknown`[]

#### Returns

`SentinelMarker`

***

### arrayUnion()

> **arrayUnion**(...`values`): `SentinelMarker`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### values

...`unknown`[]

#### Returns

`SentinelMarker`

***

### average()

> **average**(`field`): `AggregateFieldDescriptor`

Factory: average-of-`field` aggregate. Empty input yields `null`.

#### Parameters

##### field

`string`

#### Returns

`AggregateFieldDescriptor`

***

### callTool()

> **callTool**(`db`, `name`, `args`): `Promise`\<\{ `data?`: `unknown`; `ok`: `boolean`; `summary`: `string`; \}\>

Forward an agent tool-call to the worker so it executes against the SAME
sandbox the app + Studio use. The worker runs the canonical tool dispatcher
(`buildSandboxDispatcher`) and replies with the `{ ok, summary, data }`
result. Used by the bridge peer on the worker path (`connectBridgePeer` in
`entries/runtime.ts`) so the agent shares the one authoritative sandbox.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### name

`string`

##### args

`Record`\<`string`, `unknown`\>

#### Returns

`Promise`\<\{ `data?`: `unknown`; `ok`: `boolean`; `summary`: `string`; \}\>

***

### collection()

> **collection**(`parent`, ...`pathSegments`): [`CollRefHandle`](#collrefhandle)

Build a collection reference. Mirrors `pyric/firestore`'s `collection(db, path)`.

#### Parameters

##### parent

[`ClientDb`](#clientdb) | [`DocRefHandle`](#docrefhandle)

##### pathSegments

...`string`[]

#### Returns

[`CollRefHandle`](#collrefhandle)

***

### collectionGroup()

> **collectionGroup**(`db`, `collectionId`): [`QueryHandle`](#queryhandle)

Build a collection-group query. Mirrors `pyric/firestore`'s `collectionGroup(db, id)`.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### collectionId

`string`

#### Returns

[`QueryHandle`](#queryhandle)

***

### connectAuthEmulator()

> **connectAuthEmulator**(`_auth`, `_url`, `_options?`): `void`

Connect to the auth emulator. No-op shim over the worker: the worker's
sandbox IS the emulator-equivalent backend, so there's nothing to point at.
Present for surface parity so app code that calls it doesn't break.

#### Parameters

##### \_auth

[`ClientAuth`](#clientauth)

##### \_url

`string`

##### \_options?

###### disableWarnings?

`boolean`

#### Returns

`void`

***

### count()

> **count**(): `AggregateFieldDescriptor`

Factory: count() aggregate field. Mirrors `pyric/firestore`'s `count()`.

#### Returns

`AggregateFieldDescriptor`

***

### createUserWithEmailAndPassword()

> **createUserWithEmailAndPassword**(`auth`, `email`, `password`): `Promise`\<[`ClientUserCredential`](#clientusercredential)\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

##### email

`string`

##### password

`string`

#### Returns

`Promise`\<[`ClientUserCredential`](#clientusercredential)\>

***

### deleteDoc()

> **deleteDoc**(`ref`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### ref

[`DocRefHandle`](#docrefhandle)

#### Returns

`Promise`\<`void`\>

***

### deleteField()

> **deleteField**(): `SentinelMarker`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Returns

`SentinelMarker`

***

### deleteObject()

> **deleteObject**(`reference`): `Promise`\<`void`\>

Delete the object at the reference's path (idempotent — missing = no-op,
 matching the sandbox backend's delete semantics).

#### Parameters

##### reference

[`ClientStorageReference`](#clientstoragereference)

#### Returns

`Promise`\<`void`\>

***

### deleteWorkerBranch()

> **deleteWorkerBranch**(`db`, `name`): `Promise`\<`void`\>

Phase 3: delete a named branch.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### name

`string`

#### Returns

`Promise`\<`void`\>

***

### doc()

> **doc**(`parent`, ...`pathSegments`): [`DocRefHandle`](#docrefhandle)

Build a document reference. Mirrors `pyric/firestore`'s `doc(db, path)`.

WHY CLIENT-SIDE: Firebase's `doc()` is synchronous and path-only — it
needs no data from the sandbox. We build a descriptor object here and
include the port so execution calls can route to the worker.

#### Parameters

##### parent

[`ClientDb`](#clientdb) | [`CollRefHandle`](#collrefhandle)

##### pathSegments

...`string`[]

#### Returns

[`DocRefHandle`](#docrefhandle)

***

### endAt()

> **endAt**(...`values`): `QueryConstraintHandle`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### values

...`unknown`[]

#### Returns

`QueryConstraintHandle`

***

### endBefore()

> **endBefore**(...`values`): `QueryConstraintHandle`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### values

...`unknown`[]

#### Returns

`QueryConstraintHandle`

***

### eventHistory()

> **eventHistory**(`db`): `Promise`\<readonly `SandboxEvent`[]\>

Fetch the worker sandbox's event history as a one-shot snapshot (every event
so far). Opens a transient stream sub, resolves with the initial history
batch, and tears the sub down immediately — so it never holds a live
subscription. Useful for a late, snapshot-only consumer.

#### Parameters

##### db

[`ClientDb`](#clientdb)

#### Returns

`Promise`\<readonly `SandboxEvent`[]\>

***

### exportWorkerState()

> **exportWorkerState**(`db`): `Promise`\<`string`\>

Phase 2 (transfer): export the FULL sandbox state as a portable bundle string
(the chunk format the persist layer uses, so wrapper types round-trip). Save
it to a file and [importWorkerState](#importworkerstate) it into another instance.

#### Parameters

##### db

[`ClientDb`](#clientdb)

#### Returns

`Promise`\<`string`\>

***

### getActiveRules()

> **getActiveRules**(`db`, `service?`): `Promise`\<`unknown`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb) | [`ClientRtdb`](#clientrtdb)

##### service?

`"firestore"` | `"database"`

#### Returns

`Promise`\<`unknown`\>

***

### getAggregateFromServer()

> **getAggregateFromServer**\<`S`\>(`source`, `spec`): `Promise`\<\{ `data`: \{ \[K in string \| number \| symbol\]: number \}; \}\>

Run a multi-field aggregate on the worker. Mirrors `pyric/firestore`'s
`getAggregateFromServer(query, spec)`: spec entries are keyed by
caller-chosen aliases; `.data()` returns the numbers under the same keys
(`average` over no rows is `null`).

#### Type Parameters

##### S

`S` *extends* `AggregateSpecDescriptor`

#### Parameters

##### source

[`CollRefHandle`](#collrefhandle) | [`QueryHandle`](#queryhandle)

##### spec

`S`

#### Returns

`Promise`\<\{ `data`: \{ \[K in string \| number \| symbol\]: number \}; \}\>

***

### getAuth()

> **getAuth**(`source`, `name?`): [`ClientAuth`](#clientauth)

Get the worker-backed Auth handle.

Mirrors `pyric/auth`'s `getAuth(sandbox)` / `firebase/auth`'s
`getAuth(app)` — but the input is either an existing `ClientDb` (reusing
its port, the common case in serve where Firestore + auth share one
worker) or a worker URL (standalone).

The returned handle seeds its `currentUser` mirror by opening an internal
authState subscription that keeps it live across tabs.

#### Parameters

##### source

`string` | [`ClientDb`](#clientdb) | `URL`

##### name?

`string`

#### Returns

[`ClientAuth`](#clientauth)

***

### getBlob()

> **getBlob**(`reference`): `Promise`\<`Blob`\>

Read an object's bytes as a Blob (Pyric Studio inspector preview).
 MessagePort-only — a Blob cannot cross the JSON bridge relay.

#### Parameters

##### reference

[`ClientStorageReference`](#clientstoragereference)

#### Returns

`Promise`\<`Blob`\>

***

### getBytes()

> **getBytes**(`reference`, `maxDownloadSizeBytes?`): `Promise`\<`ArrayBuffer`\>

Read an object's bytes (JSON-safe base64 op → `ArrayBuffer`). Mirrors
 `pyric/storage`'s `getBytes`, including the optional client-side cap.

#### Parameters

##### reference

[`ClientStorageReference`](#clientstoragereference)

##### maxDownloadSizeBytes?

`number`

#### Returns

`Promise`\<`ArrayBuffer`\>

***

### getCountFromServer()

> **getCountFromServer**(`source`): `Promise`\<\{ `data`: \{ `count`: `number`; \}; \}\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### source

[`CollRefHandle`](#collrefhandle) | [`QueryHandle`](#queryhandle)

#### Returns

`Promise`\<\{ `data`: \{ `count`: `number`; \}; \}\>

***

### getDoc()

> **getDoc**(`ref`): `Promise`\<[`ClientDocSnapshot`](#clientdocsnapshot)\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### ref

[`DocRefHandle`](#docrefhandle)

#### Returns

`Promise`\<[`ClientDocSnapshot`](#clientdocsnapshot)\>

***

### getDocs()

> **getDocs**(`source`): `Promise`\<[`ClientQuerySnapshot`](#clientquerysnapshot)\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### source

[`CollRefHandle`](#collrefhandle) | [`QueryHandle`](#queryhandle)

#### Returns

`Promise`\<[`ClientQuerySnapshot`](#clientquerysnapshot)\>

***

### getDownloadURL()

> **getDownloadURL**(`reference`): `Promise`\<`string`\>

Return a page-owned URL for an object read through the SharedWorker.

#### Parameters

##### reference

[`ClientStorageReference`](#clientstoragereference)

#### Returns

`Promise`\<`string`\>

***

### getFirestore()

> **getFirestore**(`workerUrl`, `name?`): [`ClientDb`](#clientdb)

Connect to the SharedWorker and return a client Firestore handle.

Pass the URL of the SharedWorker script as `workerUrl`. Under `pyric dev`
this is `/__pyric/sdk/worker.js`; for tests or standalone use, pass the path
explicitly.

`getFirestore` mirrors `pyric/firestore`'s `getFirestore(sandbox)` shape
but returns a `ClientDb` backed by a `MessagePort` instead of a sandbox.

#### Parameters

##### workerUrl

`string` | `URL`

##### name?

`string`

#### Returns

[`ClientDb`](#clientdb)

***

### getIdToken()

> **getIdToken**(`user`, `forceRefresh?`): `Promise`\<`string`\>

Top-level mirror of `firebase/auth`'s `getIdToken(user)`.

#### Parameters

##### user

[`ClientUser`](#clientuser)

##### forceRefresh?

`boolean`

#### Returns

`Promise`\<`string`\>

***

### getIdTokenResult()

> **getIdTokenResult**(`user`, `forceRefresh?`): `Promise`\<[`SerializedIdTokenResult`](#serializedidtokenresult)\>

Top-level mirror of `firebase/auth`'s `getIdTokenResult(user)`.

#### Parameters

##### user

[`ClientUser`](#clientuser)

##### forceRefresh?

`boolean`

#### Returns

`Promise`\<[`SerializedIdTokenResult`](#serializedidtokenresult)\>

***

### getLens()

> **getLens**(): `any`

The active default lens (read-only view), for Studio UI to reflect state.

#### Returns

`any`

***

### getMetadata()

> **getMetadata**(`reference`): `Promise`\<`FullMetadata`\>

Read an object's metadata (Pyric Studio inspector).

#### Parameters

##### reference

[`ClientStorageReference`](#clientstoragereference)

#### Returns

`Promise`\<`FullMetadata`\>

***

### getProviderConfig()

> **getProviderConfig**(`auth`): `Promise`\<`object`[]\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

#### Returns

`Promise`\<`object`[]\>

***

### getRulesStatus()

> **getRulesStatus**(`db`, `service?`): `Promise`\<`unknown`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb) | [`ClientRtdb`](#clientrtdb)

##### service?

`"firestore"` | `"database"`

#### Returns

`Promise`\<`unknown`\>

***

### getSnapshot()

> **getSnapshot**(`db`): `Promise`\<`SandboxSnapshot`\>

Export the current sandbox snapshot (Pyric Studio rules re-run). Studio forks
it locally to test a denied op against edited rules or re-issue it as the
attempting user, on a throwaway branch (no live mutation).

#### Parameters

##### db

[`ClientDb`](#clientdb)

#### Returns

`Promise`\<`SandboxSnapshot`\>

***

### getStorage()

> **getStorage**(`source`, `name?`): [`ClientFirebaseStorage`](#clientfirebasestorage)

Get the worker-backed Storage handle. Like `getAuth`, accepts an existing
`ClientDb` (reusing its port) or a worker URL (standalone).

#### Parameters

##### source

`string` | [`ClientDb`](#clientdb) | `URL`

##### name?

`string`

#### Returns

[`ClientFirebaseStorage`](#clientfirebasestorage)

***

### getWorkerInstanceId()

> **getWorkerInstanceId**(`db`): `Promise`\<`string`\>

Ask the worker for its stable per-instance id (see host `INSTANCE_ID_KEY`).
Studio renders a human-friendly form so a user can tell which sandbox instance
they're looking at — the same `localhost:<port>` in a different browser profile
is a SEPARATE sandbox (a separate SharedWorker + IndexedDB), and this is how
the two are told apart.

#### Parameters

##### db

[`ClientDb`](#clientdb)

#### Returns

`Promise`\<`string`\>

***

### getWorkerVersion()

> **getWorkerVersion**(`db`): `Promise`\<`string`\>

Ask the worker for its baked build version (staleness guard). The page
compares it to the served bundle version and warns when a still-running OLD
worker is older than what's served (a SharedWorker can't hot-update).

#### Parameters

##### db

[`ClientDb`](#clientdb)

#### Returns

`Promise`\<`string`\>

***

### importWorkerState()

> **importWorkerState**(`db`, `bundle`): `Promise`\<`void`\>

Phase 2 (clobber): replace this sandbox's ENTIRE state with `bundle`.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### bundle

`string`

#### Returns

`Promise`\<`void`\>

***

### increment()

> **increment**(`n`): `SentinelMarker`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### n

`number`

#### Returns

`SentinelMarker`

***

### limit()

> **limit**(`n`): `QueryConstraintHandle`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### n

`number`

#### Returns

`QueryConstraintHandle`

***

### limitToLast()

> **limitToLast**(`n`): `QueryConstraintHandle`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### n

`number`

#### Returns

`QueryConstraintHandle`

***

### listAll()

> **listAll**(`reference`): `Promise`\<\{ `items`: [`ClientStorageReference`](#clientstoragereference)[]; `prefixes`: [`ClientStorageReference`](#clientstoragereference)[]; \}\>

Enumerate immediate child items + sub-prefixes under a ref (Pyric Studio
 data browse). The host enforces `read` rules on the scanned prefix.

#### Parameters

##### reference

[`ClientStorageReference`](#clientstoragereference)

#### Returns

`Promise`\<\{ `items`: [`ClientStorageReference`](#clientstoragereference)[]; `prefixes`: [`ClientStorageReference`](#clientstoragereference)[]; \}\>

***

### listRootCollections()

> **listRootCollections**(`db`): `Promise`\<`string`[]\>

Enumerate root collection ids (Pyric Studio data browse). The modular SDK has
no client `listCollections`, so the host scans the sandbox keyspace and
returns the ids. Lens is attached (via dataRpc) but the host enumeration is
lens-independent.

#### Parameters

##### db

[`ClientDb`](#clientdb)

#### Returns

`Promise`\<`string`[]\>

***

### listSubcollections()

> **listSubcollections**(`db`, `docPath`): `Promise`\<`string`[]\>

Enumerate subcollection ids under a document path (Pyric Studio data browse).

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### docPath

`string`

#### Returns

`Promise`\<`string`[]\>

***

### listUsers()

> **listUsers**(`auth`): `Promise`\<`AuthUserRecord`[]\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

#### Returns

`Promise`\<`AuthUserRecord`[]\>

***

### listWorkerBranches()

> **listWorkerBranches**(`db`): `Promise`\<`string`[]\>

Phase 3: list this instance's saved branch names.

#### Parameters

##### db

[`ClientDb`](#clientdb)

#### Returns

`Promise`\<`string`[]\>

***

### mintPresenceClientId()

> **mintPresenceClientId**(): `string`

Mint a random client id (page-lifetime).

#### Returns

`string`

***

### onAuthStateChanged()

> **onAuthStateChanged**(`auth`, `callback`): [`Unsubscribe`](#unsubscribe)

Subscribe to auth-state changes. Mirrors `firebase/auth`'s
`onAuthStateChanged`. Fires immediately with THIS PORT's current session,
then on every change to it (#754: sessions are per-port — another tab's
sign-in is a different user, not an update to this one). Updates the
handle's `currentUser` mirror before invoking the callback.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

##### callback

(`user`) => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### onIdTokenChanged()

> **onIdTokenChanged**(`auth`, `callback`): [`Unsubscribe`](#unsubscribe)

Subscribe to ID-token changes. Mirrors `firebase/auth`'s
`onIdTokenChanged` — fires on THIS PORT's identity transitions (per-port
sessions, #754).

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

##### callback

(`user`) => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### onSnapshot()

> **onSnapshot**(`target`, `callback`, `errorCallback?`): [`Unsubscribe`](#unsubscribe)

Subscribe to a document or query. Mirrors `pyric/firestore`'s `onSnapshot`.

Returns an `unsub` function. Sends `{ t:'unsub', subId }` to the worker
to deregister the listener on the worker side.

#### Parameters

##### target

[`DocRefHandle`](#docrefhandle) | [`CollRefHandle`](#collrefhandle) | [`QueryHandle`](#queryhandle)

##### callback

(`snap`) => `void`

##### errorCallback?

(`err`) => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### or()

> **or**(...`filters`): `QueryConstraintHandle`

OR composite filter — at least one operand must match. Operands must be
filters (`where()`, or nested `or()`/`and()`). Mirrors `pyric/firestore`'s
`or(...)`; the worker rebuilds it with the real modular factory.

#### Parameters

##### filters

...`QueryConstraintHandle`[]

#### Returns

`QueryConstraintHandle`

***

### orderBy()

> **orderBy**(`field`, `direction?`): `QueryConstraintHandle`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### field

`string`

##### direction?

`"asc"` | `"desc"`

#### Returns

`QueryConstraintHandle`

***

### query()

> **query**(`source`, ...`constraints`): [`QueryHandle`](#queryhandle)

Apply query constraints to a source ref or query.
Mirrors `pyric/firestore`'s `query(source, ...constraints)`.

#### Parameters

##### source

[`CollRefHandle`](#collrefhandle) | [`QueryHandle`](#queryhandle)

##### constraints

...`QueryConstraintHandle`[]

#### Returns

[`QueryHandle`](#queryhandle)

***

### ref()

> **ref**(`parent`, `path?`): [`ClientStorageReference`](#clientstoragereference)

Build a Storage reference. Mirrors `pyric/storage`'s `ref(storage, path?)` /
 `ref(parentRef, path)`. Client-side path math; no RPC.

#### Parameters

##### parent

[`ClientFirebaseStorage`](#clientfirebasestorage) | [`ClientStorageReference`](#clientstoragereference)

##### path?

`string`

#### Returns

[`ClientStorageReference`](#clientstoragereference)

***

### relayWorkerOp()

> **relayWorkerOp**(`db`, `op`): `Promise`\<`unknown`\>

Relay one raw worker-protocol op into the SharedWorker. `op` is the op
message minus `t`/`id` (the `WorkerOpPayload` wire shape); resolves with
the worker's `res.value`, rejects with an Error carrying `.code`.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### op

`WorkerOpPayload`

#### Returns

`Promise`\<`unknown`\>

***

### relayWorkerSub()

> **relayWorkerSub**(`db`, `sub`, `onValue`): () => `void`

Relay a raw worker-protocol subscription into the SharedWorker. `sub` is
the sub message minus `t`/`subId` (the `WorkerSubPayload` wire shape).
`onValue` receives every snap value VERBATIM — including the worker host's
`{ __error: { code, message } }` establishment-failure convention (listener
errors are re-wrapped into the same shape so the far side sees one form).
Returns the unsubscribe function.

The unified event stream (`target: 'events'`) is NOT relayable yet — its
history batches aren't coalescible, so it needs bounded backpressure first
(slice 2).

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### sub

`WorkerSubPayload`

##### onValue

(`value`) => `void`

#### Returns

> (): `void`

##### Returns

`void`

***

### rtdbChild()

> **rtdbChild**(`parent`, `path`): [`RtdbRefHandle`](#rtdbrefhandle)

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### parent

[`RtdbRefHandle`](#rtdbrefhandle)

##### path

`string`

#### Returns

[`RtdbRefHandle`](#rtdbrefhandle)

***

### rtdbConnectDatabaseEmulator()

> **rtdbConnectDatabaseEmulator**(): `void`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Returns

`void`

***

### rtdbGet()

> **rtdbGet**(`r`): `Promise`\<[`RtdbDataSnapshot`](#rtdbdatasnapshot)\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### r

[`RtdbRefHandle`](#rtdbrefhandle)

#### Returns

`Promise`\<[`RtdbDataSnapshot`](#rtdbdatasnapshot)\>

***

### rtdbGetDatabase()

> **rtdbGetDatabase**(`source?`, `name?`): [`ClientRtdb`](#clientrtdb)

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### source?

`string` | [`ClientDb`](#clientdb) | `URL`

##### name?

`string`

#### Returns

[`ClientRtdb`](#clientrtdb)

***

### rtdbOff()

> **rtdbOff**(`_r`, `_eventType?`, `_callback?`): `void`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### \_r

[`RtdbRefHandle`](#rtdbrefhandle)

##### \_eventType?

`unknown`

##### \_callback?

`unknown`

#### Returns

`void`

***

### rtdbOnValue()

> **rtdbOnValue**(`r`, `next`, `error?`): [`Unsubscribe`](#unsubscribe)

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### r

[`RtdbRefHandle`](#rtdbrefhandle)

##### next

(`snap`) => `void`

##### error?

(`err`) => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### rtdbPush()

> **rtdbPush**(`r`, `value?`): [`RtdbRefHandle`](#rtdbrefhandle) & `PromiseLike`\<[`RtdbRefHandle`](#rtdbrefhandle)\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### r

[`RtdbRefHandle`](#rtdbrefhandle)

##### value?

`unknown`

#### Returns

[`RtdbRefHandle`](#rtdbrefhandle) & `PromiseLike`\<[`RtdbRefHandle`](#rtdbrefhandle)\>

***

### rtdbRef()

> **rtdbRef**(`db`, `path?`): [`RtdbRefHandle`](#rtdbrefhandle)

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientRtdb`](#clientrtdb)

##### path?

`string`

#### Returns

[`RtdbRefHandle`](#rtdbrefhandle)

***

### rtdbRemove()

> **rtdbRemove**(`r`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### r

[`RtdbRefHandle`](#rtdbrefhandle)

#### Returns

`Promise`\<`void`\>

***

### rtdbServerTimestamp()

> **rtdbServerTimestamp**(): `object`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Returns

`object`

##### \_\_rtdbSentinel

> `readonly` **\_\_rtdbSentinel**: `"serverTimestamp"`

***

### rtdbSet()

> **rtdbSet**(`r`, `value`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### r

[`RtdbRefHandle`](#rtdbrefhandle)

##### value

`unknown`

#### Returns

`Promise`\<`void`\>

***

### rtdbUpdate()

> **rtdbUpdate**(`r`, `values`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### r

[`RtdbRefHandle`](#rtdbrefhandle)

##### values

`Record`\<`string`, `unknown`\>

#### Returns

`Promise`\<`void`\>

***

### runTransaction()

> **runTransaction**\<`R`\>(`db`, `updateFn`): `Promise`\<`R`\>

Run a transaction. Mirrors `pyric/firestore`'s `runTransaction(db, fn)`.

MULTI-TAB CORRECTNESS — READ-SET VALIDATION + RETRY
----------------------------------------------------
A transaction spans two messages: the `txn.get` RPC (read) and the
`txnCommit` RPC (commit). Between those two messages another tab may
write to a doc the current tab read — a silent lost update without
validation. We fix this the standard way:

  1. Each `txn.get(ref)` records `{ path, data }` in a per-attempt
     read-set (`data` is the raw `SerializedDocData` the worker
     returned, or `null` if the doc was missing).
  2. `txnCommit` carries both `reads` (the read-set) and `writes`.
  3. The worker re-reads each doc inside a sandbox transaction, re-
     serializes it the same way, and compares the JSON strings.
     Any mismatch → `{ ok: false, error: { code: 'aborted' } }`.
  4. On `aborted`, the client discards the result of `updateFn` and
     re-runs it with a fresh transaction object (fresh reads, empty
     write buffer). Up to `TXN_MAX_ATTEMPTS` attempts are made.
  5. After the cap, throws an error with `.code === 'aborted'`.

This matches real Firestore's behaviour: the SDK retries `updateFn`
on conflict rather than surfacing the error immediately.

#### Type Parameters

##### R

`R`

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### updateFn

(`txn`) => `R` \| `Promise`\<`R`\>

#### Returns

`Promise`\<`R`\>

***

### saveWorkerBranch()

> **saveWorkerBranch**(`db`, `name`): `Promise`\<`void`\>

Phase 3: save the live sandbox as a named branch (a saved state bundle).

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### name

`string`

#### Returns

`Promise`\<`void`\>

***

### serverTimestamp()

> **serverTimestamp**(): `SentinelMarker`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Returns

`SentinelMarker`

***

### setDatabaseRules()

> **setDatabaseRules**(`db`, `source`): `Promise`\<\{ `messages`: `unknown`[]; `ok`: `boolean`; \}\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb) | [`ClientRtdb`](#clientrtdb)

##### source

`unknown`

#### Returns

`Promise`\<\{ `messages`: `unknown`[]; `ok`: `boolean`; \}\>

***

### setDoc()

> **setDoc**(`ref`, `data`, `options?`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### ref

[`DocRefHandle`](#docrefhandle)

##### data

`Record`\<`string`, `unknown`\>

##### options?

###### merge?

`boolean`

###### mergeFields?

`string`[]

#### Returns

`Promise`\<`void`\>

***

### setFirestoreRules()

> **setFirestoreRules**(`db`, `source`): `Promise`\<\{ `messages`: `unknown`[]; `ok`: `boolean`; `warnings`: `unknown`[]; \}\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### source

`string`

#### Returns

`Promise`\<\{ `messages`: `unknown`[]; `ok`: `boolean`; `warnings`: `unknown`[]; \}\>

***

### setLens()

> **setLens**(`lens`): `void`

Set the default auth lens applied to subsequent Firestore DATA ops from this
client (Pyric Studio). Pass `{ mode: 'as', uid }` to read/write AS a user
(rules apply), `{ mode: 'admin' }` for the admin lens, or
`{ mode: 'app-session' }` / `undefined` to revert to the app's own session.

The lens is process-wide for this client module (one served page = one
worker port), mirroring how Studio drives a single active identity at a time.
Auth ops are unaffected — they always operate the real session.

#### Parameters

##### lens

`any`

#### Returns

`void`

***

### setOpIssuer()

> **setOpIssuer**(`source`): `void`

Declare who issues the ops this client module constructs. See \_opIssuer.

#### Parameters

##### source

`"studio"`

#### Returns

`void`

***

### setPersistence()

> **setPersistence**(`auth`, `persistence`): `Promise`\<`void`\>

Record the session-persistence mode on the worker (surface parity). The
effective persistence is CLIENT-side (#754): the entry adapter mirrors the
mode into the page's SessionStore, which decides where — or whether — this
tab's session uid is stored for reload restore.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

##### persistence

`ClientPersistence`

#### Returns

`Promise`\<`void`\>

***

### setProviderConfig()

> **setProviderConfig**(`auth`, `providerId`, `enabled`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

##### providerId

`string`

##### enabled

`boolean`

#### Returns

`Promise`\<`void`\>

***

### setRules()

> **setRules**(`db`, `source`): `Promise`\<\{ `warnings`: `unknown`[]; \}\>

Deploy new rules to the worker's sandbox. Active onSnapshot listeners
that were allowed by the old rules may start receiving error callbacks
if the new rules deny them.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### source

`string`

#### Returns

`Promise`\<\{ `warnings`: `unknown`[]; \}\>

***

### signInAnonymously()

> **signInAnonymously**(`auth`): `Promise`\<[`ClientUserCredential`](#clientusercredential)\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

#### Returns

`Promise`\<[`ClientUserCredential`](#clientusercredential)\>

***

### signInWithEmailAndPassword()

> **signInWithEmailAndPassword**(`auth`, `email`, `password`): `Promise`\<[`ClientUserCredential`](#clientusercredential)\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

##### email

`string`

##### password

`string`

#### Returns

`Promise`\<[`ClientUserCredential`](#clientusercredential)\>

***

### signOut()

> **signOut**(`auth`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### auth

[`ClientAuth`](#clientauth)

#### Returns

`Promise`\<`void`\>

***

### startAfter()

> **startAfter**(...`values`): `QueryConstraintHandle`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### values

...`unknown`[]

#### Returns

`QueryConstraintHandle`

***

### startAt()

> **startAt**(...`values`): `QueryConstraintHandle`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### values

...`unknown`[]

#### Returns

`QueryConstraintHandle`

***

### startPresence()

> **startPresence**(`opts`): [`PresenceSession`](#presencesession)

Register this page with the worker and keep the lease alive until
[PresenceSession.stop](#stop) or `pagehide`.

#### Parameters

##### opts

`StartPresenceOptions`

#### Returns

[`PresenceSession`](#presencesession)

***

### subscribeEvents()

> **subscribeEvents**(`db`, `callback`): [`Unsubscribe`](#unsubscribe)

Subscribe to the worker sandbox's unified event stream. The callback fires
with each delivered BATCH of events — the FIRST call carries the initial
`history()` snapshot (possibly empty), each subsequent call carries one live
event. Returns an unsubscribe that deregisters on the worker.

This is the live counterpart to `sandbox.onEvent` + an initial `history()`
fold, collapsed into one subscription so a late subscriber never misses the
backlog.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### callback

(`events`) => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### subscribePresence()

> **subscribePresence**(`db`, `callback`): [`Unsubscribe`](#unsubscribe)

Subscribe to the worker's authoritative presence snapshot. The callback
fires immediately with the current snapshot, then on every change.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### callback

(`snapshot`) => `void`

#### Returns

[`Unsubscribe`](#unsubscribe)

***

### sum()

> **sum**(`field`): `AggregateFieldDescriptor`

Factory: sum-of-`field` aggregate. Mirrors `pyric/firestore`'s `sum()`.

#### Parameters

##### field

`string`

#### Returns

`AggregateFieldDescriptor`

***

### switchWorkerBranch()

> **switchWorkerBranch**(`db`, `name`): `Promise`\<`void`\>

Phase 3 (clobber): switch the live sandbox to a named branch's state.

#### Parameters

##### db

[`ClientDb`](#clientdb)

##### name

`string`

#### Returns

`Promise`\<`void`\>

***

### updateDoc()

> **updateDoc**(`ref`, `data`): `Promise`\<`void`\>

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### ref

[`DocRefHandle`](#docrefhandle)

##### data

`Record`\<`string`, `unknown`\>

#### Returns

`Promise`\<`void`\>

***

### uploadBytes()

> **uploadBytes**(`reference`, `data`, `metadata?`): `Promise`\<\{ `metadata`: `FullMetadata`; `ref`: [`ClientStorageReference`](#clientstoragereference); \}\>

Upload bytes at the reference's path (replaces existing content).
 Mirrors `pyric/storage`'s `uploadBytes` result shape.

#### Parameters

##### reference

[`ClientStorageReference`](#clientstoragereference)

##### data

`Blob` | `ArrayBuffer` | `Uint8Array`\<`ArrayBufferLike`\>

##### metadata?

[`ClientSettableMetadata`](#clientsettablemetadata)

#### Returns

`Promise`\<\{ `metadata`: `FullMetadata`; `ref`: [`ClientStorageReference`](#clientstoragereference); \}\>

***

### where()

> **where**(`field`, `op`, `value`): `QueryConstraintHandle`

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### field

`string`

##### op

`string`

##### value

`unknown`

#### Returns

`QueryConstraintHandle`

***

### writeBatch()

> **writeBatch**(`db`): [`ClientWriteBatch`](#clientwritebatch)

Browser-safe SharedWorker CLIENT surface (Pyric Studio data plane).

This barrel exports ONLY the leaf client + the wire-protocol types — the
pieces a browser app (the served page, or Pyric Studio's Vite app) imports to
connect to the `pyric-shared-worker` over its `MessagePort`. It deliberately
does NOT re-export `host.ts`/`entry.ts`:
  - `host.ts` imports the full `pyric/firestore` + `pyric/auth` engine (it IS
    the backend) — node/engine-heavy, never wanted in a page bundle.
  - `entry.ts` references `SharedWorkerGlobalScope` and is esbuild-only.

`client.ts` imports only the value codec (`pyric/firestore-values`, a leaf)
and type-only `pyric/sandbox` (erased at build), so this entry stays free of
the ~10 MB rules/sandbox engine — safe to import from any browser app.

Exposed by `@pyric/cli`'s `./serve/worker` package export so Studio can
`import { getFirestore, subscribeEvents, setLens } from
'@pyric/cli/serve/worker'` and reach the live SharedWorker backend.

#### Parameters

##### db

[`ClientDb`](#clientdb)

#### Returns

[`ClientWriteBatch`](#clientwritebatch)
