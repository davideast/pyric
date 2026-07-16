---
title: "API reference: @pyric/cli/serve/worker"
navLabel: "@pyric/cli/serve/worker"
outcome: "Published declarations for @pyric/cli/serve/worker."
slug: "pyric-cli-serve-worker-reference-api"
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/serve/worker"
apiSubpath: "serve/worker"
apiSymbolCount: 144
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="clientauth"></a>

### ClientAuth

Client-side Auth handle. Holds the port + a local `currentUser` mirror.
Returned by `getAuth(db | workerUrl)`. Mirrors `firebase/auth`'s `Auth`.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="currentuser"></a> `currentUser` | `public` | [`ClientUser`](#clientuser) | Local mirror of the worker's currentUser, updated from the stream. |
| <a id="port"></a> `port` | `readonly` | `ClientPort` | - |

***

<a id="clientdb"></a>

### ClientDb

Opaque client-side Firestore handle. Holds the MessagePort to the worker.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="port-1"></a> `port` | `readonly` | `ClientPort` |

***

<a id="clientdocsnapshot"></a>

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

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="id"></a> `id` | `readonly` | `string` | - |
| <a id="path"></a> `path` | `readonly` | `string` | - |
| <a id="ref"></a> `ref` | `readonly` | [`DocRefHandle`](#docrefhandle) | Full port-carrying reference, usable by write APIs. |

#### Methods

<a id="data"></a>

##### data()

```ts
data(): Record<string, unknown>;
```

###### Returns

`Record`\<`string`, `unknown`\>

<a id="exists"></a>

##### exists()

```ts
exists(): boolean;
```

###### Returns

`boolean`

***

<a id="clientfirebasestorage"></a>

### ClientFirebaseStorage

Worker-backed Storage handle (carries the shared `MessagePort`).

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="port-2"></a> `port` | `readonly` | `ClientPort` |

***

<a id="clientquerysnapshot"></a>

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

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="docs"></a> `docs` | `readonly` | [`ClientDocSnapshot`](#clientdocsnapshot)[] |
| <a id="empty"></a> `empty` | `readonly` | `boolean` |
| <a id="size"></a> `size` | `readonly` | `number` |

***

<a id="clientrtdb"></a>

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

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="port-3"></a> `port` | `readonly` | `ClientPort` |

***

<a id="clientsettablemetadata"></a>

### ClientSettableMetadata

Mirror of `pyric/storage`'s `SettableMetadata` (plain JSON on the wire).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="cachecontrol"></a> `cacheControl?` | `string` |
| <a id="contentdisposition"></a> `contentDisposition?` | `string` |
| <a id="contentencoding"></a> `contentEncoding?` | `string` |
| <a id="contentlanguage"></a> `contentLanguage?` | `string` |
| <a id="contenttype"></a> `contentType?` | `string` |
| <a id="custommetadata"></a> `customMetadata?` | \{ \[`key`: `string`\]: `string`; \} |

***

<a id="clientstoragereference"></a>

### ClientStorageReference

Worker-backed Storage reference (path + name; carries the port for ops).

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="fullpath"></a> `fullPath` | `readonly` | `string` |
| <a id="name"></a> `name` | `readonly` | `string` |
| <a id="port-4"></a> `port` | `readonly` | `ClientPort` |

***

<a id="clienttransaction"></a>

### ClientTransaction

Client-side transaction handle.

#### Methods

<a id="delete"></a>

##### delete()

```ts
delete(ref: DocRefHandle): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocRefHandle`](#docrefhandle) |

###### Returns

`void`

<a id="get"></a>

##### get()

```ts
get(ref: DocRefHandle): Promise<ClientDocSnapshot>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocRefHandle`](#docrefhandle) |

###### Returns

`Promise`\<[`ClientDocSnapshot`](#clientdocsnapshot)\>

<a id="set"></a>

##### set()

```ts
set(
   ref: DocRefHandle,
   data: Record<string, unknown>,
   options?: {
  merge?: boolean;
  mergeFields?: string[];
}): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocRefHandle`](#docrefhandle) |
| `data` | `Record`\<`string`, `unknown`\> |
| `options?` | \{ `merge?`: `boolean`; `mergeFields?`: `string`[]; \} |
| `options.merge?` | `boolean` |
| `options.mergeFields?` | `string`[] |

###### Returns

`void`

<a id="update"></a>

##### update()

```ts
update(ref: DocRefHandle, data: Record<string, unknown>): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocRefHandle`](#docrefhandle) |
| `data` | `Record`\<`string`, `unknown`\> |

###### Returns

`void`

***

<a id="clientuser"></a>

### ClientUser

Client-side User — a snapshot of the worker's `User` with token accessors
that RPC back to the worker. Mirrors `firebase/auth`'s `User` shape.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="displayname"></a> `displayName` | `readonly` | `string` |
| <a id="email"></a> `email` | `readonly` | `string` |
| <a id="emailverified"></a> `emailVerified` | `readonly` | `boolean` |
| <a id="isanonymous"></a> `isAnonymous` | `readonly` | `boolean` |
| <a id="phonenumber"></a> `phoneNumber` | `readonly` | `string` |
| <a id="photourl"></a> `photoURL` | `readonly` | `string` |
| <a id="providerdata"></a> `providerData` | `readonly` | readonly \{ `displayName`: `string`; `email`: `string`; `phoneNumber`: `string`; `photoURL`: `string`; `providerId`: `string`; `uid`: `string`; \}[] |
| <a id="providerid"></a> `providerId` | `readonly` | `string` |
| <a id="uid"></a> `uid` | `readonly` | `string` |

#### Methods

<a id="getidtoken"></a>

##### getIdToken()

```ts
getIdToken(forceRefresh?: boolean): Promise<string>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `forceRefresh?` | `boolean` |

###### Returns

`Promise`\<`string`\>

<a id="getidtokenresult"></a>

##### getIdTokenResult()

```ts
getIdTokenResult(forceRefresh?: boolean): Promise<SerializedIdTokenResult>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `forceRefresh?` | `boolean` |

###### Returns

`Promise`\<[`SerializedIdTokenResult`](#serializedidtokenresult)\>

***

<a id="clientusercredential"></a>

### ClientUserCredential

Client-side UserCredential — mirrors `firebase/auth`.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="operationtype"></a> `operationType` | `"signIn"` \| `"reauthenticate"` \| `"link"` |
| <a id="providerid-1"></a> `providerId` | `string` |
| <a id="user"></a> `user` | [`ClientUser`](#clientuser) |

***

<a id="clientwritebatch"></a>

### ClientWriteBatch

Client-side write batch. Buffers `set`/`update`/`delete` calls and
sends them all to the worker on `.commit()`.

Mirrors `pyric/firestore`'s `writeBatch(db)` shape:
  const batch = writeBatch(db);
  batch.set(ref, { ... });
  batch.delete(ref2);
  await batch.commit();

#### Methods

<a id="commit"></a>

##### commit()

```ts
commit(): Promise<void>;
```

###### Returns

`Promise`\<`void`\>

<a id="delete-2"></a>

##### delete()

```ts
delete(ref: DocRefHandle): ClientWriteBatch;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocRefHandle`](#docrefhandle) |

###### Returns

[`ClientWriteBatch`](#clientwritebatch)

<a id="set-2"></a>

##### set()

```ts
set(
   ref: DocRefHandle,
   data: Record<string, unknown>,
   options?: {
  merge?: boolean;
  mergeFields?: string[];
}): ClientWriteBatch;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocRefHandle`](#docrefhandle) |
| `data` | `Record`\<`string`, `unknown`\> |
| `options?` | \{ `merge?`: `boolean`; `mergeFields?`: `string`[]; \} |
| `options.merge?` | `boolean` |
| `options.mergeFields?` | `string`[] |

###### Returns

[`ClientWriteBatch`](#clientwritebatch)

<a id="update-2"></a>

##### update()

```ts
update(ref: DocRefHandle, data: Record<string, unknown>): ClientWriteBatch;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocRefHandle`](#docrefhandle) |
| `data` | `Record`\<`string`, `unknown`\> |

###### Returns

[`ClientWriteBatch`](#clientwritebatch)

***

<a id="collrefhandle"></a>

### CollRefHandle

Client-side collection reference.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="descriptor"></a> `descriptor` | `readonly` | `CollRef` |
| <a id="id-1"></a> `id` | `readonly` | `string` |
| <a id="path-1"></a> `path` | `readonly` | `string` |
| <a id="port-5"></a> `port` | `readonly` | `ClientPort` |

***

<a id="docrefhandle"></a>

### DocRefHandle

Client-side document reference — carries a DocRef descriptor + port.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="descriptor-1"></a> `descriptor` | `readonly` | `DocRef` |
| <a id="id-2"></a> `id` | `readonly` | `string` |
| <a id="path-2"></a> `path` | `readonly` | `string` |
| <a id="port-6"></a> `port` | `readonly` | `ClientPort` |

***

<a id="presencesession"></a>

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

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="clientid"></a> `clientId` | `readonly` | `string` | Logical page id — Studio uses this to label "This page". |
| <a id="kind"></a> `kind` | `readonly` | [`PresenceClientKind`](#presenceclientkind) | - |

#### Methods

<a id="stop"></a>

##### stop()

```ts
stop(): void;
```

Stop heartbeats, listeners, and send a best-effort disconnect.

###### Returns

`void`

***

<a id="presencesnapshot"></a>

### PresenceSnapshot

Authoritative presence snapshot owned by the SharedWorker host.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="clients"></a> `clients` | `PresenceClientRecord`[] |

***

<a id="queryhandle"></a>

### QueryHandle

Client-side query.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="descriptor-2"></a> `descriptor` | `readonly` | `QueryDescriptor` |
| <a id="port-7"></a> `port` | `readonly` | `ClientPort` |

***

<a id="resolvedidentity"></a>

### ResolvedIdentity

A provider identity resolved IN-PAGE (by the `ServeAuthHelper`'s
popup/redirect picker) and handed to the worker for sign-in. Provider flows
(`signInWithPopup`/`signInWithRedirect`) can't cross the worker port — the
`AuthFlowResolver` lives in-page — so the page resolves the picked identity
and bridges it here; the worker seeds it + `restoreSession`s it (no password
— provider users never sign in with one). See `auth.acceptIdentity`.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="customclaims"></a> `customClaims` | `readonly` | `Record`\<`string`, `unknown`\> |
| <a id="displayname-1"></a> `displayName` | `readonly` | `string` |
| <a id="email-1"></a> `email` | `readonly` | `string` |
| <a id="providerid-2"></a> `providerId` | `readonly` | `string` |
| <a id="uid-1"></a> `uid` | `readonly` | `string` |

***

<a id="rtdbdatasnapshot"></a>

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

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="key"></a> `key` | `readonly` | `string` |
| <a id="ref-1"></a> `ref` | `readonly` | [`RtdbRefHandle`](#rtdbrefhandle) |
| <a id="size-1"></a> `size` | `readonly` | `number` |

#### Methods

<a id="child"></a>

##### child()

```ts
child(path: string): RtdbDataSnapshot;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

[`RtdbDataSnapshot`](#rtdbdatasnapshot)

<a id="exists-2"></a>

##### exists()

```ts
exists(): boolean;
```

###### Returns

`boolean`

<a id="exportval"></a>

##### exportVal()

```ts
exportVal(): unknown;
```

###### Returns

`unknown`

<a id="foreach"></a>

##### forEach()

```ts
forEach(cb: (child: RtdbDataSnapshot) => boolean | void): boolean;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `cb` | (`child`: [`RtdbDataSnapshot`](#rtdbdatasnapshot)) => `boolean` \| `void` |

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
toJSON(): unknown;
```

###### Returns

`unknown`

<a id="val"></a>

##### val()

```ts
val(): unknown;
```

###### Returns

`unknown`

***

<a id="rtdbrefhandle"></a>

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

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="key-1"></a> `key` | `readonly` | `string` |
| <a id="parent"></a> `parent` | `readonly` | [`RtdbRefHandle`](#rtdbrefhandle) |
| <a id="path-3"></a> `path` | `readonly` | `string` |
| <a id="port-8"></a> `port` | `readonly` | `ClientPort` |
| <a id="root"></a> `root` | `readonly` | [`RtdbRefHandle`](#rtdbrefhandle) |

#### Methods

<a id="tostring"></a>

##### toString()

```ts
toString(): string;
```

###### Returns

`string`

***

<a id="serializedidtokenresult"></a>

### SerializedIdTokenResult

Wire form of `getIdTokenResult()`.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="authtime"></a> `authTime` | `readonly` | `string` |
| <a id="claims"></a> `claims` | `readonly` | `Record`\<`string`, `unknown`\> |
| <a id="expirationtime"></a> `expirationTime` | `readonly` | `string` |
| <a id="issuedattime"></a> `issuedAtTime` | `readonly` | `string` |
| <a id="signinprovider"></a> `signInProvider` | `readonly` | `string` |
| <a id="token"></a> `token` | `readonly` | `string` |

***

<a id="serializeduser"></a>

### SerializedUser

Wire representation of a signed-in `User`. The real `pyric/auth` `User`
carries methods (`getIdToken`, `getIdTokenResult`) that don't survive
structured clone, so the worker flattens the fields the client mirror
needs into a plain object. Token accessors on the client re-RPC to the
worker (the worker holds the one real user).

`null` means "signed out" — there is no current user.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="displayname-2"></a> `displayName` | `readonly` | `string` |
| <a id="email-2"></a> `email` | `readonly` | `string` |
| <a id="emailverified-1"></a> `emailVerified` | `readonly` | `boolean` |
| <a id="isanonymous-1"></a> `isAnonymous` | `readonly` | `boolean` |
| <a id="phonenumber-1"></a> `phoneNumber` | `readonly` | `string` |
| <a id="photourl-1"></a> `photoURL` | `readonly` | `string` |
| <a id="providerdata-1"></a> `providerData` | `readonly` | readonly \{ `displayName`: `string`; `email`: `string`; `phoneNumber`: `string`; `photoURL`: `string`; `providerId`: `string`; `uid`: `string`; \}[] |
| <a id="providerid-3"></a> `providerId` | `readonly` | `string` |
| <a id="uid-2"></a> `uid` | `readonly` | `string` |

***

<a id="serializedusercredential"></a>

### SerializedUserCredential

Wire form of a `UserCredential` returned by the sign-in/create ops.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="operationtype-1"></a> `operationType` | `readonly` | `"signIn"` \| `"reauthenticate"` \| `"link"` |
| <a id="providerid-4"></a> `providerId` | `readonly` | `string` |
| <a id="user-1"></a> `user` | `readonly` | [`SerializedUser`](#serializeduser) |

## Type Aliases

<a id="anyhandle"></a>

### AnyHandle

```ts
type AnyHandle =
  | ClientDb
  | DocRefHandle
  | CollRefHandle
  | QueryHandle;
```

Union of all client handles.

***

<a id="authpersistencemode"></a>

### AuthPersistenceMode

```ts
type AuthPersistenceMode = "LOCAL" | "SESSION" | "NONE";
```

Persistence mode for the worker's shared auth session.
Mirrors `pyric/auth`'s `Persistence.type`. `'NONE'` (inMemoryPersistence)
disables the IndexedDB session record so a full close does NOT keep the
user signed in; `'LOCAL'` and `'SESSION'` both persist the session in
this single-backend model (see SESSION/LOCAL collapse note in host.ts).

***

<a id="presenceclientkind"></a>

### PresenceClientKind

```ts
type PresenceClientKind = "app" | "studio";
```

Logical page kind for presence (#227).

***

<a id="presencevisibility"></a>

### PresenceVisibility

```ts
type PresenceVisibility = "visible" | "hidden";
```

Page Visibility API state carried on presence records.

***

<a id="unsubscribe"></a>

### Unsubscribe()

```ts
type Unsubscribe = () => void;
```

Unsubscribe function returned by every streaming subscription.

#### Returns

`void`

## Variables

<a id="browserlocalpersistence"></a>

### browserLocalPersistence

```ts
const browserLocalPersistence: {
  type: "LOCAL";
};
```

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

<a id="type"></a>

##### type

```ts
readonly type: "LOCAL";
```

***

<a id="browsersessionpersistence"></a>

### browserSessionPersistence

```ts
const browserSessionPersistence: {
  type: "SESSION";
};
```

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

<a id="type-1"></a>

##### type

```ts
readonly type: "SESSION";
```

***

<a id="inmemorypersistence"></a>

### inMemoryPersistence

```ts
const inMemoryPersistence: {
  type: "NONE";
};
```

Persistence markers — mirror `firebase/auth` / `pyric/auth`.

#### Type Declaration

<a id="type-2"></a>

##### type

```ts
readonly type: "NONE";
```

***

<a id="presence_heartbeat_interval_ms"></a>

### PRESENCE\_HEARTBEAT\_INTERVAL\_MS

```ts
const PRESENCE_HEARTBEAT_INTERVAL_MS: 15000 = 15000;
```

Suggested client heartbeat interval.

***

<a id="presence_stale_ms"></a>

### PRESENCE\_STALE\_MS

```ts
const PRESENCE_STALE_MS: 90000 = 90000;
```

Lease TTL. Sized to tolerate one delayed background-tab heartbeat under
typical timer throttling (~1/min) without falsely evicting a live page.

## Functions

<a id="acceptprovidercredential"></a>

### acceptProviderCredential()

```ts
function acceptProviderCredential(auth: ClientAuth, identity: ResolvedIdentity): Promise<ClientUserCredential>;
```

Bridge a provider identity resolved IN-PAGE to the worker (the provider
sign-in seam). The entry adapter's worker-path `signInWithPopup`/
`signInWithRedirect` runs the in-page `AuthFlowResolver` (which can't cross
the worker port), then calls this with the picked identity; the worker seeds
it + signs it in, returning a worker-backed credential. The mirror updates
eagerly (like the email/anon paths) so a synchronous `auth.currentUser`
read right after the await reflects the new user.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |
| `identity` | [`ResolvedIdentity`](#resolvedidentity) |

#### Returns

`Promise`\<[`ClientUserCredential`](#clientusercredential)\>

***

<a id="adddoc"></a>

### addDoc()

```ts
function addDoc(coll: CollRefHandle, data: Record<string, unknown>): Promise<DocRefHandle>;
```

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

| Parameter | Type |
| :------ | :------ |
| `coll` | [`CollRefHandle`](#collrefhandle) |
| `data` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<[`DocRefHandle`](#docrefhandle)\>

***

<a id="adminclearusers"></a>

### adminClearUsers()

```ts
function adminClearUsers(auth: ClientAuth): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |

#### Returns

`Promise`\<`void`\>

***

<a id="admincreateuser"></a>

### adminCreateUser()

```ts
function adminCreateUser(auth: ClientAuth, request: CreateUserRequest): Promise<AuthUserRecord>;
```

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

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |
| `request` | `CreateUserRequest` |

#### Returns

`Promise`\<`AuthUserRecord`\>

***

<a id="admindeletedocument"></a>

### adminDeleteDocument()

```ts
function adminDeleteDocument(db: ClientDb, path: string): Promise<boolean>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `path` | `string` |

#### Returns

`Promise`\<`boolean`\>

***

<a id="admindeletertdbvalue"></a>

### adminDeleteRtdbValue()

```ts
function adminDeleteRtdbValue(db: ClientDb | ClientRtdb, path: string): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) \| [`ClientRtdb`](#clientrtdb) |
| `path` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="admindeleteuser"></a>

### adminDeleteUser()

```ts
function adminDeleteUser(auth: ClientAuth, uid: string): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |
| `uid` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="admingetdocument"></a>

### adminGetDocument()

```ts
function adminGetDocument(db: ClientDb, path: string): Promise<Record<string, unknown>>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `path` | `string` |

#### Returns

`Promise`\<`Record`\<`string`, `unknown`\>\>

***

<a id="adminlistdocuments"></a>

### adminListDocuments()

```ts
function adminListDocuments(db: ClientDb, path: string): Promise<{
  data: unknown;
  path: string;
  phantom?: boolean;
}[]>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `path` | `string` |

#### Returns

`Promise`\<\{
  `data`: `unknown`;
  `path`: `string`;
  `phantom?`: `boolean`;
\}[]\>

***

<a id="adminreadrtdbstate"></a>

### adminReadRtdbState()

```ts
function adminReadRtdbState(db: ClientDb | ClientRtdb): Promise<unknown>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) \| [`ClientRtdb`](#clientrtdb) |

#### Returns

`Promise`\<`unknown`\>

***

<a id="adminreadstate"></a>

### adminReadState()

```ts
function adminReadState(db: ClientDb, opts?: {
  maxDepth?: number;
  path?: string;
}): Promise<Record<string, unknown>>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `opts?` | \{ `maxDepth?`: `number`; `path?`: `string`; \} |
| `opts.maxDepth?` | `number` |
| `opts.path?` | `string` |

#### Returns

`Promise`\<`Record`\<`string`, `unknown`\>\>

***

<a id="adminsetdocument"></a>

### adminSetDocument()

```ts
function adminSetDocument(
   db: ClientDb,
   path: string,
data: unknown): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `path` | `string` |
| `data` | `unknown` |

#### Returns

`Promise`\<`void`\>

***

<a id="adminsetrtdbvalue"></a>

### adminSetRtdbValue()

```ts
function adminSetRtdbValue(
   db: ClientDb | ClientRtdb,
   path: string,
value: unknown): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) \| [`ClientRtdb`](#clientrtdb) |
| `path` | `string` |
| `value` | `unknown` |

#### Returns

`Promise`\<`void`\>

***

<a id="adminsubscribertdbvalue"></a>

### adminSubscribeRtdbValue()

```ts
function adminSubscribeRtdbValue(
   db: ClientDb | ClientRtdb,
   path: string,
   next: (value: unknown) => void,
   error?: (err: unknown) => void): Unsubscribe;
```

Subscribe to the raw value at an RTDB path with the ADMIN lens (Pyric Studio
data viewer). Rides the same `{service:'rtdb'}` value-subscription channel as
`rtdbOnValue`, but pins `actAs: {mode:'admin'}` per-sub instead of following
the module default lens, so Studio's viewer stays admin (PRINCIPLES M3) while
the page's own listeners keep their session semantics.

`next` receives the plain JSON value at `path` (`null` when absent) on
subscribe and again after every write that changes the subtree.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) \| [`ClientRtdb`](#clientrtdb) |
| `path` | `string` |
| `next` | (`value`: `unknown`) => `void` |
| `error?` | (`err`: `unknown`) => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="adminupdatertdbvalue"></a>

### adminUpdateRtdbValue()

```ts
function adminUpdateRtdbValue(
   db: ClientDb | ClientRtdb,
   path: string,
values: Record<string, unknown>): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) \| [`ClientRtdb`](#clientrtdb) |
| `path` | `string` |
| `values` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<`void`\>

***

<a id="adminupdateuser"></a>

### adminUpdateUser()

```ts
function adminUpdateUser(
   auth: ClientAuth,
   uid: string,
request: UpdateUserRequest): Promise<AuthUserRecord>;
```

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

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |
| `uid` | `string` |
| `request` | `UpdateUserRequest` |

#### Returns

`Promise`\<`AuthUserRecord`\>

***

<a id="and"></a>

### and()

```ts
function and(...filters: QueryConstraintHandle[]): QueryConstraintHandle;
```

AND composite filter — every operand must match. See [or](#or).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`filters` | `QueryConstraintHandle`[] |

#### Returns

`QueryConstraintHandle`

***

<a id="arrayremove"></a>

### arrayRemove()

```ts
function arrayRemove(...values: unknown[]): SentinelMarker;
```

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

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

#### Returns

`SentinelMarker`

***

<a id="arrayunion"></a>

### arrayUnion()

```ts
function arrayUnion(...values: unknown[]): SentinelMarker;
```

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

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

#### Returns

`SentinelMarker`

***

<a id="average"></a>

### average()

```ts
function average(field: string): AggregateFieldDescriptor;
```

Factory: average-of-`field` aggregate. Empty input yields `null`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

`AggregateFieldDescriptor`

***

<a id="calltool"></a>

### callTool()

```ts
function callTool(
   db: ClientDb,
   name: string,
   args: Record<string, unknown>): Promise<{
  data?: unknown;
  ok: boolean;
  summary: string;
}>;
```

Forward an agent tool-call to the worker so it executes against the SAME
sandbox the app + Studio use. The worker runs the canonical tool dispatcher
(`buildSandboxDispatcher`) and replies with the `{ ok, summary, data }`
result. Used by the bridge peer on the worker path (`connectBridgePeer` in
`entries/runtime.ts`) so the agent shares the one authoritative sandbox.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `name` | `string` |
| `args` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<\{
  `data?`: `unknown`;
  `ok`: `boolean`;
  `summary`: `string`;
\}\>

***

<a id="collection"></a>

### collection()

```ts
function collection(parent: ClientDb | DocRefHandle, ...pathSegments: string[]): CollRefHandle;
```

Build a collection reference. Mirrors `pyric/firestore`'s `collection(db, path)`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `parent` | [`ClientDb`](#clientdb) \| [`DocRefHandle`](#docrefhandle) |
| ...`pathSegments` | `string`[] |

#### Returns

[`CollRefHandle`](#collrefhandle)

***

<a id="collectiongroup"></a>

### collectionGroup()

```ts
function collectionGroup(db: ClientDb, collectionId: string): QueryHandle;
```

Build a collection-group query. Mirrors `pyric/firestore`'s `collectionGroup(db, id)`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `collectionId` | `string` |

#### Returns

[`QueryHandle`](#queryhandle)

***

<a id="connectauthemulator"></a>

### connectAuthEmulator()

```ts
function connectAuthEmulator(
   _auth: ClientAuth,
   _url: string,
   _options?: {
  disableWarnings?: boolean;
}): void;
```

Connect to the auth emulator. No-op shim over the worker: the worker's
sandbox IS the emulator-equivalent backend, so there's nothing to point at.
Present for surface parity so app code that calls it doesn't break.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `_auth` | [`ClientAuth`](#clientauth) |
| `_url` | `string` |
| `_options?` | \{ `disableWarnings?`: `boolean`; \} |
| `_options.disableWarnings?` | `boolean` |

#### Returns

`void`

***

<a id="count"></a>

### count()

```ts
function count(): AggregateFieldDescriptor;
```

Factory: count() aggregate field. Mirrors `pyric/firestore`'s `count()`.

#### Returns

`AggregateFieldDescriptor`

***

<a id="createuserwithemailandpassword"></a>

### createUserWithEmailAndPassword()

```ts
function createUserWithEmailAndPassword(
   auth: ClientAuth,
   email: string,
password: string): Promise<ClientUserCredential>;
```

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

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |
| `email` | `string` |
| `password` | `string` |

#### Returns

`Promise`\<[`ClientUserCredential`](#clientusercredential)\>

***

<a id="deletedoc"></a>

### deleteDoc()

```ts
function deleteDoc(ref: DocRefHandle): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocRefHandle`](#docrefhandle) |

#### Returns

`Promise`\<`void`\>

***

<a id="deletefield"></a>

### deleteField()

```ts
function deleteField(): SentinelMarker;
```

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

<a id="deleteobject"></a>

### deleteObject()

```ts
function deleteObject(reference: ClientStorageReference): Promise<void>;
```

Delete the object at the reference's path (idempotent — missing = no-op,
 matching the sandbox backend's delete semantics).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `reference` | [`ClientStorageReference`](#clientstoragereference) |

#### Returns

`Promise`\<`void`\>

***

<a id="deleteworkerbranch"></a>

### deleteWorkerBranch()

```ts
function deleteWorkerBranch(db: ClientDb, name: string): Promise<void>;
```

Phase 3: delete a named branch.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `name` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="doc"></a>

### doc()

```ts
function doc(parent: ClientDb | CollRefHandle, ...pathSegments: string[]): DocRefHandle;
```

Build a document reference. Mirrors `pyric/firestore`'s `doc(db, path)`.

WHY CLIENT-SIDE: Firebase's `doc()` is synchronous and path-only — it
needs no data from the sandbox. We build a descriptor object here and
include the port so execution calls can route to the worker.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `parent` | [`ClientDb`](#clientdb) \| [`CollRefHandle`](#collrefhandle) |
| ...`pathSegments` | `string`[] |

#### Returns

[`DocRefHandle`](#docrefhandle)

***

<a id="endat"></a>

### endAt()

```ts
function endAt(...values: unknown[]): QueryConstraintHandle;
```

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

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

#### Returns

`QueryConstraintHandle`

***

<a id="endbefore"></a>

### endBefore()

```ts
function endBefore(...values: unknown[]): QueryConstraintHandle;
```

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

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

#### Returns

`QueryConstraintHandle`

***

<a id="eventhistory"></a>

### eventHistory()

```ts
function eventHistory(db: ClientDb): Promise<readonly SandboxEvent[]>;
```

Fetch the worker sandbox's event history as a one-shot snapshot (every event
so far). Opens a transient stream sub, resolves with the initial history
batch, and tears the sub down immediately — so it never holds a live
subscription. Useful for a late, snapshot-only consumer.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |

#### Returns

`Promise`\<readonly `SandboxEvent`[]\>

***

<a id="exportworkerstate"></a>

### exportWorkerState()

```ts
function exportWorkerState(db: ClientDb): Promise<string>;
```

Phase 2 (transfer): export the FULL sandbox state as a portable bundle string
(the chunk format the persist layer uses, so wrapper types round-trip). Save
it to a file and [importWorkerState](#importworkerstate) it into another instance.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |

#### Returns

`Promise`\<`string`\>

***

<a id="getactiverules"></a>

### getActiveRules()

```ts
function getActiveRules(db: ClientDb | ClientRtdb, service?: "firestore" | "database"): Promise<unknown>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) \| [`ClientRtdb`](#clientrtdb) |
| `service?` | `"firestore"` \| `"database"` |

#### Returns

`Promise`\<`unknown`\>

***

<a id="getaggregatefromserver"></a>

### getAggregateFromServer()

```ts
function getAggregateFromServer<S>(source: CollRefHandle | QueryHandle, spec: S): Promise<{
  data: { [K in string | number | symbol]: number };
}>;
```

Run a multi-field aggregate on the worker. Mirrors `pyric/firestore`'s
`getAggregateFromServer(query, spec)`: spec entries are keyed by
caller-chosen aliases; `.data()` returns the numbers under the same keys
(`average` over no rows is `null`).

#### Type Parameters

| Type Parameter |
| :------ |
| `S` *extends* `AggregateSpecDescriptor` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | [`CollRefHandle`](#collrefhandle) \| [`QueryHandle`](#queryhandle) |
| `spec` | `S` |

#### Returns

`Promise`\<\{
  `data`: \{ \[K in string \| number \| symbol\]: number \};
\}\>

***

<a id="getauth"></a>

### getAuth()

```ts
function getAuth(source: string | ClientDb | URL, name?: string): ClientAuth;
```

Get the worker-backed Auth handle.

Mirrors `pyric/auth`'s `getAuth(sandbox)` / `firebase/auth`'s
`getAuth(app)` — but the input is either an existing `ClientDb` (reusing
its port, the common case in serve where Firestore + auth share one
worker) or a worker URL (standalone).

The returned handle seeds its `currentUser` mirror by opening an internal
authState subscription that keeps it live across tabs.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | `string` \| [`ClientDb`](#clientdb) \| `URL` |
| `name?` | `string` |

#### Returns

[`ClientAuth`](#clientauth)

***

<a id="getblob"></a>

### getBlob()

```ts
function getBlob(reference: ClientStorageReference): Promise<Blob>;
```

Read an object's bytes as a Blob (Pyric Studio inspector preview).
 MessagePort-only — a Blob cannot cross the JSON bridge relay.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `reference` | [`ClientStorageReference`](#clientstoragereference) |

#### Returns

`Promise`\<`Blob`\>

***

<a id="getbytes"></a>

### getBytes()

```ts
function getBytes(reference: ClientStorageReference, maxDownloadSizeBytes?: number): Promise<ArrayBuffer>;
```

Read an object's bytes (JSON-safe base64 op → `ArrayBuffer`). Mirrors
 `pyric/storage`'s `getBytes`, including the optional client-side cap.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `reference` | [`ClientStorageReference`](#clientstoragereference) |
| `maxDownloadSizeBytes?` | `number` |

#### Returns

`Promise`\<`ArrayBuffer`\>

***

<a id="getcountfromserver"></a>

### getCountFromServer()

```ts
function getCountFromServer(source: CollRefHandle | QueryHandle): Promise<{
  data: {
     count: number;
  };
}>;
```

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

| Parameter | Type |
| :------ | :------ |
| `source` | [`CollRefHandle`](#collrefhandle) \| [`QueryHandle`](#queryhandle) |

#### Returns

`Promise`\<\{
  `data`: \{
     `count`: `number`;
  \};
\}\>

***

<a id="getdoc"></a>

### getDoc()

```ts
function getDoc(ref: DocRefHandle): Promise<ClientDocSnapshot>;
```

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

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocRefHandle`](#docrefhandle) |

#### Returns

`Promise`\<[`ClientDocSnapshot`](#clientdocsnapshot)\>

***

<a id="getdocs"></a>

### getDocs()

```ts
function getDocs(source: CollRefHandle | QueryHandle): Promise<ClientQuerySnapshot>;
```

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

| Parameter | Type |
| :------ | :------ |
| `source` | [`CollRefHandle`](#collrefhandle) \| [`QueryHandle`](#queryhandle) |

#### Returns

`Promise`\<[`ClientQuerySnapshot`](#clientquerysnapshot)\>

***

<a id="getdownloadurl"></a>

### getDownloadURL()

```ts
function getDownloadURL(reference: ClientStorageReference): Promise<string>;
```

Return a page-owned URL for an object read through the SharedWorker.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `reference` | [`ClientStorageReference`](#clientstoragereference) |

#### Returns

`Promise`\<`string`\>

***

<a id="getfirestore"></a>

### getFirestore()

```ts
function getFirestore(workerUrl: string | URL, name?: string): ClientDb;
```

Connect to the SharedWorker and return a client Firestore handle.

Pass the URL of the SharedWorker script as `workerUrl`. Under `pyric dev`
this is `/__pyric/sdk/worker.js`; for tests or standalone use, pass the path
explicitly.

`getFirestore` mirrors `pyric/firestore`'s `getFirestore(sandbox)` shape
but returns a `ClientDb` backed by a `MessagePort` instead of a sandbox.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `workerUrl` | `string` \| `URL` |
| `name?` | `string` |

#### Returns

[`ClientDb`](#clientdb)

***

<a id="getidtoken-2"></a>

### getIdToken()

```ts
function getIdToken(user: ClientUser, forceRefresh?: boolean): Promise<string>;
```

Top-level mirror of `firebase/auth`'s `getIdToken(user)`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`ClientUser`](#clientuser) |
| `forceRefresh?` | `boolean` |

#### Returns

`Promise`\<`string`\>

***

<a id="getidtokenresult-2"></a>

### getIdTokenResult()

```ts
function getIdTokenResult(user: ClientUser, forceRefresh?: boolean): Promise<SerializedIdTokenResult>;
```

Top-level mirror of `firebase/auth`'s `getIdTokenResult(user)`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `user` | [`ClientUser`](#clientuser) |
| `forceRefresh?` | `boolean` |

#### Returns

`Promise`\<[`SerializedIdTokenResult`](#serializedidtokenresult)\>

***

<a id="getlens"></a>

### getLens()

```ts
function getLens(): any;
```

The active default lens (read-only view), for Studio UI to reflect state.

#### Returns

`any`

***

<a id="getmetadata"></a>

### getMetadata()

```ts
function getMetadata(reference: ClientStorageReference): Promise<FullMetadata>;
```

Read an object's metadata (Pyric Studio inspector).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `reference` | [`ClientStorageReference`](#clientstoragereference) |

#### Returns

`Promise`\<`FullMetadata`\>

***

<a id="getproviderconfig"></a>

### getProviderConfig()

```ts
function getProviderConfig(auth: ClientAuth): Promise<{
  enabled: boolean;
  providerId: string;
}[]>;
```

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

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |

#### Returns

`Promise`\<\{
  `enabled`: `boolean`;
  `providerId`: `string`;
\}[]\>

***

<a id="getrulesstatus"></a>

### getRulesStatus()

```ts
function getRulesStatus(db: ClientDb | ClientRtdb, service?: "firestore" | "database"): Promise<unknown>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) \| [`ClientRtdb`](#clientrtdb) |
| `service?` | `"firestore"` \| `"database"` |

#### Returns

`Promise`\<`unknown`\>

***

<a id="getsnapshot"></a>

### getSnapshot()

```ts
function getSnapshot(db: ClientDb): Promise<SandboxSnapshot>;
```

Export the current sandbox snapshot (Pyric Studio rules re-run). Studio forks
it locally to test a denied op against edited rules or re-issue it as the
attempting user, on a throwaway branch (no live mutation).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |

#### Returns

`Promise`\<`SandboxSnapshot`\>

***

<a id="getstorage"></a>

### getStorage()

```ts
function getStorage(source: string | ClientDb | URL, name?: string): ClientFirebaseStorage;
```

Get the worker-backed Storage handle. Like `getAuth`, accepts an existing
`ClientDb` (reusing its port) or a worker URL (standalone).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | `string` \| [`ClientDb`](#clientdb) \| `URL` |
| `name?` | `string` |

#### Returns

[`ClientFirebaseStorage`](#clientfirebasestorage)

***

<a id="getworkerinstanceid"></a>

### getWorkerInstanceId()

```ts
function getWorkerInstanceId(db: ClientDb): Promise<string>;
```

Ask the worker for its stable per-instance id (see host `INSTANCE_ID_KEY`).
Studio renders a human-friendly form so a user can tell which sandbox instance
they're looking at — the same `localhost:<port>` in a different browser profile
is a SEPARATE sandbox (a separate SharedWorker + IndexedDB), and this is how
the two are told apart.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |

#### Returns

`Promise`\<`string`\>

***

<a id="getworkerversion"></a>

### getWorkerVersion()

```ts
function getWorkerVersion(db: ClientDb): Promise<string>;
```

Ask the worker for its baked build version (staleness guard). The page
compares it to the served bundle version and warns when a still-running OLD
worker is older than what's served (a SharedWorker can't hot-update).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |

#### Returns

`Promise`\<`string`\>

***

<a id="importworkerstate"></a>

### importWorkerState()

```ts
function importWorkerState(db: ClientDb, bundle: string): Promise<void>;
```

Phase 2 (clobber): replace this sandbox's ENTIRE state with `bundle`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `bundle` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="increment"></a>

### increment()

```ts
function increment(n: number): SentinelMarker;
```

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

| Parameter | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

`SentinelMarker`

***

<a id="limit"></a>

### limit()

```ts
function limit(n: number): QueryConstraintHandle;
```

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

| Parameter | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

`QueryConstraintHandle`

***

<a id="limittolast"></a>

### limitToLast()

```ts
function limitToLast(n: number): QueryConstraintHandle;
```

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

| Parameter | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

`QueryConstraintHandle`

***

<a id="listall"></a>

### listAll()

```ts
function listAll(reference: ClientStorageReference): Promise<{
  items: ClientStorageReference[];
  prefixes: ClientStorageReference[];
}>;
```

Enumerate immediate child items + sub-prefixes under a ref (Pyric Studio
 data browse). The host enforces `read` rules on the scanned prefix.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `reference` | [`ClientStorageReference`](#clientstoragereference) |

#### Returns

`Promise`\<\{
  `items`: [`ClientStorageReference`](#clientstoragereference)[];
  `prefixes`: [`ClientStorageReference`](#clientstoragereference)[];
\}\>

***

<a id="listrootcollections"></a>

### listRootCollections()

```ts
function listRootCollections(db: ClientDb): Promise<string[]>;
```

Enumerate root collection ids (Pyric Studio data browse). The modular SDK has
no client `listCollections`, so the host scans the sandbox keyspace and
returns the ids. Lens is attached (via dataRpc) but the host enumeration is
lens-independent.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |

#### Returns

`Promise`\<`string`[]\>

***

<a id="listsubcollections"></a>

### listSubcollections()

```ts
function listSubcollections(db: ClientDb, docPath: string): Promise<string[]>;
```

Enumerate subcollection ids under a document path (Pyric Studio data browse).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `docPath` | `string` |

#### Returns

`Promise`\<`string`[]\>

***

<a id="listusers"></a>

### listUsers()

```ts
function listUsers(auth: ClientAuth): Promise<AuthUserRecord[]>;
```

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

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |

#### Returns

`Promise`\<`AuthUserRecord`[]\>

***

<a id="listworkerbranches"></a>

### listWorkerBranches()

```ts
function listWorkerBranches(db: ClientDb): Promise<string[]>;
```

Phase 3: list this instance's saved branch names.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |

#### Returns

`Promise`\<`string`[]\>

***

<a id="mintpresenceclientid"></a>

### mintPresenceClientId()

```ts
function mintPresenceClientId(): string;
```

Mint a random client id (page-lifetime).

#### Returns

`string`

***

<a id="onauthstatechanged"></a>

### onAuthStateChanged()

```ts
function onAuthStateChanged(auth: ClientAuth, callback: (user: ClientUser) => void): Unsubscribe;
```

Subscribe to auth-state changes. Mirrors `firebase/auth`'s
`onAuthStateChanged`. Fires immediately with THIS PORT's current session,
then on every change to it (#754: sessions are per-port — another tab's
sign-in is a different user, not an update to this one). Updates the
handle's `currentUser` mirror before invoking the callback.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |
| `callback` | (`user`: [`ClientUser`](#clientuser)) => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="onidtokenchanged"></a>

### onIdTokenChanged()

```ts
function onIdTokenChanged(auth: ClientAuth, callback: (user: ClientUser) => void): Unsubscribe;
```

Subscribe to ID-token changes. Mirrors `firebase/auth`'s
`onIdTokenChanged` — fires on THIS PORT's identity transitions (per-port
sessions, #754).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |
| `callback` | (`user`: [`ClientUser`](#clientuser)) => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="onsnapshot"></a>

### onSnapshot()

```ts
function onSnapshot(
   target:
  | DocRefHandle
  | CollRefHandle
  | QueryHandle,
   callback: (snap:
  | ClientDocSnapshot
  | ClientQuerySnapshot) => void,
   errorCallback?: (err: unknown) => void): Unsubscribe;
```

Subscribe to a document or query. Mirrors `pyric/firestore`'s `onSnapshot`.

Returns an `unsub` function. Sends `{ t:'unsub', subId }` to the worker
to deregister the listener on the worker side.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `target` | \| [`DocRefHandle`](#docrefhandle) \| [`CollRefHandle`](#collrefhandle) \| [`QueryHandle`](#queryhandle) |
| `callback` | (`snap`: \| [`ClientDocSnapshot`](#clientdocsnapshot) \| [`ClientQuerySnapshot`](#clientquerysnapshot)) => `void` |
| `errorCallback?` | (`err`: `unknown`) => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="or"></a>

### or()

```ts
function or(...filters: QueryConstraintHandle[]): QueryConstraintHandle;
```

OR composite filter — at least one operand must match. Operands must be
filters (`where()`, or nested `or()`/`and()`). Mirrors `pyric/firestore`'s
`or(...)`; the worker rebuilds it with the real modular factory.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`filters` | `QueryConstraintHandle`[] |

#### Returns

`QueryConstraintHandle`

***

<a id="orderby"></a>

### orderBy()

```ts
function orderBy(field: string, direction?: "asc" | "desc"): QueryConstraintHandle;
```

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

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |
| `direction?` | `"asc"` \| `"desc"` |

#### Returns

`QueryConstraintHandle`

***

<a id="query"></a>

### query()

```ts
function query(source: CollRefHandle | QueryHandle, ...constraints: QueryConstraintHandle[]): QueryHandle;
```

Apply query constraints to a source ref or query.
Mirrors `pyric/firestore`'s `query(source, ...constraints)`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | [`CollRefHandle`](#collrefhandle) \| [`QueryHandle`](#queryhandle) |
| ...`constraints` | `QueryConstraintHandle`[] |

#### Returns

[`QueryHandle`](#queryhandle)

***

<a id="ref-2"></a>

### ref()

```ts
function ref(parent:
  | ClientFirebaseStorage
  | ClientStorageReference, path?: string): ClientStorageReference;
```

Build a Storage reference. Mirrors `pyric/storage`'s `ref(storage, path?)` /
 `ref(parentRef, path)`. Client-side path math; no RPC.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `parent` | \| [`ClientFirebaseStorage`](#clientfirebasestorage) \| [`ClientStorageReference`](#clientstoragereference) |
| `path?` | `string` |

#### Returns

[`ClientStorageReference`](#clientstoragereference)

***

<a id="relayworkerop"></a>

### relayWorkerOp()

```ts
function relayWorkerOp(db: ClientDb, op: WorkerOpPayload): Promise<unknown>;
```

Relay one raw worker-protocol op into the SharedWorker. `op` is the op
message minus `t`/`id` (the `WorkerOpPayload` wire shape); resolves with
the worker's `res.value`, rejects with an Error carrying `.code`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `op` | `WorkerOpPayload` |

#### Returns

`Promise`\<`unknown`\>

***

<a id="relayworkersub"></a>

### relayWorkerSub()

```ts
function relayWorkerSub(
   db: ClientDb,
   sub: WorkerSubPayload,
   onValue: (value: unknown) => void): () => void;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `sub` | `WorkerSubPayload` |
| `onValue` | (`value`: `unknown`) => `void` |

#### Returns

```ts
(): void;
```

##### Returns

`void`

***

<a id="rtdbchild"></a>

### rtdbChild()

```ts
function rtdbChild(parent: RtdbRefHandle, path: string): RtdbRefHandle;
```

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

| Parameter | Type |
| :------ | :------ |
| `parent` | [`RtdbRefHandle`](#rtdbrefhandle) |
| `path` | `string` |

#### Returns

[`RtdbRefHandle`](#rtdbrefhandle)

***

<a id="rtdbconnectdatabaseemulator"></a>

### rtdbConnectDatabaseEmulator()

```ts
function rtdbConnectDatabaseEmulator(): void;
```

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

<a id="rtdbget"></a>

### rtdbGet()

```ts
function rtdbGet(r: RtdbRefHandle): Promise<RtdbDataSnapshot>;
```

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

| Parameter | Type |
| :------ | :------ |
| `r` | [`RtdbRefHandle`](#rtdbrefhandle) |

#### Returns

`Promise`\<[`RtdbDataSnapshot`](#rtdbdatasnapshot)\>

***

<a id="rtdbgetdatabase"></a>

### rtdbGetDatabase()

```ts
function rtdbGetDatabase(source?: string | ClientDb | URL, name?: string): ClientRtdb;
```

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

| Parameter | Type |
| :------ | :------ |
| `source?` | `string` \| [`ClientDb`](#clientdb) \| `URL` |
| `name?` | `string` |

#### Returns

[`ClientRtdb`](#clientrtdb)

***

<a id="rtdboff"></a>

### rtdbOff()

```ts
function rtdbOff(
   _r: RtdbRefHandle,
   _eventType?: unknown,
   _callback?: unknown): void;
```

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

| Parameter | Type |
| :------ | :------ |
| `_r` | [`RtdbRefHandle`](#rtdbrefhandle) |
| `_eventType?` | `unknown` |
| `_callback?` | `unknown` |

#### Returns

`void`

***

<a id="rtdbonvalue"></a>

### rtdbOnValue()

```ts
function rtdbOnValue(
   r: RtdbRefHandle,
   next: (snap: RtdbDataSnapshot) => void,
   error?: (err: unknown) => void): Unsubscribe;
```

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

| Parameter | Type |
| :------ | :------ |
| `r` | [`RtdbRefHandle`](#rtdbrefhandle) |
| `next` | (`snap`: [`RtdbDataSnapshot`](#rtdbdatasnapshot)) => `void` |
| `error?` | (`err`: `unknown`) => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="rtdbpush"></a>

### rtdbPush()

```ts
function rtdbPush(r: RtdbRefHandle, value?: unknown): RtdbRefHandle & PromiseLike<RtdbRefHandle>;
```

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

| Parameter | Type |
| :------ | :------ |
| `r` | [`RtdbRefHandle`](#rtdbrefhandle) |
| `value?` | `unknown` |

#### Returns

[`RtdbRefHandle`](#rtdbrefhandle) & `PromiseLike`\<[`RtdbRefHandle`](#rtdbrefhandle)\>

***

<a id="rtdbref"></a>

### rtdbRef()

```ts
function rtdbRef(db: ClientRtdb, path?: string): RtdbRefHandle;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientRtdb`](#clientrtdb) |
| `path?` | `string` |

#### Returns

[`RtdbRefHandle`](#rtdbrefhandle)

***

<a id="rtdbremove"></a>

### rtdbRemove()

```ts
function rtdbRemove(r: RtdbRefHandle): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `r` | [`RtdbRefHandle`](#rtdbrefhandle) |

#### Returns

`Promise`\<`void`\>

***

<a id="rtdbservertimestamp"></a>

### rtdbServerTimestamp()

```ts
function rtdbServerTimestamp(): {
};
```

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

```ts
{
}
```

***

<a id="rtdbset"></a>

### rtdbSet()

```ts
function rtdbSet(r: RtdbRefHandle, value: unknown): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `r` | [`RtdbRefHandle`](#rtdbrefhandle) |
| `value` | `unknown` |

#### Returns

`Promise`\<`void`\>

***

<a id="rtdbupdate"></a>

### rtdbUpdate()

```ts
function rtdbUpdate(r: RtdbRefHandle, values: Record<string, unknown>): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `r` | [`RtdbRefHandle`](#rtdbrefhandle) |
| `values` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<`void`\>

***

<a id="runtransaction"></a>

### runTransaction()

```ts
function runTransaction<R>(db: ClientDb, updateFn: (txn: ClientTransaction) => R | Promise<R>): Promise<R>;
```

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

| Type Parameter |
| :------ |
| `R` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `updateFn` | (`txn`: [`ClientTransaction`](#clienttransaction)) => `R` \| `Promise`\<`R`\> |

#### Returns

`Promise`\<`R`\>

***

<a id="saveworkerbranch"></a>

### saveWorkerBranch()

```ts
function saveWorkerBranch(db: ClientDb, name: string): Promise<void>;
```

Phase 3: save the live sandbox as a named branch (a saved state bundle).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `name` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="servertimestamp"></a>

### serverTimestamp()

```ts
function serverTimestamp(): SentinelMarker;
```

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

<a id="setdatabaserules"></a>

### setDatabaseRules()

```ts
function setDatabaseRules(db: ClientDb | ClientRtdb, source: unknown): Promise<{
  messages: unknown[];
  ok: boolean;
}>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) \| [`ClientRtdb`](#clientrtdb) |
| `source` | `unknown` |

#### Returns

`Promise`\<\{
  `messages`: `unknown`[];
  `ok`: `boolean`;
\}\>

***

<a id="setdoc"></a>

### setDoc()

```ts
function setDoc(
   ref: DocRefHandle,
   data: Record<string, unknown>,
   options?: {
  merge?: boolean;
  mergeFields?: string[];
}): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocRefHandle`](#docrefhandle) |
| `data` | `Record`\<`string`, `unknown`\> |
| `options?` | \{ `merge?`: `boolean`; `mergeFields?`: `string`[]; \} |
| `options.merge?` | `boolean` |
| `options.mergeFields?` | `string`[] |

#### Returns

`Promise`\<`void`\>

***

<a id="setfirestorerules"></a>

### setFirestoreRules()

```ts
function setFirestoreRules(db: ClientDb, source: string): Promise<{
  messages: unknown[];
  ok: boolean;
  warnings: unknown[];
}>;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `source` | `string` |

#### Returns

`Promise`\<\{
  `messages`: `unknown`[];
  `ok`: `boolean`;
  `warnings`: `unknown`[];
\}\>

***

<a id="setlens"></a>

### setLens()

```ts
function setLens(lens: any): void;
```

Set the default auth lens applied to subsequent Firestore DATA ops from this
client (Pyric Studio). Pass `{ mode: 'as', uid }` to read/write AS a user
(rules apply), `{ mode: 'admin' }` for the admin lens, or
`{ mode: 'app-session' }` / `undefined` to revert to the app's own session.

The lens is process-wide for this client module (one served page = one
worker port), mirroring how Studio drives a single active identity at a time.
Auth ops are unaffected — they always operate the real session.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `lens` | `any` |

#### Returns

`void`

***

<a id="setopissuer"></a>

### setOpIssuer()

```ts
function setOpIssuer(source: "studio"): void;
```

Declare who issues the ops this client module constructs. See \_opIssuer.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | `"studio"` |

#### Returns

`void`

***

<a id="setpersistence"></a>

### setPersistence()

```ts
function setPersistence(auth: ClientAuth, persistence: ClientPersistence): Promise<void>;
```

Record the session-persistence mode on the worker (surface parity). The
effective persistence is CLIENT-side (#754): the entry adapter mirrors the
mode into the page's SessionStore, which decides where — or whether — this
tab's session uid is stored for reload restore.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |
| `persistence` | `ClientPersistence` |

#### Returns

`Promise`\<`void`\>

***

<a id="setproviderconfig"></a>

### setProviderConfig()

```ts
function setProviderConfig(
   auth: ClientAuth,
   providerId: string,
enabled: boolean): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |
| `providerId` | `string` |
| `enabled` | `boolean` |

#### Returns

`Promise`\<`void`\>

***

<a id="setrules"></a>

### setRules()

```ts
function setRules(db: ClientDb, source: string): Promise<{
  warnings: unknown[];
}>;
```

Deploy new rules to the worker's sandbox. Active onSnapshot listeners
that were allowed by the old rules may start receiving error callbacks
if the new rules deny them.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `source` | `string` |

#### Returns

`Promise`\<\{
  `warnings`: `unknown`[];
\}\>

***

<a id="signinanonymously"></a>

### signInAnonymously()

```ts
function signInAnonymously(auth: ClientAuth): Promise<ClientUserCredential>;
```

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

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |

#### Returns

`Promise`\<[`ClientUserCredential`](#clientusercredential)\>

***

<a id="signinwithemailandpassword"></a>

### signInWithEmailAndPassword()

```ts
function signInWithEmailAndPassword(
   auth: ClientAuth,
   email: string,
password: string): Promise<ClientUserCredential>;
```

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

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |
| `email` | `string` |
| `password` | `string` |

#### Returns

`Promise`\<[`ClientUserCredential`](#clientusercredential)\>

***

<a id="signout"></a>

### signOut()

```ts
function signOut(auth: ClientAuth): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `auth` | [`ClientAuth`](#clientauth) |

#### Returns

`Promise`\<`void`\>

***

<a id="startafter"></a>

### startAfter()

```ts
function startAfter(...values: unknown[]): QueryConstraintHandle;
```

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

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

#### Returns

`QueryConstraintHandle`

***

<a id="startat"></a>

### startAt()

```ts
function startAt(...values: unknown[]): QueryConstraintHandle;
```

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

| Parameter | Type |
| :------ | :------ |
| ...`values` | `unknown`[] |

#### Returns

`QueryConstraintHandle`

***

<a id="startpresence"></a>

### startPresence()

```ts
function startPresence(opts: StartPresenceOptions): PresenceSession;
```

Register this page with the worker and keep the lease alive until
[PresenceSession.stop](#stop) or `pagehide`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `opts` | `StartPresenceOptions` |

#### Returns

[`PresenceSession`](#presencesession)

***

<a id="subscribeevents"></a>

### subscribeEvents()

```ts
function subscribeEvents(db: ClientDb, callback: (events: readonly SandboxEvent[]) => void): Unsubscribe;
```

Subscribe to the worker sandbox's unified event stream. The callback fires
with each delivered BATCH of events — the FIRST call carries the initial
`history()` snapshot (possibly empty), each subsequent call carries one live
event. Returns an unsubscribe that deregisters on the worker.

This is the live counterpart to `sandbox.onEvent` + an initial `history()`
fold, collapsed into one subscription so a late subscriber never misses the
backlog.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `callback` | (`events`: readonly `SandboxEvent`[]) => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="subscribepresence"></a>

### subscribePresence()

```ts
function subscribePresence(db: ClientDb, callback: (snapshot: PresenceSnapshot) => void): Unsubscribe;
```

Subscribe to the worker's authoritative presence snapshot. The callback
fires immediately with the current snapshot, then on every change.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `callback` | (`snapshot`: [`PresenceSnapshot`](#presencesnapshot)) => `void` |

#### Returns

[`Unsubscribe`](#unsubscribe)

***

<a id="sum"></a>

### sum()

```ts
function sum(field: string): AggregateFieldDescriptor;
```

Factory: sum-of-`field` aggregate. Mirrors `pyric/firestore`'s `sum()`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

`AggregateFieldDescriptor`

***

<a id="switchworkerbranch"></a>

### switchWorkerBranch()

```ts
function switchWorkerBranch(db: ClientDb, name: string): Promise<void>;
```

Phase 3 (clobber): switch the live sandbox to a named branch's state.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |
| `name` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="updatedoc"></a>

### updateDoc()

```ts
function updateDoc(ref: DocRefHandle, data: Record<string, unknown>): Promise<void>;
```

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

| Parameter | Type |
| :------ | :------ |
| `ref` | [`DocRefHandle`](#docrefhandle) |
| `data` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<`void`\>

***

<a id="uploadbytes"></a>

### uploadBytes()

```ts
function uploadBytes(
   reference: ClientStorageReference,
   data: Blob | ArrayBuffer | Uint8Array<ArrayBufferLike>,
   metadata?: ClientSettableMetadata): Promise<{
  metadata: FullMetadata;
  ref: ClientStorageReference;
}>;
```

Upload bytes at the reference's path (replaces existing content).
 Mirrors `pyric/storage`'s `uploadBytes` result shape.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `reference` | [`ClientStorageReference`](#clientstoragereference) |
| `data` | `Blob` \| `ArrayBuffer` \| `Uint8Array`\<`ArrayBufferLike`\> |
| `metadata?` | [`ClientSettableMetadata`](#clientsettablemetadata) |

#### Returns

`Promise`\<\{
  `metadata`: `FullMetadata`;
  `ref`: [`ClientStorageReference`](#clientstoragereference);
\}\>

***

<a id="where"></a>

### where()

```ts
function where(
   field: string,
   op: string,
   value: unknown): QueryConstraintHandle;
```

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

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |
| `op` | `string` |
| `value` | `unknown` |

#### Returns

`QueryConstraintHandle`

***

<a id="writebatch"></a>

### writeBatch()

```ts
function writeBatch(db: ClientDb): ClientWriteBatch;
```

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

| Parameter | Type |
| :------ | :------ |
| `db` | [`ClientDb`](#clientdb) |

#### Returns

[`ClientWriteBatch`](#clientwritebatch)
