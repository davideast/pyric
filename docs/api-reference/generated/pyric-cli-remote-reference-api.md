---
title: "API reference: @pyric/cli/remote"
navLabel: "@pyric/cli/remote"
outcome: "Published declarations for @pyric/cli/remote."
slug: "pyric-cli-remote-reference-api"
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/remote"
apiSubpath: "remote"
apiSymbolCount: 18
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="connectremotesandboxoptions"></a>

### ConnectRemoteSandboxOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="cwd"></a> `cwd?` | `string` | Project root for `.pyric/serve.json` discovery. Default: `process.cwd()`. |
| <a id="optimeoutms"></a> `opTimeoutMs?` | `number` | Per-op timeout in ms on the Node side (default 35s, above the bridge's 30s). |
| <a id="url"></a> `url?` | `string` | Explicit serve base URL (e.g. `http://127.0.0.1:5000`) — skips discovery. |

***

<a id="lazyremotesandbox"></a>

### LazyRemoteSandbox

[remoteSandbox](#remotesandbox-1)'s return type: the branded handle plus `ready` for
eager checkers. `ready` kicks off the connection when first accessed and
settles with the same fail-fast errors [connectRemoteSandbox](#connectremotesandbox) throws
(no serve discovered / no browser tab connected).

#### Extends

- [`RemoteSandbox`](#remotesandbox)

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="auth"></a> `auth` | `readonly` | [`RemoteAuthAdmin`](#remoteauthadmin) | Admin auth user CRUD. |
| <a id="channel"></a> `channel` | `readonly` | [`RemoteSandboxChannel`](#remotesandboxchannel-1) | The raw worker op/sub relay channel (narrowed to the wire payload types). |
| <a id="ready"></a> `ready` | `readonly` | `Promise`\<`void`\> | - |
| <a id="rtdb"></a> `rtdb` | `readonly` | [`RemoteRtdb`](#remotertdb) | RTDB conveniences (admin lens pinned). |
| <a id="storage"></a> `storage` | `readonly` | [`RemoteStorage`](#remotestorage) | Storage conveniences (admin lens pinned; 8 MiB per-op byte cap). |

#### Methods

<a id="close"></a>

##### close()

```ts
close(): void;
```

Close the connection. In-flight ops reject; subscriptions stop.

###### Returns

`void`

###### Inherited from

[`RemoteSandbox`](#remotesandbox).[`close`](#close-2)

***

<a id="remoteauthadmin"></a>

### RemoteAuthAdmin

Admin auth user-CRUD passthrough (never lensed — auth ops operate the
 worker's user pool directly, mirroring `pyric/auth`'s sandbox ops).

#### Methods

<a id="clearusers"></a>

##### clearUsers()

```ts
clearUsers(): Promise<void>;
```

###### Returns

`Promise`\<`void`\>

<a id="createuser"></a>

##### createUser()

```ts
createUser(request: CreateUserRequest): Promise<AuthUserRecord>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `request` | `CreateUserRequest` |

###### Returns

`Promise`\<`AuthUserRecord`\>

<a id="deleteuser"></a>

##### deleteUser()

```ts
deleteUser(uid: string): Promise<void>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `uid` | `string` |

###### Returns

`Promise`\<`void`\>

<a id="listusers"></a>

##### listUsers()

```ts
listUsers(): Promise<AuthUserRecord[]>;
```

###### Returns

`Promise`\<`AuthUserRecord`[]\>

<a id="updateuser"></a>

##### updateUser()

```ts
updateUser(uid: string, request: UpdateUserRequest): Promise<AuthUserRecord>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `uid` | `string` |
| `request` | `UpdateUserRequest` |

###### Returns

`Promise`\<`AuthUserRecord`\>

***

<a id="remotertdb"></a>

### RemoteRtdb

Thin RTDB conveniences over the channel. Every call pins
`actAs: { mode: 'admin' }` — firebase-admin's rules-bypass semantics,
matching what `pyric-admin`'s database backend needs. Use the raw
`channel` for lensed (rules-evaluated) access.

#### Methods

<a id="get"></a>

##### get()

```ts
get(path: string): Promise<unknown>;
```

Read the value at `path` (null when absent).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`Promise`\<`unknown`\>

<a id="onvalue"></a>

##### onValue()

```ts
onValue(
   path: string,
   callback: (snapshot: RemoteRtdbSnapshot) => void,
   onError?: (err: Error & {
  code: string;
}) => void): () => void;
```

Subscribe to the value at `path` (initial snapshot + every change).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |
| `callback` | (`snapshot`: [`RemoteRtdbSnapshot`](#remotertdbsnapshot)) => `void` |
| `onError?` | (`err`: `Error` & \{ `code`: `string`; \}) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

<a id="push"></a>

##### push()

```ts
push(path: string, value?: unknown): Promise<{
  key: string;
  path: string;
}>;
```

Push `value` under a CLIENT-minted 20-char push id (the worker-protocol
 contract: `rtdb.push` carries the key, so `.key` is known synchronously
 on the pyric-admin side). Resolves with the minted key + full path.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |
| `value?` | `unknown` |

###### Returns

`Promise`\<\{
  `key`: `string`;
  `path`: `string`;
\}\>

<a id="remove"></a>

##### remove()

```ts
remove(path: string): Promise<void>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`Promise`\<`void`\>

<a id="set"></a>

##### set()

```ts
set(path: string, value: unknown): Promise<void>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |
| `value` | `unknown` |

###### Returns

`Promise`\<`void`\>

<a id="update"></a>

##### update()

```ts
update(path: string, values: Record<string, unknown>): Promise<void>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |
| `values` | `Record`\<`string`, `unknown`\> |

###### Returns

`Promise`\<`void`\>

***

<a id="remotertdbsnapshot"></a>

### RemoteRtdbSnapshot

Wire shape of an RTDB snapshot as the worker host serializes it.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="exists"></a> `exists` | `boolean` |
| <a id="key"></a> `key` | `string` |
| <a id="size"></a> `size` | `number` |
| <a id="value"></a> `value` | `unknown` |

***

<a id="remotesandbox"></a>

### RemoteSandbox

The Node-side remote sandbox handle. Extends `pyric/sandbox`'s branded
RemoteSandboxBase — structurally a full `Sandbox`, so it can be
passed to `pyric-admin/app`'s `initializeApp({ sandbox })`, whose RTDB and
Auth backends dispatch on the brand and route through [channel](#channel-1).

Sandbox members that are genuinely sync-only (`admin`, `snapshot()`,
`history()`, `onEvent`, `currentUser`, …) cannot be mirrored over the
wire in slice 1 and throw a remediating `unimplemented` error naming
what to do instead. Implemented members: `withAuth` (pure local pair
construction) and `dispose` (aliases [close](#close-2)).

#### Extends

- `unknown`

#### Extended by

- [`LazyRemoteSandbox`](#lazyremotesandbox)

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="auth-1"></a> `auth` | `readonly` | [`RemoteAuthAdmin`](#remoteauthadmin) | Admin auth user CRUD. |
| <a id="channel-1"></a> `channel` | `readonly` | [`RemoteSandboxChannel`](#remotesandboxchannel-1) | The raw worker op/sub relay channel (narrowed to the wire payload types). |
| <a id="rtdb-1"></a> `rtdb` | `readonly` | [`RemoteRtdb`](#remotertdb) | RTDB conveniences (admin lens pinned). |
| <a id="storage-1"></a> `storage` | `readonly` | [`RemoteStorage`](#remotestorage) | Storage conveniences (admin lens pinned; 8 MiB per-op byte cap). |

#### Methods

<a id="close-2"></a>

##### close()

```ts
close(): void;
```

Close the connection. In-flight ops reject; subscriptions stop.

###### Returns

`void`

***

<a id="remotesandboxchannel-1"></a>

### RemoteSandboxChannel

The raw relay channel: any worker-protocol op or snap-delivering
subscription, verbatim. The typed conveniences below are built on this;
checkpoint 2's `pyric-admin` remote-dispatch arm consumes it directly.

#### Methods

<a id="op"></a>

##### op()

```ts
op(op: WorkerOpPayload): Promise<unknown>;
```

Dispatch one worker op. Resolves with the worker's `res.value`;
 rejects with an Error carrying `.code`. NOTE: callers choose their own
 `actAs` lens — nothing is pinned here.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `op` | `WorkerOpPayload` |

###### Returns

`Promise`\<`unknown`\>

<a id="subscribe"></a>

##### subscribe()

```ts
subscribe(
   sub: WorkerSubPayload,
   onSnap: (value: unknown) => void,
   onError?: (err: Error & {
  code: string;
}) => void): () => void;
```

Register a worker subscription. `onSnap` receives each snap value;
an establishment failure (the worker host's `{ __error }` snap) routes
to `onError` instead. Returns the unsubscribe function.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `sub` | `WorkerSubPayload` |
| `onSnap` | (`value`: `unknown`) => `void` |
| `onError?` | (`err`: `Error` & \{ `code`: `string`; \}) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

***

<a id="remotesandboxcore"></a>

### RemoteSandboxCore

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="channel-2"></a> `channel` | [`RemoteSandboxChannel`](#remotesandboxchannel-1) | - |
| <a id="ready-1"></a> `ready` | `Promise`\<`void`\> | Resolves on `attach-ack`; rejects when no browser tab is connected. |

#### Methods

<a id="dispose"></a>

##### dispose()

```ts
dispose(reason?: string): void;
```

Fail everything in flight (transport closed). Idempotent.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `reason?` | `string` |

###### Returns

`void`

<a id="handlemessage"></a>

##### handleMessage()

```ts
handleMessage(msg: BridgeMessage): void;
```

Feed one parsed message from the transport into the core.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `msg` | `BridgeMessage` |

###### Returns

`void`

<a id="start"></a>

##### start()

```ts
start(): void;
```

Send the attach handshake. `ready` settles on the ack.

###### Returns

`void`

***

<a id="remotestorage"></a>

### RemoteStorage

Thin Storage conveniences over the channel — the byte-carrying base64 ops
plus browse/metadata. Every call pins `actAs: { mode: 'admin' }`
(firebase-admin's rules-bypass semantics, matching [RemoteRtdb](#remotertdb));
use the raw `channel` for lensed (rules-evaluated) access. Bytes are
capped at 8 MiB raw (MAX\_STORAGE\_OP\_BYTES) on both ends —
streaming transfers are not supported on the sandbox backend.

#### Methods

<a id="deleteobject"></a>

##### deleteObject()

```ts
deleteObject(path: string): Promise<void>;
```

Delete the object at `path`. Idempotent (missing = no-op).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`Promise`\<`void`\>

<a id="exists-1"></a>

##### exists()

```ts
exists(path: string): Promise<boolean>;
```

Does an object exist at `path`? (`getMetadata` with not-found → false.)

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`Promise`\<`boolean`\>

<a id="getbytes"></a>

##### getBytes()

```ts
getBytes(path: string): Promise<Buffer<ArrayBufferLike>>;
```

Download the object's bytes. Rejects `storage/object-not-found` when
 absent, `payload-too-large` when over the op cap.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

<a id="getmetadata"></a>

##### getMetadata()

```ts
getMetadata(path: string): Promise<FullMetadata>;
```

Read the object's `FullMetadata`.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`Promise`\<`FullMetadata`\>

<a id="listall"></a>

##### listAll()

```ts
listAll(path: string): Promise<{
  items: {
     fullPath: string;
     name: string;
  }[];
  prefixes: {
     fullPath: string;
     name: string;
  }[];
}>;
```

Enumerate immediate child items + prefixes under `path`.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`Promise`\<\{
  `items`: \{
     `fullPath`: `string`;
     `name`: `string`;
  \}[];
  `prefixes`: \{
     `fullPath`: `string`;
     `name`: `string`;
  \}[];
\}\>

<a id="putbytes"></a>

##### putBytes()

```ts
putBytes(
   path: string,
   data: Uint8Array,
   options?: {
  contentType?: string;
  metadata?: Record<string, unknown>;
}): Promise<FullMetadata>;
```

Upload `data` at `path` (replaces any existing object). Resolves with
 the stored object's `FullMetadata`.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |
| `data` | `Uint8Array` |
| `options?` | \{ `contentType?`: `string`; `metadata?`: `Record`\<`string`, `unknown`\>; \} |
| `options.contentType?` | `string` |
| `options.metadata?` | `Record`\<`string`, `unknown`\> |

###### Returns

`Promise`\<`FullMetadata`\>

***

<a id="remotetransport"></a>

### RemoteTransport

Minimal transport the core writes to. `connectRemoteSandbox` adapts a
 `ws` socket; tests inject an in-process pipe to a `ConsumerSession`.

#### Methods

<a id="ref"></a>

##### ref()?

```ts
optional ref(): void;
```

OPTIONAL event-loop hold hooks (exit-hang fix). The WS adapter unrefs
its socket once connected so an IDLE remote client never pins the Node
event loop (a finished script exits); the core calls `ref()` when work
becomes outstanding (first pending op / live subscription) and
`unref()` when the last one settles, so in-flight delivery keeps the
process alive. Pure in-process transports (tests) may omit both.

###### Returns

`void`

<a id="send"></a>

##### send()

```ts
send(msg: BridgeMessage): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `msg` | `BridgeMessage` |

###### Returns

`void`

<a id="unref"></a>

##### unref()?

```ts
optional unref(): void;
```

###### Returns

`void`

## Functions

<a id="buildremoteauthadmin"></a>

### buildRemoteAuthAdmin()

```ts
function buildRemoteAuthAdmin(channel: RemoteSandboxChannel): RemoteAuthAdmin;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `channel` | [`RemoteSandboxChannel`](#remotesandboxchannel-1) |

#### Returns

[`RemoteAuthAdmin`](#remoteauthadmin)

***

<a id="buildremotertdb"></a>

### buildRemoteRtdb()

```ts
function buildRemoteRtdb(channel: RemoteSandboxChannel): RemoteRtdb;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `channel` | [`RemoteSandboxChannel`](#remotesandboxchannel-1) |

#### Returns

[`RemoteRtdb`](#remotertdb)

***

<a id="buildremotestorage"></a>

### buildRemoteStorage()

```ts
function buildRemoteStorage(channel: RemoteSandboxChannel): RemoteStorage;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `channel` | [`RemoteSandboxChannel`](#remotesandboxchannel-1) |

#### Returns

[`RemoteStorage`](#remotestorage)

***

<a id="connectremotesandbox"></a>

### connectRemoteSandbox()

```ts
function connectRemoteSandbox(options?: ConnectRemoteSandboxOptions): Promise<RemoteSandbox>;
```

Discover the running `pyric dev --bridge`, attach to its bridge WS as a
worker-relay CONSUMER (never a peer — attaching cannot kick the browser
tab out of last-connection-wins), and return the typed remote handle.

Fails fast when no serve is discoverable or no browser tab is connected —
there is deliberately no headless fallback (see module doc).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`ConnectRemoteSandboxOptions`](#connectremotesandboxoptions) |

#### Returns

`Promise`\<[`RemoteSandbox`](#remotesandbox)\>

***

<a id="createlazyremotesandbox"></a>

### createLazyRemoteSandbox()

```ts
function createLazyRemoteSandbox(connect: () => Promise<RemoteSandbox>, options?: {
  url?: string;
}): LazyRemoteSandbox;
```

The lazy wrapper with the connect function injected — the test seam
(tests inject a fake connect; production injects `connectRemoteSandbox`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `connect` | () => `Promise`\<[`RemoteSandbox`](#remotesandbox)\> |
| `options?` | \{ `url?`: `string`; \} |
| `options.url?` | `string` |

#### Returns

[`LazyRemoteSandbox`](#lazyremotesandbox)

***

<a id="createremotesandboxcore"></a>

### createRemoteSandboxCore()

```ts
function createRemoteSandboxCore(transport: RemoteTransport, opts: {
  opTimeoutMs?: number;
  serveUrl: string;
}): RemoteSandboxCore;
```

Transport-agnostic client core: correlation ids/subIds are minted HERE
(this leg's id space; the bridge re-mints for the peer leg), pending ops
carry a Node-side timeout above the bridge's 30s, and `{ __error }` snap
values are routed to the subscription's error handler.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `transport` | [`RemoteTransport`](#remotetransport) |
| `opts` | \{ `opTimeoutMs?`: `number`; `serveUrl`: `string`; \} |
| `opts.opTimeoutMs?` | `number` |
| `opts.serveUrl` | `string` |

#### Returns

[`RemoteSandboxCore`](#remotesandboxcore)

***

<a id="createremotesandboxhandle"></a>

### createRemoteSandboxHandle()

```ts
function createRemoteSandboxHandle(opts: {
  channel: RemoteSandboxChannel;
  close: () => void;
  serveUrl: string;
}): RemoteSandbox;
```

Build the branded remote sandbox handle over an established channel.

Split out of [connectRemoteSandbox](#connectremotesandbox) so the in-process test harness
(fake ports + `createConsumerSession`, no WS) constructs the EXACT handle
production hands to `pyric-admin`.

The handle satisfies `Sandbox` structurally:
  - `withAuth` / `dispose` are real (pure local construction / teardown).
  - Everything whose contract is sync-only or worker-owned (`admin`,
    `snapshot`, `loadSnapshot`, `history`, `onEvent`, `reset`,
    `currentUser`, `onCurrentUserChanged`, tab sync, persistence) throws
    a remediating `unimplemented` error. Notably `onEvent`: the unified
    event stream (`target: 'events'`) is not relayable until slice 2's
    bounded backpressure lands, and no remote dispatch arm may depend on
    it — a throw (not a silent no-op) keeps a subscriber from believing
    it is observing events that will never arrive.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `opts` | \{ `channel`: [`RemoteSandboxChannel`](#remotesandboxchannel-1); `close`: () => `void`; `serveUrl`: `string`; \} |
| `opts.channel` | [`RemoteSandboxChannel`](#remotesandboxchannel-1) |
| `opts.close` | () => `void` |
| `opts.serveUrl` | `string` |

#### Returns

[`RemoteSandbox`](#remotesandbox)

***

<a id="remotesandbox-1"></a>

### remoteSandbox()

```ts
function remoteSandbox(options?: ConnectRemoteSandboxOptions): LazyRemoteSandbox;
```

Synchronous construction, lazy connection — the ambient-init seam.

`@pyric/cli/register` installs this behind the
`Symbol.for('pyric.remote.sandboxFactory')` global so `pyric-admin`'s bare
`initializeApp()` can mint a full branded handle without awaiting anything.
The wire connection (discovery → WS attach) happens on the FIRST op (or
`ready` access), so the existing fail-fast — "no browser tab is connected —
open <url>" — surfaces on first use instead of at construction. A failed
connect is NOT latched: the next op retries, matching the error's own
"…and retry" guidance. `connectRemoteSandbox` (eager) is unchanged.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`ConnectRemoteSandboxOptions`](#connectremotesandboxoptions) |

#### Returns

[`LazyRemoteSandbox`](#lazyremotesandbox)
