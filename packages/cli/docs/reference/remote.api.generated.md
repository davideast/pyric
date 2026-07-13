<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# @pyric/cli/remote

## Interfaces

### ConnectRemoteSandboxOptions

#### Properties

##### cwd?

> `optional` **cwd**: `string`

Project root for `.pyric/serve.json` discovery. Default: `process.cwd()`.

##### opTimeoutMs?

> `optional` **opTimeoutMs**: `number`

Per-op timeout in ms on the Node side (default 35s, above the bridge's 30s).

##### url?

> `optional` **url**: `string`

Explicit serve base URL (e.g. `http://127.0.0.1:5000`) — skips discovery.

***

### LazyRemoteSandbox

[remoteSandbox](#remotesandbox-1)'s return type: the branded handle plus `ready` for
eager checkers. `ready` kicks off the connection when first accessed and
settles with the same fail-fast errors [connectRemoteSandbox](#connectremotesandbox) throws
(no serve discovered / no browser tab connected).

#### Extends

- [`RemoteSandbox`](#remotesandbox)

#### Properties

##### auth

> `readonly` **auth**: [`RemoteAuthAdmin`](#remoteauthadmin)

Admin auth user CRUD.

###### Inherited from

[`RemoteSandbox`](#remotesandbox).[`auth`](#auth-1)

##### channel

> `readonly` **channel**: [`RemoteSandboxChannel`](#remotesandboxchannel-1)

The raw worker op/sub relay channel (narrowed to the wire payload types).

###### Inherited from

[`RemoteSandbox`](#remotesandbox).[`channel`](#channel-1)

##### ready

> `readonly` **ready**: `Promise`\<`void`\>

##### rtdb

> `readonly` **rtdb**: [`RemoteRtdb`](#remotertdb)

RTDB conveniences (admin lens pinned).

###### Inherited from

[`RemoteSandbox`](#remotesandbox).[`rtdb`](#rtdb-1)

##### storage

> `readonly` **storage**: [`RemoteStorage`](#remotestorage)

Storage conveniences (admin lens pinned; 8 MiB per-op byte cap).

###### Inherited from

[`RemoteSandbox`](#remotesandbox).[`storage`](#storage-1)

#### Methods

##### close()

> **close**(): `void`

Close the connection. In-flight ops reject; subscriptions stop.

###### Returns

`void`

###### Inherited from

[`RemoteSandbox`](#remotesandbox).[`close`](#close-2)

***

### RemoteAuthAdmin

Admin auth user-CRUD passthrough (never lensed — auth ops operate the
 worker's user pool directly, mirroring `pyric/auth`'s sandbox ops).

#### Methods

##### clearUsers()

> **clearUsers**(): `Promise`\<`void`\>

###### Returns

`Promise`\<`void`\>

##### createUser()

> **createUser**(`request`): `Promise`\<`AuthUserRecord`\>

###### Parameters

###### request

`CreateUserRequest`

###### Returns

`Promise`\<`AuthUserRecord`\>

##### deleteUser()

> **deleteUser**(`uid`): `Promise`\<`void`\>

###### Parameters

###### uid

`string`

###### Returns

`Promise`\<`void`\>

##### listUsers()

> **listUsers**(): `Promise`\<`AuthUserRecord`[]\>

###### Returns

`Promise`\<`AuthUserRecord`[]\>

##### updateUser()

> **updateUser**(`uid`, `request`): `Promise`\<`AuthUserRecord`\>

###### Parameters

###### uid

`string`

###### request

`UpdateUserRequest`

###### Returns

`Promise`\<`AuthUserRecord`\>

***

### RemoteRtdb

Thin RTDB conveniences over the channel. Every call pins
`actAs: { mode: 'admin' }` — firebase-admin's rules-bypass semantics,
matching what `pyric-admin`'s database backend needs. Use the raw
`channel` for lensed (rules-evaluated) access.

#### Methods

##### get()

> **get**(`path`): `Promise`\<`unknown`\>

Read the value at `path` (null when absent).

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`unknown`\>

##### onValue()

> **onValue**(`path`, `callback`, `onError?`): () => `void`

Subscribe to the value at `path` (initial snapshot + every change).

###### Parameters

###### path

`string`

###### callback

(`snapshot`) => `void`

###### onError?

(`err`) => `void`

###### Returns

> (): `void`

###### Returns

`void`

##### push()

> **push**(`path`, `value?`): `Promise`\<\{ `key`: `string`; `path`: `string`; \}\>

Push `value` under a CLIENT-minted 20-char push id (the worker-protocol
 contract: `rtdb.push` carries the key, so `.key` is known synchronously
 on the pyric-admin side). Resolves with the minted key + full path.

###### Parameters

###### path

`string`

###### value?

`unknown`

###### Returns

`Promise`\<\{ `key`: `string`; `path`: `string`; \}\>

##### remove()

> **remove**(`path`): `Promise`\<`void`\>

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`void`\>

##### set()

> **set**(`path`, `value`): `Promise`\<`void`\>

###### Parameters

###### path

`string`

###### value

`unknown`

###### Returns

`Promise`\<`void`\>

##### update()

> **update**(`path`, `values`): `Promise`\<`void`\>

###### Parameters

###### path

`string`

###### values

`Record`\<`string`, `unknown`\>

###### Returns

`Promise`\<`void`\>

***

### RemoteRtdbSnapshot

Wire shape of an RTDB snapshot as the worker host serializes it.

#### Properties

##### exists

> **exists**: `boolean`

##### key

> **key**: `string`

##### size

> **size**: `number`

##### value

> **value**: `unknown`

***

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

##### auth

> `readonly` **auth**: [`RemoteAuthAdmin`](#remoteauthadmin)

Admin auth user CRUD.

##### channel

> `readonly` **channel**: [`RemoteSandboxChannel`](#remotesandboxchannel-1)

The raw worker op/sub relay channel (narrowed to the wire payload types).

##### rtdb

> `readonly` **rtdb**: [`RemoteRtdb`](#remotertdb)

RTDB conveniences (admin lens pinned).

##### storage

> `readonly` **storage**: [`RemoteStorage`](#remotestorage)

Storage conveniences (admin lens pinned; 8 MiB per-op byte cap).

#### Methods

##### close()

> **close**(): `void`

Close the connection. In-flight ops reject; subscriptions stop.

###### Returns

`void`

***

### RemoteSandboxChannel

The raw relay channel: any worker-protocol op or snap-delivering
subscription, verbatim. The typed conveniences below are built on this;
checkpoint 2's `pyric-admin` remote-dispatch arm consumes it directly.

#### Methods

##### op()

> **op**(`op`): `Promise`\<`unknown`\>

Dispatch one worker op. Resolves with the worker's `res.value`;
 rejects with an Error carrying `.code`. NOTE: callers choose their own
 `actAs` lens — nothing is pinned here.

###### Parameters

###### op

`WorkerOpPayload`

###### Returns

`Promise`\<`unknown`\>

##### subscribe()

> **subscribe**(`sub`, `onSnap`, `onError?`): () => `void`

Register a worker subscription. `onSnap` receives each snap value;
an establishment failure (the worker host's `{ __error }` snap) routes
to `onError` instead. Returns the unsubscribe function.

###### Parameters

###### sub

`WorkerSubPayload`

###### onSnap

(`value`) => `void`

###### onError?

(`err`) => `void`

###### Returns

> (): `void`

###### Returns

`void`

***

### RemoteSandboxCore

#### Properties

##### channel

> **channel**: [`RemoteSandboxChannel`](#remotesandboxchannel-1)

##### ready

> **ready**: `Promise`\<`void`\>

Resolves on `attach-ack`; rejects when no browser tab is connected.

#### Methods

##### dispose()

> **dispose**(`reason?`): `void`

Fail everything in flight (transport closed). Idempotent.

###### Parameters

###### reason?

`string`

###### Returns

`void`

##### handleMessage()

> **handleMessage**(`msg`): `void`

Feed one parsed message from the transport into the core.

###### Parameters

###### msg

`BridgeMessage`

###### Returns

`void`

##### start()

> **start**(): `void`

Send the attach handshake. `ready` settles on the ack.

###### Returns

`void`

***

### RemoteStorage

Thin Storage conveniences over the channel — the byte-carrying base64 ops
plus browse/metadata. Every call pins `actAs: { mode: 'admin' }`
(firebase-admin's rules-bypass semantics, matching [RemoteRtdb](#remotertdb));
use the raw `channel` for lensed (rules-evaluated) access. Bytes are
capped at 8 MiB raw (MAX\_STORAGE\_OP\_BYTES) on both ends —
streaming transfers are not supported on the sandbox backend.

#### Methods

##### deleteObject()

> **deleteObject**(`path`): `Promise`\<`void`\>

Delete the object at `path`. Idempotent (missing = no-op).

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`void`\>

##### exists()

> **exists**(`path`): `Promise`\<`boolean`\>

Does an object exist at `path`? (`getMetadata` with not-found → false.)

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`boolean`\>

##### getBytes()

> **getBytes**(`path`): `Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

Download the object's bytes. Rejects `storage/object-not-found` when
 absent, `payload-too-large` when over the op cap.

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

##### getMetadata()

> **getMetadata**(`path`): `Promise`\<`FullMetadata`\>

Read the object's `FullMetadata`.

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`FullMetadata`\>

##### listAll()

> **listAll**(`path`): `Promise`\<\{ `items`: `object`[]; `prefixes`: `object`[]; \}\>

Enumerate immediate child items + prefixes under `path`.

###### Parameters

###### path

`string`

###### Returns

`Promise`\<\{ `items`: `object`[]; `prefixes`: `object`[]; \}\>

##### putBytes()

> **putBytes**(`path`, `data`, `options?`): `Promise`\<`FullMetadata`\>

Upload `data` at `path` (replaces any existing object). Resolves with
 the stored object's `FullMetadata`.

###### Parameters

###### path

`string`

###### data

`Uint8Array`

###### options?

###### contentType?

`string`

###### metadata?

`Record`\<`string`, `unknown`\>

###### Returns

`Promise`\<`FullMetadata`\>

***

### RemoteTransport

Minimal transport the core writes to. `connectRemoteSandbox` adapts a
 `ws` socket; tests inject an in-process pipe to a `ConsumerSession`.

#### Methods

##### ref()?

> `optional` **ref**(): `void`

OPTIONAL event-loop hold hooks (exit-hang fix). The WS adapter unrefs
its socket once connected so an IDLE remote client never pins the Node
event loop (a finished script exits); the core calls `ref()` when work
becomes outstanding (first pending op / live subscription) and
`unref()` when the last one settles, so in-flight delivery keeps the
process alive. Pure in-process transports (tests) may omit both.

###### Returns

`void`

##### send()

> **send**(`msg`): `void`

###### Parameters

###### msg

`BridgeMessage`

###### Returns

`void`

##### unref()?

> `optional` **unref**(): `void`

###### Returns

`void`

## Functions

### buildRemoteAuthAdmin()

> **buildRemoteAuthAdmin**(`channel`): [`RemoteAuthAdmin`](#remoteauthadmin)

#### Parameters

##### channel

[`RemoteSandboxChannel`](#remotesandboxchannel-1)

#### Returns

[`RemoteAuthAdmin`](#remoteauthadmin)

***

### buildRemoteRtdb()

> **buildRemoteRtdb**(`channel`): [`RemoteRtdb`](#remotertdb)

#### Parameters

##### channel

[`RemoteSandboxChannel`](#remotesandboxchannel-1)

#### Returns

[`RemoteRtdb`](#remotertdb)

***

### buildRemoteStorage()

> **buildRemoteStorage**(`channel`): [`RemoteStorage`](#remotestorage)

#### Parameters

##### channel

[`RemoteSandboxChannel`](#remotesandboxchannel-1)

#### Returns

[`RemoteStorage`](#remotestorage)

***

### connectRemoteSandbox()

> **connectRemoteSandbox**(`options?`): `Promise`\<[`RemoteSandbox`](#remotesandbox)\>

Discover the running `pyric dev --bridge`, attach to its bridge WS as a
worker-relay CONSUMER (never a peer — attaching cannot kick the browser
tab out of last-connection-wins), and return the typed remote handle.

Fails fast when no serve is discoverable or no browser tab is connected —
there is deliberately no headless fallback (see module doc).

#### Parameters

##### options?

[`ConnectRemoteSandboxOptions`](#connectremotesandboxoptions)

#### Returns

`Promise`\<[`RemoteSandbox`](#remotesandbox)\>

***

### createLazyRemoteSandbox()

> **createLazyRemoteSandbox**(`connect`, `options?`): [`LazyRemoteSandbox`](#lazyremotesandbox)

The lazy wrapper with the connect function injected — the test seam
(tests inject a fake connect; production injects `connectRemoteSandbox`).

#### Parameters

##### connect

() => `Promise`\<[`RemoteSandbox`](#remotesandbox)\>

##### options?

###### url?

`string`

#### Returns

[`LazyRemoteSandbox`](#lazyremotesandbox)

***

### createRemoteSandboxCore()

> **createRemoteSandboxCore**(`transport`, `opts`): [`RemoteSandboxCore`](#remotesandboxcore)

Transport-agnostic client core: correlation ids/subIds are minted HERE
(this leg's id space; the bridge re-mints for the peer leg), pending ops
carry a Node-side timeout above the bridge's 30s, and `{ __error }` snap
values are routed to the subscription's error handler.

#### Parameters

##### transport

[`RemoteTransport`](#remotetransport)

##### opts

###### opTimeoutMs?

`number`

###### serveUrl

`string`

#### Returns

[`RemoteSandboxCore`](#remotesandboxcore)

***

### createRemoteSandboxHandle()

> **createRemoteSandboxHandle**(`opts`): [`RemoteSandbox`](#remotesandbox)

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

##### opts

###### channel

[`RemoteSandboxChannel`](#remotesandboxchannel-1)

###### close

() => `void`

###### serveUrl

`string`

#### Returns

[`RemoteSandbox`](#remotesandbox)

***

### remoteSandbox()

> **remoteSandbox**(`options?`): [`LazyRemoteSandbox`](#lazyremotesandbox)

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

##### options?

[`ConnectRemoteSandboxOptions`](#connectremotesandboxoptions)

#### Returns

[`LazyRemoteSandbox`](#lazyremotesandbox)
