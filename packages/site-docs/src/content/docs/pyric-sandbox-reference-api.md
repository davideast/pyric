---
title: "API reference: pyric/sandbox"
navLabel: "pyric/sandbox"
group: "API reference"
section: "pyric"
order: 24033
description: "Published declarations for pyric/sandbox."
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/sandbox"
apiSubpath: "sandbox"
apiSymbolCount: 72
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Classes

<a id="persistenceschemaerror"></a>

### PersistenceSchemaError

#### Extends

- `Error`

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new PersistenceSchemaError(message: string): PersistenceSchemaError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `message` | `string` |

###### Returns

[`PersistenceSchemaError`](#persistenceschemaerror)

###### Overrides

```ts
Error.constructor
```

***

<a id="sandboxcontextimpl"></a>

### SandboxContextImpl

Identity-bearing handle on a [Sandbox](#sandbox-3). A
`(sandbox, auth, operationContext)`
tuple — cheap to create, immutable, freely shareable. Service
factories require a `SandboxContext`; bare `Sandbox` is a type
error so every call site states identity explicitly.

Constructed via `Sandbox.withAuth(auth)` or chained via
`SandboxContext.withAuth(auth)`. The concrete class is exported
from `pyric/sandbox` for `instanceof` routing in service
factories; consumers don't construct it directly.

#### Implements

- [`SandboxContext`](#sandboxcontext)

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
new SandboxContextImpl(
   sandbox: Sandbox,
   auth: {
  token?: Record<string, unknown>;
  uid: string;
},
   operationContext?: OperationContext): SandboxContextImpl;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | [`Sandbox`](#sandbox-3) |
| `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `Record`\<`string`, `unknown`\> |
| `auth.uid?` | `string` |
| `operationContext?` | [`OperationContext`](#operationcontext-2) |

###### Returns

[`SandboxContextImpl`](#sandboxcontextimpl)

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="auth"></a> `auth` | `readonly` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | The identity rules evaluate under for operations through this context. |
| `auth.token?` | `public` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `public` | `string` | - |
| <a id="operationcontext"></a> `operationContext` | `readonly` | [`OperationContext`](#operationcontext-2) | Immutable provenance bound to every operation issued through this handle. |
| <a id="sandbox"></a> `sandbox` | `readonly` | [`Sandbox`](#sandbox-3) | The data foundation this context operates against. |

#### Methods

<a id="withauth"></a>

##### withAuth()

```ts
withAuth(auth: {
  token?: Record<string, unknown>;
  uid: string;
}): SandboxContext;
```

Derive a sibling context on the same sandbox with different auth.
Replaces auth and its lens while preserving the operation source and
optional plan identity.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `Record`\<`string`, `unknown`\> |
| `auth.uid` | `string` |

###### Returns

[`SandboxContext`](#sandboxcontext)

###### Implementation of

[`SandboxContext`](#sandboxcontext).[`withAuth`](#withauth-8)

***

<a id="sandboxerror"></a>

### SandboxError

Sandbox-layer error. Catch with `instanceof SandboxError` and switch
on `code`. `denialContext` is populated for `permission-denied` only
(and only after Slice 4 wires it through).

Two construction forms are supported:
  - Positional: `new SandboxError(code, message, denialContext?)` —
    the original signature, kept for backward compatibility with
    existing internal call sites.
  - Options bag: `new SandboxError({ code, message, remediation? })` —
    used when attaching remediation guidance.

#### Extends

- `Error`

#### Constructors

<a id="constructor-2"></a>

##### Constructor

```ts
new SandboxError(
   code: SandboxErrorCode,
   message: string,
   denialContext?: DenialContext): SandboxError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `code` | [`SandboxErrorCode`](#sandboxerrorcode-1) |
| `message` | `string` |
| `denialContext?` | [`DenialContext`](#denialcontext-1) |

###### Returns

[`SandboxError`](#sandboxerror)

###### Overrides

```ts
Error.constructor
```

##### Constructor

```ts
new SandboxError(options: SandboxErrorOptions): SandboxError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options` | `SandboxErrorOptions` |

###### Returns

[`SandboxError`](#sandboxerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="code"></a> `code` | `readonly` | [`SandboxErrorCode`](#sandboxerrorcode-1) |
| <a id="denialcontext"></a> `denialContext?` | `readonly` | [`DenialContext`](#denialcontext-1) |
| <a id="remediation"></a> `remediation?` | `readonly` | `string` |

## Interfaces

<a id="branch"></a>

### Branch

An isolated, in-memory experiment seeded from a [SandboxSnapshot](#sandboxsnapshot-2).

A branch owns its own [LocalSandbox](#localsandbox) (fully isolated from the source —
separate `LocalEnvironment`, separate event history) plus the
accumulated [SandboxEvent](#sandboxevent)s applied to it via [apply](#apply). The
applied events are what [promote](#promote) replays onto the target.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="base"></a> `base` | `readonly` | [`SandboxSnapshot`](#sandboxsnapshot-2) | The snapshot this branch was forked from. Retained so [diff](#diff) and [promote](#promote) can reason about the baseline. |
| <a id="discarded"></a> `discarded` | `public` | `boolean` | Flipped by [discard](#discard); subsequent [apply](#apply)/[promote](#promote) calls throw. |
| <a id="events"></a> `events` | `readonly` | [`SandboxEvent`](#sandboxevent)[] | Write/op events applied to this branch since fork, in order. These are replayed onto the target by [promote](#promote). |
| <a id="rules"></a> `rules` | `readonly` | `string` | Rules the branch was forked with — carried so [promote](#promote) can re-seed a replay target identically. |
| <a id="sandbox-1"></a> `sandbox` | `readonly` | [`LocalSandbox`](#localsandbox) | The branch's own sandbox. Inspect it directly (`branch.sandbox.snapshot()`) or read docs via `branch.sandbox.admin.getDocument(path)`. |

***

<a id="broadcastchannellike"></a>

### BroadcastChannelLike

Minimal interface that `BroadcastChannel` satisfies. Provided as an
injectable seam so tests can run without a real browser channel.

The real `BroadcastChannel` global satisfies this interface out of the
box — pass it directly:

```ts
sandbox.enableTabSync({
  channel: new BroadcastChannel('pyric:tabsync'),
});
```

For SSR / Node environments, the default channel construction is guarded
(`typeof BroadcastChannel !== 'undefined'`) so the call site doesn't need
to branch — a missing global just means no sync, which is fine for server
renders that only care about initial data.

#### Methods

<a id="addeventlistener"></a>

##### addEventListener()

```ts
addEventListener(type: "message", listener: (ev: {
  data: unknown;
}) => void): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `type` | `"message"` |
| `listener` | (`ev`: \{ `data`: `unknown`; \}) => `void` |

###### Returns

`void`

<a id="close"></a>

##### close()

```ts
close(): void;
```

###### Returns

`void`

<a id="postmessage"></a>

##### postMessage()

```ts
postMessage(message: unknown): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `message` | `unknown` |

###### Returns

`void`

<a id="removeeventlistener"></a>

##### removeEventListener()

```ts
removeEventListener(type: "message", listener: (ev: {
  data: unknown;
}) => void): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `type` | `"message"` |
| `listener` | (`ev`: \{ `data`: `unknown`; \}) => `void` |

###### Returns

`void`

***

<a id="denialcontext-1"></a>

### DenialContext

Structured denial context emitted alongside a `permission-denied`
error. Real Firebase strips this server-side for security; the
sandbox can expose it because it's a development tool.

`auth` and `reasons` are populated whenever the sandbox raises a
`permission-denied` error. `rule` (line + expression) requires
source-position tracking in the rules AST and is deferred — see
design rationale "Open questions" for the follow-up.
`failedFields` will be filled in once the evaluator surfaces field-
reference traces.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="auth-1"></a> `auth?` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | Auth identity that was active when the denial fired. |
| `auth.token?` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="failedfields"></a> `failedFields?` | `string`[] | Field paths in `request.resource.data` that the rule referenced and that failed. |
| <a id="reasons"></a> `reasons?` | `string`[] | Raw simulator reasoning lines (the underlying engine's `debugMessages`). Always present on `permission-denied`. Stable enough for log surfacing; not stable as machine-parseable data. |
| <a id="request"></a> `request?` | \{ `method`: `"get"` \| `"list"` \| `"create"` \| `"update"` \| `"delete"`; `path`: `string`; `resourceData?`: `Record`\<`string`, `unknown`\>; \} | Eval-time request shape — what the rule saw on `request.*`. Lets callers render a "why did this deny" frame (auth, method, path, `request.resource.data` with sentinels resolved) without re-deriving any of it from out-of-band state. |
| `request.method` | `"get"` \| `"list"` \| `"create"` \| `"update"` \| `"delete"` | - |
| `request.path` | `string` | - |
| `request.resourceData?` | `Record`\<`string`, `unknown`\> | The user's proposed `request.resource.data` — pre-resolution. `FieldValue.*` sentinels are preserved as their marker shapes (`{ __type: 'serverTimestamp' }`, etc.). The rule engine evaluated against the resolved form; what surfaces here is the caller's INTENT so consumers see what they tried to write. Absent for reads (no proposed write) and for `delete` (no payload). |
| <a id="resource"></a> `resource?` | \{ `data`: `Record`\<`string`, `unknown`\>; `exists`: `boolean`; \} | Eval-time existing-document snapshot — what the rule saw on `resource.data`. `null` data with `exists: false` mirrors how the rule sees an absent doc. Absent for collection ops (`list`). |
| `resource.data` | `Record`\<`string`, `unknown`\> | - |
| `resource.exists` | `boolean` | - |
| <a id="rule"></a> `rule?` | \{ `expression`: `string`; `line`: `number`; \} | The rule whose evaluation produced the denial. Best effort; may be absent until source positions land in the AST. |
| `rule.expression` | `string` | - |
| `rule.line` | `number` | - |

***

<a id="denialevent"></a>

### DenialEvent

Eval-time payload emitted to Sandbox.onDenial subscribers.

Mirrors the structured fields [DenialContext](#denialcontext-1) carries (`request`
+ `resource` + `reasons` + `auth`) so a host environment that wants
to surface denials independent of try/catch behavior gets the same
frame either way.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="auth-2"></a> `auth?` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `Record`\<`string`, `unknown`\> |
| `auth.uid` | `string` |
| <a id="code-1"></a> `code` | `"permission-denied"` |
| <a id="message"></a> `message` | `string` |
| <a id="reasons-1"></a> `reasons?` | `string`[] |
| <a id="request-1"></a> `request?` | \{ `method`: `"get"` \| `"list"` \| `"create"` \| `"update"` \| `"delete"`; `path`: `string`; `resourceData?`: `Record`\<`string`, `unknown`\>; \} |
| `request.method` | `"get"` \| `"list"` \| `"create"` \| `"update"` \| `"delete"` |
| `request.path` | `string` |
| `request.resourceData?` | `Record`\<`string`, `unknown`\> |
| <a id="resource-1"></a> `resource?` | \{ `data`: `Record`\<`string`, `unknown`\>; `exists`: `boolean`; \} |
| `resource.data` | `Record`\<`string`, `unknown`\> |
| `resource.exists` | `boolean` |

***

<a id="eventprovenance"></a>

### EventProvenance

Compatibility provenance carried by sandbox events while producers and
consumers migrate to the canonical `operationContext`.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="actor"></a> `actor?` | [`EventActor`](#eventactor) | - |
| <a id="authlens"></a> `authLens?` | [`AuthLens`](#authlens-2) | - |
| <a id="operationcontext-1"></a> `operationContext?` | [`OperationContext`](#operationcontext-2) | - |
| <a id="planid"></a> `planId?` | `string` | Set when the op is part of an agent plan. |
| <a id="service"></a> `service?` | [`EventService`](#eventservice) | - |

***

<a id="listenerlifecycleevent"></a>

### ListenerLifecycleEvent

Listener lifecycle event — attach, detach, or errored. Errored
supersedes the prior `onSnapshotError` channel; `error` is populated
on the errored phase only.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="at"></a> `at` | `number` | - |
| <a id="auth-3"></a> `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | - |
| `auth.token?` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="error"></a> `error?` | \{ `code`: `"permission-denied"`; `message`: `string`; `reasons?`: `string`[]; \} | Populated on `listener_errored` only. |
| `error.code` | `"permission-denied"` | - |
| `error.message` | `string` | - |
| `error.reasons?` | `string`[] | - |
| <a id="id"></a> `id` | `string` | - |
| <a id="kind"></a> `kind` | `"listener_attach"` \| `"listener_detach"` \| `"listener_errored"` | - |
| <a id="listenerid"></a> `listenerId` | `string` | - |
| <a id="target"></a> `target` | \| \{ `kind`: `"doc"`; `path`: `string`; \} \| \{ `collection`: `string`; `kind`: `"query"`; \} | - |

***

<a id="localsandbox"></a>

### LocalSandbox

An in-process sandbox created by [initializeSandbox](#initializesandbox).

Service controls whose implementation requires synchronous access to local
state accept this type. Remote worker handles remain [Sandbox](#sandbox-3)s, but
are deliberately not assignable to this local-only interface.

#### Extends

- [`Sandbox`](#sandbox-3)

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="local_sandbox"></a> `[LOCAL_SANDBOX]` | `readonly` | `true` | - |
| <a id="admin"></a> `admin` | `readonly` | `SandboxAdmin` | Admin-plane access (rule-bypass reads). Identity-agnostic by design — admin reads aren't gated on auth, so they live on the sandbox, not on a context. See SandboxAdmin. |
| <a id="currentuser"></a> `currentUser` | `public` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | Current authenticated user across the sandbox. Mutated by `pyric/auth`'s `signInAnonymously` / `signInWithEmailAndPassword` / `signOut` / `sandbox.setUser`. Read per-call by service factories (e.g. a future `getFirestore(sandbox)` overload) so they see auth state changes without re-binding handles. Defaults to `null` (anonymous / signed out). **Independent of `withAuth({uid})`** — `withAuth` still produces a frozen [SandboxContext](#sandboxcontext) that carries its own identity for the runner's test code (the existing pattern: explicit identity per service call). `currentUser` exists for the `pyric/auth` mirror, where consumer app code drives identity through a stateful `Auth` handle rather than naming it per call. |
| `currentUser.token?` | `public` | `Record`\<`string`, `unknown`\> | - |
| `currentUser.uid` | `public` | `string` | - |

#### Methods

<a id="clearpersistence"></a>

##### clearPersistence()

```ts
clearPersistence(): Promise<void>;
```

Wipe the persisted blob for this sandbox's `key`. In-memory state
is left intact — call `reset()` if you want both. Useful for
"sign out and forget" flows.

No-op when persistence is not enabled.

###### Returns

`Promise`\<`void`\>

###### Inherited from

[`Sandbox`](#sandbox-3).[`clearPersistence`](#clearpersistence-4)

<a id="dispose"></a>

##### dispose()

```ts
dispose(): void;
```

Tear down listener registries on this sandbox's environment without
replacing it. Use this when you're about to discard the sandbox
itself (e.g. `runner.reseed()` builds a fresh sandbox rather than
calling `reset()`) and want to drop callback references on the
outgoing instance defensively. Idempotent. Does not touch data.

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`dispose`](#dispose-6)

<a id="enablepersistence"></a>

##### enablePersistence()

```ts
enablePersistence(options: SandboxPersistenceOptions): Promise<void>;
```

Persist the sandbox's data to a backend and restore it on next
`enablePersistence` call. The default `'indexedDB'` backend turns
the sandbox into the host page's local Firestore — writes flush
automatically and a fresh `initializeSandbox()` rehydrates from
the prior session.

Restoration happens before the promise resolves; awaiting this
call is sufficient to guarantee in-memory state matches the
persisted blob.

Idempotent across the same `key` — calling twice in one process
is a no-op on the second call. Different keys are rejected as an
error (a sandbox can persist to at most one backend at a time).

Listener semantics: every write event the sandbox emits triggers
a debounced flush (default 250ms). Browser hosts additionally
flush on `beforeunload` so a page navigation doesn't lose the
tail of the debounce window.

See [SandboxPersistenceOptions](#sandboxpersistenceoptions) for backend selection and
tuning.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options` | [`SandboxPersistenceOptions`](#sandboxpersistenceoptions) |

###### Returns

`Promise`\<`void`\>

###### Inherited from

[`Sandbox`](#sandbox-3).[`enablePersistence`](#enablepersistence-4)

<a id="enabletabsync"></a>

##### enableTabSync()

```ts
enableTabSync(options?: TabSyncOptions): () => void;
```

Enable cross-tab realtime sync via `BroadcastChannel`. A write in
this tab will propagate to every OTHER tab of the same origin that
also called `enableTabSync`, causing their `onSnapshot` listeners to
re-evaluate — restoring production's cross-client realtime behavior.

**Opt-in, OFF by default.** Firestore only (RTDB is a follow-on).

Returns a disable function. Calling it removes the `onEvent`
subscription, the channel message listener, and closes the channel
(when it was created internally). After disable, no further propagation
occurs in either direction.

**Multi-writer note:** concurrent writes from two tabs to the same doc
produce last-write-wins divergence — there is no conflict resolution.
The intended model is one active writer (one user, one tab) with
observers in other tabs; this covers the overwhelming majority of
local development scenarios.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`TabSyncOptions`](#tabsyncoptions) |

###### Returns

```ts
(): void;
```

###### Returns

`void`

###### See

[TabSyncOptions](#tabsyncoptions) for channel injection (tests) and originId.

###### Example

```ts
// In every tab that should participate in realtime:
const sandbox = initializeSandbox();
const disableSync = sandbox.enableTabSync();
// Later, to stop syncing:
disableSync();
```

###### Inherited from

[`Sandbox`](#sandbox-3).[`enableTabSync`](#enabletabsync-4)

<a id="flush"></a>

##### flush()

```ts
flush(): Promise<void>;
```

Force a snapshot to the configured persistence backend right now.
Useful before a manual navigation, or in tests that need
deterministic ordering against the debounce window. Resolves once
the write hits the backend.

Throws if persistence is not enabled.

###### Returns

`Promise`\<`void`\>

###### Inherited from

[`Sandbox`](#sandbox-3).[`flush`](#flush-6)

<a id="history"></a>

##### history()

```ts
history(): SandboxEvent[];
```

Every [SandboxEvent](#sandboxevent) this sandbox has emitted since init or
the last `reset()`. Returns a defensive copy.

Use this for replay: hand the array to `replay(events, rules)`
from `pyric/sandbox` and the engine re-issues every
captured write against a fresh sandbox.

Unlike [onEvent](#onevent-4) (live stream from the moment of subscribe),
`history()` returns *every* event the sandbox has seen — useful
for consumers that attach late (e.g., loading a saved session
before subscribing) or that need a snapshot at a particular moment.

`reset()` and `dispose()` each append a closing `session_boundary`
event; `reset()` then clears the history. Consumers that took a
snapshot *before* reset retain the boundary in their copy.

###### Returns

[`SandboxEvent`](#sandboxevent)[]

###### Inherited from

[`Sandbox`](#sandbox-3).[`history`](#history-4)

<a id="loadsnapshot"></a>

##### loadSnapshot()

```ts
loadSnapshot(data: SandboxSnapshot): void;
```

CLOBBER-restore the sandbox's entire state from a prior [snapshot](#snapshot-6):
`reset()` (clears firestore + the signed-in session), then rebuild firestore
from `data` and restore each registered service. This is a TOTAL replace —
documents absent from `data` do NOT survive — and is the counterpart to
[snapshot](#snapshot-6). It is what makes "transfer (clobber) one instance's data
into another" and named-branch switching possible.

Fires a `session_boundary` (reset phase), re-evaluates live listeners against
the loaded state, and the next persistence flush writes the loaded state.
Services present in `data` but not currently registered are skipped (a
snapshot taken via [snapshot](#snapshot-6) always includes every registered
service, so this only affects cross-instance imports from a sandbox that had
a service this one lacks).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `data` | [`SandboxSnapshot`](#sandboxsnapshot-2) |

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`loadSnapshot`](#loadsnapshot-4)

<a id="oncurrentuserchanged"></a>

##### onCurrentUserChanged()

```ts
onCurrentUserChanged(cb: (user: {
  token?: Record<string, unknown>;
  uid: string;
}) => void): () => void;
```

Subscribe to `currentUser` changes. Fires on every mutation —
sign-in, sign-out, user swap. Does NOT fire on subscribe.

Survives `reset()` and `dispose()` only as a no-op: a disposed
sandbox emits nothing further; a reset sandbox clears
`currentUser` to `null` (and fires the change) before swapping
the env.

Returns an unsubscribe function. Listener errors are swallowed —
subscribers are observational, the sandbox does not propagate
their errors.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `cb` | (`user`: \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \}) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`onCurrentUserChanged`](#oncurrentuserchanged-4)

<a id="onevent"></a>

##### onEvent()

```ts
onEvent(cb: (event: SandboxEvent) => void): () => void;
```

Subscribe to every event the sandbox emits — see [SandboxEvent](#sandboxevent)
for the discriminated-union shape. One subscription covers
request/denial/snapshot-error/listener-lifecycle/session-boundary;
filter on `event.kind` to recover individual streams.

Replaces the prior three-channel surface (`onRequest` / `onDenial`
/ `onSnapshotError`) — see issue #307. Filter cookbook:
  - All denials:    `event.kind === 'request' && event.result === 'deny'`
  - Stream errors:  `event.kind === 'listener_errored'`
  - Per-op traffic: `event.kind === 'request'`

Survives `sandbox.reset()` — the subscription is held on the
sandbox, not on the underlying environment. A `session_boundary`
event with `phase: 'reset'` fires before the env swap so consumers
can segment their stream.

Returns an unsubscribe function. Listener errors are swallowed so a
faulty subscriber can't change rule semantics or hide other events.
Both synchronous throws and rejected Promises from async callbacks
are silently discarded — subscribers are **observational**, the
sandbox doesn't await them and doesn't propagate their errors.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `cb` | (`event`: [`SandboxEvent`](#sandboxevent)) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`onEvent`](#onevent-4)

<a id="registerpersistableservice"></a>

##### registerPersistableService()

```ts
registerPersistableService(name: string, hooks: PersistableService): () => void;
```

Register a service (auth, storage, …) as a persistence participant.
The sandbox calls `hooks.snapshot()` on every flush and
`hooks.restore(data)` on restore. If `hooks.subscribe` is provided,
the persistence controller subscribes and schedules a debounced
flush on each change — so auth-user edits flush promptly, not only
on the next Firestore write.

Returns an unregister function — call it if the service is torn
down before the sandbox is disposed (uncommon in practice; the
sandbox's `dispose()` clears the registry anyway).

Throws `failed-precondition` when a service with the same `name` is
already registered — the auth package registers `'auth'` once when
`getAuth(sandbox)` first creates a backend, so accidental double-
registration is a caller bug, not a no-op.

**Advanced / internal API.** Service packages (auth, storage) call
this when they first attach to a sandbox. Consumer app code should
not need to call this directly.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `name` | `string` |
| `hooks` | [`PersistableService`](#persistableservice) |

###### Returns

```ts
(): void;
```

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`registerPersistableService`](#registerpersistableservice-4)

<a id="reset"></a>

##### reset()

```ts
reset(): void;
```

Reset the underlying environment to a fresh state — wipes data,
rules, and any service-specific configuration.

Snapshot listeners attached to the OLD environment are dropped at
the swap — they can't survive because their target docs have been
wiped. `onEvent` subscribers DO survive — the registry lives on
the sandbox, and a `session_boundary` event with `phase: 'reset'`
fires before the swap so subscribers know the rollover happened.
Existing [SandboxContext](#sandboxcontext)s continue to work — their sandbox
reference is stable; subsequent operations resolve to the new env.

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`reset`](#reset-4)

<a id="runwithprovenance"></a>

##### runWithProvenance()?

```ts
optional runWithProvenance<T>(provenance: EventProvenance, fn: () => T): T;
```

Run `fn` with ambient [EventProvenance](#eventprovenance) defaults: every event
emitted SYNCHRONOUSLY during `fn` that doesn't already carry a
provenance field (on the event itself or via an explicit per-emit
override) is stamped with these values instead of the global
defaults. This is the mechanical "who issued this op" seam the
serve worker uses to tag Studio-issued ops (`actor: { kind:
'studio' }`) and to stamp the auth lens an op ran under
(`authLens`) — declared by the caller that issues the op, never
inferred from the op's shape.

SYNCHRONOUS WINDOW: the ambient values apply only until `fn`
returns (for an async `fn`, its synchronous prefix — which covers
the local environment's rules eval + event emission, since those
run before the op's promise is handed back). Work an op DEFERS
(snapshot-listener deliveries and re-evals drain on a microtask,
off-stack) is intentionally OUTSIDE the window: a listener re-eval
belongs to the listener's owner, not to whoever's write triggered
it. Nested calls stack — the innermost window wins per field, and
each window restores the previous one on exit (including on throw).

OPTIONAL because remote sandbox proxies can't provide an ambient
emit window (events are emitted in the worker they front). Callers
spell `sandbox.runWithProvenance?.(prov, fn) ?? fn()`.

###### Type Parameters

| Type Parameter |
| :------ |
| `T` |

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `provenance` | [`EventProvenance`](#eventprovenance) |
| `fn` | () => `T` |

###### Returns

`T`

###### Inherited from

[`Sandbox`](#sandbox-3).[`runWithProvenance`](#runwithprovenance-4)

<a id="snapshot"></a>

##### snapshot()

```ts
snapshot(): SandboxSnapshot;
```

Capture a snapshot of every service's state. For v1 with only
Firestore, the return value carries a `firestore` key mapping doc
paths to data. Future services will add their own keys.

###### Returns

[`SandboxSnapshot`](#sandboxsnapshot-2)

###### Inherited from

[`Sandbox`](#sandbox-3).[`snapshot`](#snapshot-6)

<a id="withauth-2"></a>

##### withAuth()

```ts
withAuth(auth: {
  token?: Record<string, unknown>;
  uid: string;
}): SandboxContext;
```

Derive a context bound to this sandbox under the given auth
identity. Operations through services attached to the returned
context evaluate rules under that identity. Many contexts can
coexist for one sandbox; data is shared.

`null` is anonymous; an `AuthState` object names the user (and
optional custom claims). Passing `undefined` is a deliberate
error — say `withAuth(null)` for anonymous so the call site is
unambiguous.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `Record`\<`string`, `unknown`\> |
| `auth.uid` | `string` |

###### Returns

[`SandboxContext`](#sandboxcontext)

###### Example

```ts
const sandbox = initializeSandbox();
const dbAlice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const dbAnon  = getFirestore(sandbox.withAuth(null));
```

###### Inherited from

[`Sandbox`](#sandbox-3).[`withAuth`](#withauth-6)

***

<a id="operationcontext-2"></a>

### OperationContext

Immutable operation provenance, bound where an operation is issued.
Source and auth lens are deliberately orthogonal: Studio may evaluate rules
as a user, while an app or agent may use an admin lens.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="authlens-1"></a> `authLens` | `readonly` | [`AuthLens`](#authlens-2) |
| <a id="planid-1"></a> `planId?` | `readonly` | `string` |
| <a id="source"></a> `source` | `readonly` | [`EventActor`](#eventactor) |

***

<a id="operationrecord"></a>

### OperationRecord

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="at-1"></a> `at` | `readonly` | `number` |
| <a id="auth-4"></a> `auth` | `readonly` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `public` | `Record`\<`string`, `unknown`\> |
| `auth.uid` | `public` | `string` |
| <a id="context"></a> `context` | `readonly` | [`OperationContext`](#operationcontext-2) |
| <a id="eventkind"></a> `eventKind` | `readonly` | `"request"` \| `"operation"` |
| <a id="id-1"></a> `id` | `readonly` | `string` |
| <a id="method"></a> `method` | `readonly` | `string` |
| <a id="path"></a> `path?` | `readonly` | `string` |
| <a id="result"></a> `result` | `readonly` | `"allow"` \| `"deny"` \| `"unsupported"` \| `"error"` \| `"not-applicable"` |
| <a id="rules-1"></a> `rules` | `readonly` | [`RulesDisposition`](#rulesdisposition-2) |
| <a id="service-1"></a> `service` | `readonly` | [`EventService`](#eventservice) |

***

<a id="persistableservice"></a>

### PersistableService

Contract for a service that can contribute its state to the sandbox
persistence layer. Services (auth, storage, database) register
themselves via [Sandbox.registerPersistableService](#registerpersistableservice-4) so the
sandbox core stays service-agnostic — the sandbox doesn't know what
auth or storage look like; it just calls `snapshot()` / `restore()`.

`subscribe` is optional but strongly recommended: without it, a
service's changes (e.g. new users created via auth) only reach the
persisted blob on the next Firestore write. With `subscribe`, the
controller debounces a flush on every user-DB change — same latency
as Firestore writes.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="session"></a> `session?` | \{ `currentUid`: `string`; `mode`: `"LOCAL"` \| `"SESSION"` \| `"NONE"`; `restore`: `void`; `subscribe`: () => `void`; \} | Optional: session-level persistence hooks. When provided, the persistence controller uses these to save and restore the CURRENTLY SIGNED-IN user (not the user database — that's `snapshot`/`restore`). The controller calls `session.subscribe` so it hears every sign-in / sign-out, then writes the uid to the appropriate web-storage slot (determined by `session.mode()`). On init, the controller reads the stored uid and its storage-derived mode, then calls `session.restore(uid, mode)` to re-establish both before firing `onAuthStateChanged` as if the user just signed in. Only active when `SandboxPersistenceOptions.sessionStorage` is provided; omitting `sessionStorage` causes the controller to skip session persistence entirely (no fake durability). Auth is the only service that provides session hooks today. The field is on the generic interface so the controller stays service-agnostic — if a second service ever needs session-style semantics it can add its own hooks without changing the controller. |
| `session.currentUid` | `string` | - |
| `session.mode` | `"LOCAL"` \| `"SESSION"` \| `"NONE"` | - |
| `session.restore` | `void` | - |
| `session.subscribe` | () => `void` | - |
| <a id="subscribe"></a> `subscribe?` | (`onChange`: () => `void`) => () => `void` | Optional: subscribe to changes in this service's state. When provided, the persistence controller hooks it up and schedules a debounced flush on each change — ensuring auth-user edits reach the backend promptly, not only on the next Firestore write. Must return an unsubscribe function. The controller unsubscribes on `dispose()`. |

#### Methods

<a id="restore"></a>

##### restore()

```ts
restore(data: unknown): void;
```

Restore previously snapshotted state. Called once during
`enablePersistence`, AFTER Firestore docs have been restored (so
any service that needs Firestore to be hydrated first can rely on
that ordering). Guard against bad data — the blob came from disk
and may be stale or from a schema migration.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `data` | `unknown` |

###### Returns

`void`

<a id="snapshot-2"></a>

##### snapshot()

```ts
snapshot(): unknown;
```

Return a plain-JSON-serializable snapshot of this service's state.
Called by the persistence controller on every flush. The return
value is stored under the service's registered name in the
`services` map of the persisted blob.

###### Returns

`unknown`

***

<a id="persistencebackend"></a>

### PersistenceBackend

Backend contract: read/write/list/delete RECORDS under a key. The controller
partitions a snapshot into structured-clone bucket records (chunk-format.ts) so
the backend stores many small records natively, never one keyspace-sized blob.
Record values are structured-clone-safe objects; the backend never interprets
them. (v2 and earlier used a single string blob; v3 is record-shaped.)

#### Methods

<a id="clear"></a>

##### clear()

```ts
clear(key: string): Promise<void>;
```

Remove ALL records under `key`. No-op if none exist.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `key` | `string` |

###### Returns

`Promise`\<`void`\>

<a id="deleterecords"></a>

##### deleteRecords()

```ts
deleteRecords(key: string, recordIds: readonly string[]): Promise<void>;
```

Delete the given record ids under `key`. No-op for ids that don't exist.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `key` | `string` |
| `recordIds` | readonly `string`[] |

###### Returns

`Promise`\<`void`\>

<a id="estimate"></a>

##### estimate()?

```ts
optional estimate(): Promise<{
  quota: number;
  usage: number;
}>;
```

Best-effort storage usage estimate (bytes used + the quota ceiling), or
`null` when the backend can't report it. Surfaced by the metadata API so a
host can show how close the sandbox is to its storage limit. Optional: a
backend that can't estimate simply omits it.

###### Returns

`Promise`\<\{
  `quota`: `number`;
  `usage`: `number`;
\}\>

<a id="getrecord"></a>

##### getRecord()

```ts
getRecord(key: string, recordId: string): Promise<unknown>;
```

Read one record by id under `key`. Resolves `null` when absent.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `key` | `string` |
| `recordId` | `string` |

###### Returns

`Promise`\<`unknown`\>

<a id="listrecords"></a>

##### listRecords()

```ts
listRecords(key: string): Promise<string[]>;
```

List all record ids under `key`, any order.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `key` | `string` |

###### Returns

`Promise`\<`string`[]\>

<a id="putrecords"></a>

##### putRecords()

```ts
putRecords(key: string, records: ReadonlyMap<string, unknown>): Promise<void>;
```

Write each `[recordId, value]` under `key`, replacing any prior value.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `key` | `string` |
| `records` | `ReadonlyMap`\<`string`, `unknown`\> |

###### Returns

`Promise`\<`void`\>

***

<a id="persistencecontroller"></a>

### PersistenceController

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="options"></a> `options` | `readonly` | `Readonly`\<[`SandboxPersistenceOptions`](#sandboxpersistenceoptions)\> |

#### Methods

<a id="clear-2"></a>

##### clear()

```ts
clear(): Promise<void>;
```

Wipe persisted state. In-memory state is untouched.

###### Returns

`Promise`\<`void`\>

<a id="dispose-2"></a>

##### dispose()

```ts
dispose(): void;
```

Detach event subscription + beforeunload listener.

###### Returns

`void`

<a id="flush-2"></a>

##### flush()

```ts
flush(): Promise<void>;
```

Force a flush of the current sandbox state to the backend.

###### Returns

`Promise`\<`void`\>

***

<a id="remotesandbox"></a>

### RemoteSandbox

A branded remote sandbox handle. Structurally a [Sandbox](#sandbox-3) — it can
be passed anywhere a `Sandbox` is accepted (notably
`pyric-admin/app`'s `initializeApp({ sandbox })`) — but sync-only members
that cannot be mirrored over the wire (`admin`, `snapshot()`,
`history()`, …) throw a remediating error. Consumers with a remote arm
dispatch on [isRemoteSandbox](#isremotesandbox) and use [channel](#channel) instead.

#### Extends

- [`Sandbox`](#sandbox-3)

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="remote_sandbox"></a> `[REMOTE_SANDBOX]` | `readonly` | `true` | - |
| <a id="admin-1"></a> `admin` | `readonly` | `SandboxAdmin` | Admin-plane access (rule-bypass reads). Identity-agnostic by design — admin reads aren't gated on auth, so they live on the sandbox, not on a context. See SandboxAdmin. |
| <a id="channel"></a> `channel` | `readonly` | [`RemoteSandboxChannel`](#remotesandboxchannel-1) | The raw worker op/sub relay channel. |
| <a id="currentuser-1"></a> `currentUser` | `public` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | Current authenticated user across the sandbox. Mutated by `pyric/auth`'s `signInAnonymously` / `signInWithEmailAndPassword` / `signOut` / `sandbox.setUser`. Read per-call by service factories (e.g. a future `getFirestore(sandbox)` overload) so they see auth state changes without re-binding handles. Defaults to `null` (anonymous / signed out). **Independent of `withAuth({uid})`** — `withAuth` still produces a frozen [SandboxContext](#sandboxcontext) that carries its own identity for the runner's test code (the existing pattern: explicit identity per service call). `currentUser` exists for the `pyric/auth` mirror, where consumer app code drives identity through a stateful `Auth` handle rather than naming it per call. |
| `currentUser.token?` | `public` | `Record`\<`string`, `unknown`\> | - |
| `currentUser.uid` | `public` | `string` | - |
| <a id="serveurl"></a> `serveUrl` | `readonly` | `string` | Base URL of the `pyric dev` this handle is attached to (used in error guidance: "open <serveUrl> in a browser and retry"). |

#### Methods

<a id="clearpersistence-2"></a>

##### clearPersistence()

```ts
clearPersistence(): Promise<void>;
```

Wipe the persisted blob for this sandbox's `key`. In-memory state
is left intact — call `reset()` if you want both. Useful for
"sign out and forget" flows.

No-op when persistence is not enabled.

###### Returns

`Promise`\<`void`\>

###### Inherited from

[`Sandbox`](#sandbox-3).[`clearPersistence`](#clearpersistence-4)

<a id="dispose-4"></a>

##### dispose()

```ts
dispose(): void;
```

Tear down listener registries on this sandbox's environment without
replacing it. Use this when you're about to discard the sandbox
itself (e.g. `runner.reseed()` builds a fresh sandbox rather than
calling `reset()`) and want to drop callback references on the
outgoing instance defensively. Idempotent. Does not touch data.

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`dispose`](#dispose-6)

<a id="enablepersistence-2"></a>

##### enablePersistence()

```ts
enablePersistence(options: SandboxPersistenceOptions): Promise<void>;
```

Persist the sandbox's data to a backend and restore it on next
`enablePersistence` call. The default `'indexedDB'` backend turns
the sandbox into the host page's local Firestore — writes flush
automatically and a fresh `initializeSandbox()` rehydrates from
the prior session.

Restoration happens before the promise resolves; awaiting this
call is sufficient to guarantee in-memory state matches the
persisted blob.

Idempotent across the same `key` — calling twice in one process
is a no-op on the second call. Different keys are rejected as an
error (a sandbox can persist to at most one backend at a time).

Listener semantics: every write event the sandbox emits triggers
a debounced flush (default 250ms). Browser hosts additionally
flush on `beforeunload` so a page navigation doesn't lose the
tail of the debounce window.

See [SandboxPersistenceOptions](#sandboxpersistenceoptions) for backend selection and
tuning.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options` | [`SandboxPersistenceOptions`](#sandboxpersistenceoptions) |

###### Returns

`Promise`\<`void`\>

###### Inherited from

[`Sandbox`](#sandbox-3).[`enablePersistence`](#enablepersistence-4)

<a id="enabletabsync-2"></a>

##### enableTabSync()

```ts
enableTabSync(options?: TabSyncOptions): () => void;
```

Enable cross-tab realtime sync via `BroadcastChannel`. A write in
this tab will propagate to every OTHER tab of the same origin that
also called `enableTabSync`, causing their `onSnapshot` listeners to
re-evaluate — restoring production's cross-client realtime behavior.

**Opt-in, OFF by default.** Firestore only (RTDB is a follow-on).

Returns a disable function. Calling it removes the `onEvent`
subscription, the channel message listener, and closes the channel
(when it was created internally). After disable, no further propagation
occurs in either direction.

**Multi-writer note:** concurrent writes from two tabs to the same doc
produce last-write-wins divergence — there is no conflict resolution.
The intended model is one active writer (one user, one tab) with
observers in other tabs; this covers the overwhelming majority of
local development scenarios.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`TabSyncOptions`](#tabsyncoptions) |

###### Returns

```ts
(): void;
```

###### Returns

`void`

###### See

[TabSyncOptions](#tabsyncoptions) for channel injection (tests) and originId.

###### Example

```ts
// In every tab that should participate in realtime:
const sandbox = initializeSandbox();
const disableSync = sandbox.enableTabSync();
// Later, to stop syncing:
disableSync();
```

###### Inherited from

[`Sandbox`](#sandbox-3).[`enableTabSync`](#enabletabsync-4)

<a id="flush-4"></a>

##### flush()

```ts
flush(): Promise<void>;
```

Force a snapshot to the configured persistence backend right now.
Useful before a manual navigation, or in tests that need
deterministic ordering against the debounce window. Resolves once
the write hits the backend.

Throws if persistence is not enabled.

###### Returns

`Promise`\<`void`\>

###### Inherited from

[`Sandbox`](#sandbox-3).[`flush`](#flush-6)

<a id="history-2"></a>

##### history()

```ts
history(): SandboxEvent[];
```

Every [SandboxEvent](#sandboxevent) this sandbox has emitted since init or
the last `reset()`. Returns a defensive copy.

Use this for replay: hand the array to `replay(events, rules)`
from `pyric/sandbox` and the engine re-issues every
captured write against a fresh sandbox.

Unlike [onEvent](#onevent-4) (live stream from the moment of subscribe),
`history()` returns *every* event the sandbox has seen — useful
for consumers that attach late (e.g., loading a saved session
before subscribing) or that need a snapshot at a particular moment.

`reset()` and `dispose()` each append a closing `session_boundary`
event; `reset()` then clears the history. Consumers that took a
snapshot *before* reset retain the boundary in their copy.

###### Returns

[`SandboxEvent`](#sandboxevent)[]

###### Inherited from

[`Sandbox`](#sandbox-3).[`history`](#history-4)

<a id="loadsnapshot-2"></a>

##### loadSnapshot()

```ts
loadSnapshot(data: SandboxSnapshot): void;
```

CLOBBER-restore the sandbox's entire state from a prior [snapshot](#snapshot-6):
`reset()` (clears firestore + the signed-in session), then rebuild firestore
from `data` and restore each registered service. This is a TOTAL replace —
documents absent from `data` do NOT survive — and is the counterpart to
[snapshot](#snapshot-6). It is what makes "transfer (clobber) one instance's data
into another" and named-branch switching possible.

Fires a `session_boundary` (reset phase), re-evaluates live listeners against
the loaded state, and the next persistence flush writes the loaded state.
Services present in `data` but not currently registered are skipped (a
snapshot taken via [snapshot](#snapshot-6) always includes every registered
service, so this only affects cross-instance imports from a sandbox that had
a service this one lacks).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `data` | [`SandboxSnapshot`](#sandboxsnapshot-2) |

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`loadSnapshot`](#loadsnapshot-4)

<a id="oncurrentuserchanged-2"></a>

##### onCurrentUserChanged()

```ts
onCurrentUserChanged(cb: (user: {
  token?: Record<string, unknown>;
  uid: string;
}) => void): () => void;
```

Subscribe to `currentUser` changes. Fires on every mutation —
sign-in, sign-out, user swap. Does NOT fire on subscribe.

Survives `reset()` and `dispose()` only as a no-op: a disposed
sandbox emits nothing further; a reset sandbox clears
`currentUser` to `null` (and fires the change) before swapping
the env.

Returns an unsubscribe function. Listener errors are swallowed —
subscribers are observational, the sandbox does not propagate
their errors.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `cb` | (`user`: \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \}) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`onCurrentUserChanged`](#oncurrentuserchanged-4)

<a id="onevent-2"></a>

##### onEvent()

```ts
onEvent(cb: (event: SandboxEvent) => void): () => void;
```

Subscribe to every event the sandbox emits — see [SandboxEvent](#sandboxevent)
for the discriminated-union shape. One subscription covers
request/denial/snapshot-error/listener-lifecycle/session-boundary;
filter on `event.kind` to recover individual streams.

Replaces the prior three-channel surface (`onRequest` / `onDenial`
/ `onSnapshotError`) — see issue #307. Filter cookbook:
  - All denials:    `event.kind === 'request' && event.result === 'deny'`
  - Stream errors:  `event.kind === 'listener_errored'`
  - Per-op traffic: `event.kind === 'request'`

Survives `sandbox.reset()` — the subscription is held on the
sandbox, not on the underlying environment. A `session_boundary`
event with `phase: 'reset'` fires before the env swap so consumers
can segment their stream.

Returns an unsubscribe function. Listener errors are swallowed so a
faulty subscriber can't change rule semantics or hide other events.
Both synchronous throws and rejected Promises from async callbacks
are silently discarded — subscribers are **observational**, the
sandbox doesn't await them and doesn't propagate their errors.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `cb` | (`event`: [`SandboxEvent`](#sandboxevent)) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`onEvent`](#onevent-4)

<a id="registerpersistableservice-2"></a>

##### registerPersistableService()

```ts
registerPersistableService(name: string, hooks: PersistableService): () => void;
```

Register a service (auth, storage, …) as a persistence participant.
The sandbox calls `hooks.snapshot()` on every flush and
`hooks.restore(data)` on restore. If `hooks.subscribe` is provided,
the persistence controller subscribes and schedules a debounced
flush on each change — so auth-user edits flush promptly, not only
on the next Firestore write.

Returns an unregister function — call it if the service is torn
down before the sandbox is disposed (uncommon in practice; the
sandbox's `dispose()` clears the registry anyway).

Throws `failed-precondition` when a service with the same `name` is
already registered — the auth package registers `'auth'` once when
`getAuth(sandbox)` first creates a backend, so accidental double-
registration is a caller bug, not a no-op.

**Advanced / internal API.** Service packages (auth, storage) call
this when they first attach to a sandbox. Consumer app code should
not need to call this directly.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `name` | `string` |
| `hooks` | [`PersistableService`](#persistableservice) |

###### Returns

```ts
(): void;
```

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`registerPersistableService`](#registerpersistableservice-4)

<a id="reset-2"></a>

##### reset()

```ts
reset(): void;
```

Reset the underlying environment to a fresh state — wipes data,
rules, and any service-specific configuration.

Snapshot listeners attached to the OLD environment are dropped at
the swap — they can't survive because their target docs have been
wiped. `onEvent` subscribers DO survive — the registry lives on
the sandbox, and a `session_boundary` event with `phase: 'reset'`
fires before the swap so subscribers know the rollover happened.
Existing [SandboxContext](#sandboxcontext)s continue to work — their sandbox
reference is stable; subsequent operations resolve to the new env.

###### Returns

`void`

###### Inherited from

[`Sandbox`](#sandbox-3).[`reset`](#reset-4)

<a id="runwithprovenance-2"></a>

##### runWithProvenance()?

```ts
optional runWithProvenance<T>(provenance: EventProvenance, fn: () => T): T;
```

Run `fn` with ambient [EventProvenance](#eventprovenance) defaults: every event
emitted SYNCHRONOUSLY during `fn` that doesn't already carry a
provenance field (on the event itself or via an explicit per-emit
override) is stamped with these values instead of the global
defaults. This is the mechanical "who issued this op" seam the
serve worker uses to tag Studio-issued ops (`actor: { kind:
'studio' }`) and to stamp the auth lens an op ran under
(`authLens`) — declared by the caller that issues the op, never
inferred from the op's shape.

SYNCHRONOUS WINDOW: the ambient values apply only until `fn`
returns (for an async `fn`, its synchronous prefix — which covers
the local environment's rules eval + event emission, since those
run before the op's promise is handed back). Work an op DEFERS
(snapshot-listener deliveries and re-evals drain on a microtask,
off-stack) is intentionally OUTSIDE the window: a listener re-eval
belongs to the listener's owner, not to whoever's write triggered
it. Nested calls stack — the innermost window wins per field, and
each window restores the previous one on exit (including on throw).

OPTIONAL because remote sandbox proxies can't provide an ambient
emit window (events are emitted in the worker they front). Callers
spell `sandbox.runWithProvenance?.(prov, fn) ?? fn()`.

###### Type Parameters

| Type Parameter |
| :------ |
| `T` |

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `provenance` | [`EventProvenance`](#eventprovenance) |
| `fn` | () => `T` |

###### Returns

`T`

###### Inherited from

[`Sandbox`](#sandbox-3).[`runWithProvenance`](#runwithprovenance-4)

<a id="snapshot-4"></a>

##### snapshot()

```ts
snapshot(): SandboxSnapshot;
```

Capture a snapshot of every service's state. For v1 with only
Firestore, the return value carries a `firestore` key mapping doc
paths to data. Future services will add their own keys.

###### Returns

[`SandboxSnapshot`](#sandboxsnapshot-2)

###### Inherited from

[`Sandbox`](#sandbox-3).[`snapshot`](#snapshot-6)

<a id="withauth-4"></a>

##### withAuth()

```ts
withAuth(auth: {
  token?: Record<string, unknown>;
  uid: string;
}): SandboxContext;
```

Derive a context bound to this sandbox under the given auth
identity. Operations through services attached to the returned
context evaluate rules under that identity. Many contexts can
coexist for one sandbox; data is shared.

`null` is anonymous; an `AuthState` object names the user (and
optional custom claims). Passing `undefined` is a deliberate
error — say `withAuth(null)` for anonymous so the call site is
unambiguous.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `Record`\<`string`, `unknown`\> |
| `auth.uid` | `string` |

###### Returns

[`SandboxContext`](#sandboxcontext)

###### Example

```ts
const sandbox = initializeSandbox();
const dbAlice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const dbAnon  = getFirestore(sandbox.withAuth(null));
```

###### Inherited from

[`Sandbox`](#sandbox-3).[`withAuth`](#withauth-6)

***

<a id="remotesandboxchannel-1"></a>

### RemoteSandboxChannel

The minimal worker-relay channel a remote sandbox handle carries.

Structural mirror of `@pyric/cli/remote`'s `RemoteSandboxChannel`: one
method to dispatch any SharedWorker-protocol op, one to register a
snap-delivering subscription. Payloads are typed openly here (the real
discriminated unions live in `@pyric/cli`' worker protocol); callers in
`pyric-admin` spell the concrete op objects (`rtdb.set`, `auth.listUsers`,
…) and pin their own `actAs` lens — nothing is pinned by the channel.

#### Methods

<a id="op"></a>

##### op()

```ts
op(op: {
  method: string;
} & Record<string, unknown>): Promise<unknown>;
```

Dispatch one worker op. Resolves with the worker's result value;
rejects with an `Error` carrying a `.code` (including the fail-fast
"no browser tab is connected — open <serve url>" guidance when no
peer is registered).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `op` | \{ `method`: `string`; \} & `Record`\<`string`, `unknown`\> |

###### Returns

`Promise`\<`unknown`\>

<a id="subscribe-1"></a>

##### subscribe()

```ts
subscribe(
   sub: {
  target: unknown;
} & Record<string, unknown>,
   onSnap: (value: unknown) => void,
   onError?: (err: Error & {
  code: string;
}) => void): () => void;
```

Register a worker subscription (e.g. an RTDB value listener:
`{ target: { service: 'rtdb', path } }`). `onSnap` receives every snap
value (initial + updates — and re-delivered fresh after peer
replacement); an establishment failure routes to `onError` instead.
Returns the unsubscribe function.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `sub` | \{ `target`: `unknown`; \} & `Record`\<`string`, `unknown`\> |
| `onSnap` | (`value`: `unknown`) => `void` |
| `onError?` | (`err`: `Error` & \{ `code`: `string`; \}) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

***

<a id="remotesandboxfactoryoptions"></a>

### RemoteSandboxFactoryOptions

Options accepted by the ambient remote-sandbox factory.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="url"></a> `url?` | `string` | Explicit `pyric dev` base URL (from `PYRIC_SANDBOX=remote:<url>`). When omitted the factory discovers the running host itself (the `.pyric/serve.json` locator protocol). |

***

<a id="replayoptions"></a>

### ReplayOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="pinrequesttime"></a> `pinRequestTime?` | `boolean` | When true (default), re-issue the captured `requestTime` so `serverTimestamp()` sentinels resolve to the same value as capture and `request.time`-gated rules evaluate identically. |

***

<a id="replayresult"></a>

### ReplayResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="divergences"></a> `divergences` | [`Divergence`](#divergence)[] | Field- and path-level differences between original and replayed state, classified. |
| <a id="pathaliases"></a> `pathAliases` | `Map`\<`string`, `string`\> | Maps captured auto-id paths → freshly-minted replay paths. The diff classifier uses this to skip `autoid-alias` paths when computing field-level differences. |
| <a id="sandbox-2"></a> `sandbox` | [`LocalSandbox`](#localsandbox) | Fresh sandbox with the captured writes re-applied. |

***

<a id="requestevent"></a>

### RequestEvent

Eval-time payload emitted to Sandbox.onRequest subscribers —
one per evaluated op, regardless of outcome.

Issue #307: the playground today only renders denials, but every op
the simulator evaluates is a request worth seeing. This event is the
source of truth; [DenialEvent](#denialevent) is a filtered projection over
the `result === 'deny'` subset.

Origin tells the consumer who initiated the eval:
  - `user`        single op via the data-plane adapter (admin / firestore).
  - `batch`       part of a multi-op batch — shares `groupId` with siblings.
  - `transaction` part of a transaction commit — shares `groupId`.
  - `listener`    a write or `deployRules` triggered a snapshot listener
                  to re-evaluate. Carries `triggeredBy` naming the
                  originating user op (when knowable).

`evalMs` measures the wall-clock duration of the simulator's
`simulate(...)` call. Sub-millisecond is normal for simple rules;
rule-engine-heavy rules (deep boolean chains, many get() calls) can
reach tens of milliseconds; a traffic-monitor validation probe measured
connect-four rules at ~95ms p99. Surface this in your UI when it matters.

Listener throws are swallowed by the dispatcher so a faulty
subscriber can't change rule semantics or hide other events.

#### See

traffic-monitor-decision.md for the field-by-field rationale.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="at-2"></a> `at` | `number` | Wall-clock at op start, ms since epoch. |
| <a id="auth-5"></a> `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | - |
| `auth.token?` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="detail"></a> `detail?` | \{ `admin?`: `boolean`; \} & `Record`\<`string`, `unknown`\> | Free-form operation metadata. `admin: true` marks a rules-bypassing setup/admin operation so fixture tooling can exclude it from protected behavior while still preserving it as replay context. |
| <a id="evalms"></a> `evalMs` | `number` | Wall-clock duration of the simulator.simulate(...) call, in ms. |
| <a id="evaluatedrule"></a> `evaluatedRule?` | `EvaluatedRuleInfo` | The DECIDING rule's verdict + 1-indexed source line + full sub-expression trace, projected from the simulator's structured `RuleEvaluation` (additive: present on `result: 'allow' | 'deny'` Firestore events when the simulator produced a per-rule trace — the allowing rule on an allow, the denying rule on a deny). Studio's rules inspector reads this to mark the deciding line and render the evaluation step-through ("show the work"). Absent on an implicit deny (no rule evaluated), a simulator-error deny, and unsupported results. |
| <a id="groupid"></a> `groupId?` | `string` | Shared across ops in one batch or transaction. Opaque to consumers. |
| <a id="groupkind"></a> `groupKind?` | `"transaction"` \| `"batch"` | Disambiguates `origin: 'transaction' | 'batch'` cases when consumers need to tell them apart without inspecting `origin` directly. |
| <a id="id-2"></a> `id` | `string` | Unique within a sandbox process. Useful for React list keys. |
| <a id="kind-1"></a> `kind` | `"request"` | Discriminator. |
| <a id="matchedrule"></a> `matchedRule?` | \{ `operations`: `string`[]; `ruleIndex`: `number`; \} | Parsed from the simulator's "Rule #N → …" debug line. Absent when no rule matched (e.g. no allow rules at the path — implicit deny). |
| `matchedRule.operations` | `string`[] | - |
| `matchedRule.ruleIndex` | `number` | - |
| <a id="method-1"></a> `method` | `"get"` \| `"list"` \| `"create"` \| `"update"` \| `"delete"` \| `"set"` | - |
| <a id="origin"></a> `origin` | `"user"` \| `"listener"` \| `"transaction"` \| `"batch"` | - |
| <a id="path-1"></a> `path` | `string` | - |
| <a id="reasons-2"></a> `reasons` | `string`[] | Simulator debug messages — the per-rule trace (`Rule #0 (read) → ALLOW`). Same shape as `DenialEvent.reasons` so consumer code can share rendering. |
| <a id="request-2"></a> `request?` | \{ `resourceData?`: `Record`\<`string`, `unknown`\>; \} | Proposed write payload, for create/update/set. Absent on reads + delete. Pre-resolution: `FieldValue.*` sentinels are preserved as their marker shapes (`{ __type: 'serverTimestamp' }`, etc.) so the replay engine can re-resolve them. The rule engine evaluated against the resolved form internally; that resolved form lives on [WriteSandboxEvent.nextState](#nextstate-1), not here. |
| `request.resourceData?` | `Record`\<`string`, `unknown`\> | - |
| <a id="resourceafter"></a> `resourceAfter?` | \{ `data`: `Record`\<`string`, `unknown`\>; `exists`: `boolean`; \} | Projected document state after the write. Absent on reads. |
| `resourceAfter.data` | `Record`\<`string`, `unknown`\> | - |
| `resourceAfter.exists` | `boolean` | - |
| <a id="resourcebefore"></a> `resourceBefore?` | \{ `data`: `Record`\<`string`, `unknown`\>; `exists`: `boolean`; \} | Existing document state before the write (or read target for get). |
| `resourceBefore.data` | `Record`\<`string`, `unknown`\> | - |
| `resourceBefore.exists` | `boolean` | - |
| <a id="result-1"></a> `result` | `"allow"` \| `"deny"` \| `"unsupported"` | `'unsupported'` fires when the simulator hit an unmodelled feature and the sandbox upgraded it (today: thrown as SimulatorUnsupportedError, surfaced here as a discrete result so the panel can show it distinctly from a real denial). |
| <a id="rulesdisposition"></a> `rulesDisposition?` | [`RulesDisposition`](#rulesdisposition-2) | Canonical statement of whether Security Rules evaluated this request. Added by the sandbox event recorder when an older emitter omits it. |
| <a id="triggeredby"></a> `triggeredBy?` | \{ `method`: `string`; `path`: `string`; \} | For listener re-evals: the originating user op that triggered this re-evaluation. Absent on the initial-snapshot fire. |
| `triggeredBy.method` | `string` | - |
| `triggeredBy.path` | `string` | - |

***

<a id="sandbox-3"></a>

### Sandbox

A Firebase sandbox — an isolated environment with one auth identity.

Created via `initializeSandbox(config)`. Use `fork({ auth })` to
derive a new sandbox with a different identity that shares the
underlying environment (rules, data, state). Fork is the only
identity-switching mechanism — there are no per-op auth overrides
and no in-place mutation.

#### Extended by

- [`LocalSandbox`](#localsandbox)
- [`RemoteSandbox`](#remotesandbox)

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="admin-2"></a> `admin` | `readonly` | `SandboxAdmin` | Admin-plane access (rule-bypass reads). Identity-agnostic by design — admin reads aren't gated on auth, so they live on the sandbox, not on a context. See SandboxAdmin. |
| <a id="currentuser-2"></a> `currentUser` | `public` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | Current authenticated user across the sandbox. Mutated by `pyric/auth`'s `signInAnonymously` / `signInWithEmailAndPassword` / `signOut` / `sandbox.setUser`. Read per-call by service factories (e.g. a future `getFirestore(sandbox)` overload) so they see auth state changes without re-binding handles. Defaults to `null` (anonymous / signed out). **Independent of `withAuth({uid})`** — `withAuth` still produces a frozen [SandboxContext](#sandboxcontext) that carries its own identity for the runner's test code (the existing pattern: explicit identity per service call). `currentUser` exists for the `pyric/auth` mirror, where consumer app code drives identity through a stateful `Auth` handle rather than naming it per call. |
| `currentUser.token?` | `public` | `Record`\<`string`, `unknown`\> | - |
| `currentUser.uid` | `public` | `string` | - |

#### Methods

<a id="clearpersistence-4"></a>

##### clearPersistence()

```ts
clearPersistence(): Promise<void>;
```

Wipe the persisted blob for this sandbox's `key`. In-memory state
is left intact — call `reset()` if you want both. Useful for
"sign out and forget" flows.

No-op when persistence is not enabled.

###### Returns

`Promise`\<`void`\>

<a id="dispose-6"></a>

##### dispose()

```ts
dispose(): void;
```

Tear down listener registries on this sandbox's environment without
replacing it. Use this when you're about to discard the sandbox
itself (e.g. `runner.reseed()` builds a fresh sandbox rather than
calling `reset()`) and want to drop callback references on the
outgoing instance defensively. Idempotent. Does not touch data.

###### Returns

`void`

<a id="enablepersistence-4"></a>

##### enablePersistence()

```ts
enablePersistence(options: SandboxPersistenceOptions): Promise<void>;
```

Persist the sandbox's data to a backend and restore it on next
`enablePersistence` call. The default `'indexedDB'` backend turns
the sandbox into the host page's local Firestore — writes flush
automatically and a fresh `initializeSandbox()` rehydrates from
the prior session.

Restoration happens before the promise resolves; awaiting this
call is sufficient to guarantee in-memory state matches the
persisted blob.

Idempotent across the same `key` — calling twice in one process
is a no-op on the second call. Different keys are rejected as an
error (a sandbox can persist to at most one backend at a time).

Listener semantics: every write event the sandbox emits triggers
a debounced flush (default 250ms). Browser hosts additionally
flush on `beforeunload` so a page navigation doesn't lose the
tail of the debounce window.

See [SandboxPersistenceOptions](#sandboxpersistenceoptions) for backend selection and
tuning.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options` | [`SandboxPersistenceOptions`](#sandboxpersistenceoptions) |

###### Returns

`Promise`\<`void`\>

<a id="enabletabsync-4"></a>

##### enableTabSync()

```ts
enableTabSync(options?: TabSyncOptions): () => void;
```

Enable cross-tab realtime sync via `BroadcastChannel`. A write in
this tab will propagate to every OTHER tab of the same origin that
also called `enableTabSync`, causing their `onSnapshot` listeners to
re-evaluate — restoring production's cross-client realtime behavior.

**Opt-in, OFF by default.** Firestore only (RTDB is a follow-on).

Returns a disable function. Calling it removes the `onEvent`
subscription, the channel message listener, and closes the channel
(when it was created internally). After disable, no further propagation
occurs in either direction.

**Multi-writer note:** concurrent writes from two tabs to the same doc
produce last-write-wins divergence — there is no conflict resolution.
The intended model is one active writer (one user, one tab) with
observers in other tabs; this covers the overwhelming majority of
local development scenarios.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`TabSyncOptions`](#tabsyncoptions) |

###### Returns

```ts
(): void;
```

###### Returns

`void`

###### See

[TabSyncOptions](#tabsyncoptions) for channel injection (tests) and originId.

###### Example

```ts
// In every tab that should participate in realtime:
const sandbox = initializeSandbox();
const disableSync = sandbox.enableTabSync();
// Later, to stop syncing:
disableSync();
```

<a id="flush-6"></a>

##### flush()

```ts
flush(): Promise<void>;
```

Force a snapshot to the configured persistence backend right now.
Useful before a manual navigation, or in tests that need
deterministic ordering against the debounce window. Resolves once
the write hits the backend.

Throws if persistence is not enabled.

###### Returns

`Promise`\<`void`\>

<a id="history-4"></a>

##### history()

```ts
history(): SandboxEvent[];
```

Every [SandboxEvent](#sandboxevent) this sandbox has emitted since init or
the last `reset()`. Returns a defensive copy.

Use this for replay: hand the array to `replay(events, rules)`
from `pyric/sandbox` and the engine re-issues every
captured write against a fresh sandbox.

Unlike [onEvent](#onevent-4) (live stream from the moment of subscribe),
`history()` returns *every* event the sandbox has seen — useful
for consumers that attach late (e.g., loading a saved session
before subscribing) or that need a snapshot at a particular moment.

`reset()` and `dispose()` each append a closing `session_boundary`
event; `reset()` then clears the history. Consumers that took a
snapshot *before* reset retain the boundary in their copy.

###### Returns

[`SandboxEvent`](#sandboxevent)[]

<a id="loadsnapshot-4"></a>

##### loadSnapshot()

```ts
loadSnapshot(data: SandboxSnapshot): void;
```

CLOBBER-restore the sandbox's entire state from a prior [snapshot](#snapshot-6):
`reset()` (clears firestore + the signed-in session), then rebuild firestore
from `data` and restore each registered service. This is a TOTAL replace —
documents absent from `data` do NOT survive — and is the counterpart to
[snapshot](#snapshot-6). It is what makes "transfer (clobber) one instance's data
into another" and named-branch switching possible.

Fires a `session_boundary` (reset phase), re-evaluates live listeners against
the loaded state, and the next persistence flush writes the loaded state.
Services present in `data` but not currently registered are skipped (a
snapshot taken via [snapshot](#snapshot-6) always includes every registered
service, so this only affects cross-instance imports from a sandbox that had
a service this one lacks).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `data` | [`SandboxSnapshot`](#sandboxsnapshot-2) |

###### Returns

`void`

<a id="oncurrentuserchanged-4"></a>

##### onCurrentUserChanged()

```ts
onCurrentUserChanged(cb: (user: {
  token?: Record<string, unknown>;
  uid: string;
}) => void): () => void;
```

Subscribe to `currentUser` changes. Fires on every mutation —
sign-in, sign-out, user swap. Does NOT fire on subscribe.

Survives `reset()` and `dispose()` only as a no-op: a disposed
sandbox emits nothing further; a reset sandbox clears
`currentUser` to `null` (and fires the change) before swapping
the env.

Returns an unsubscribe function. Listener errors are swallowed —
subscribers are observational, the sandbox does not propagate
their errors.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `cb` | (`user`: \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \}) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

<a id="onevent-4"></a>

##### onEvent()

```ts
onEvent(cb: (event: SandboxEvent) => void): () => void;
```

Subscribe to every event the sandbox emits — see [SandboxEvent](#sandboxevent)
for the discriminated-union shape. One subscription covers
request/denial/snapshot-error/listener-lifecycle/session-boundary;
filter on `event.kind` to recover individual streams.

Replaces the prior three-channel surface (`onRequest` / `onDenial`
/ `onSnapshotError`) — see issue #307. Filter cookbook:
  - All denials:    `event.kind === 'request' && event.result === 'deny'`
  - Stream errors:  `event.kind === 'listener_errored'`
  - Per-op traffic: `event.kind === 'request'`

Survives `sandbox.reset()` — the subscription is held on the
sandbox, not on the underlying environment. A `session_boundary`
event with `phase: 'reset'` fires before the env swap so consumers
can segment their stream.

Returns an unsubscribe function. Listener errors are swallowed so a
faulty subscriber can't change rule semantics or hide other events.
Both synchronous throws and rejected Promises from async callbacks
are silently discarded — subscribers are **observational**, the
sandbox doesn't await them and doesn't propagate their errors.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `cb` | (`event`: [`SandboxEvent`](#sandboxevent)) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

<a id="registerpersistableservice-4"></a>

##### registerPersistableService()

```ts
registerPersistableService(name: string, hooks: PersistableService): () => void;
```

Register a service (auth, storage, …) as a persistence participant.
The sandbox calls `hooks.snapshot()` on every flush and
`hooks.restore(data)` on restore. If `hooks.subscribe` is provided,
the persistence controller subscribes and schedules a debounced
flush on each change — so auth-user edits flush promptly, not only
on the next Firestore write.

Returns an unregister function — call it if the service is torn
down before the sandbox is disposed (uncommon in practice; the
sandbox's `dispose()` clears the registry anyway).

Throws `failed-precondition` when a service with the same `name` is
already registered — the auth package registers `'auth'` once when
`getAuth(sandbox)` first creates a backend, so accidental double-
registration is a caller bug, not a no-op.

**Advanced / internal API.** Service packages (auth, storage) call
this when they first attach to a sandbox. Consumer app code should
not need to call this directly.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `name` | `string` |
| `hooks` | [`PersistableService`](#persistableservice) |

###### Returns

```ts
(): void;
```

###### Returns

`void`

<a id="reset-4"></a>

##### reset()

```ts
reset(): void;
```

Reset the underlying environment to a fresh state — wipes data,
rules, and any service-specific configuration.

Snapshot listeners attached to the OLD environment are dropped at
the swap — they can't survive because their target docs have been
wiped. `onEvent` subscribers DO survive — the registry lives on
the sandbox, and a `session_boundary` event with `phase: 'reset'`
fires before the swap so subscribers know the rollover happened.
Existing [SandboxContext](#sandboxcontext)s continue to work — their sandbox
reference is stable; subsequent operations resolve to the new env.

###### Returns

`void`

<a id="runwithprovenance-4"></a>

##### runWithProvenance()?

```ts
optional runWithProvenance<T>(provenance: EventProvenance, fn: () => T): T;
```

Run `fn` with ambient [EventProvenance](#eventprovenance) defaults: every event
emitted SYNCHRONOUSLY during `fn` that doesn't already carry a
provenance field (on the event itself or via an explicit per-emit
override) is stamped with these values instead of the global
defaults. This is the mechanical "who issued this op" seam the
serve worker uses to tag Studio-issued ops (`actor: { kind:
'studio' }`) and to stamp the auth lens an op ran under
(`authLens`) — declared by the caller that issues the op, never
inferred from the op's shape.

SYNCHRONOUS WINDOW: the ambient values apply only until `fn`
returns (for an async `fn`, its synchronous prefix — which covers
the local environment's rules eval + event emission, since those
run before the op's promise is handed back). Work an op DEFERS
(snapshot-listener deliveries and re-evals drain on a microtask,
off-stack) is intentionally OUTSIDE the window: a listener re-eval
belongs to the listener's owner, not to whoever's write triggered
it. Nested calls stack — the innermost window wins per field, and
each window restores the previous one on exit (including on throw).

OPTIONAL because remote sandbox proxies can't provide an ambient
emit window (events are emitted in the worker they front). Callers
spell `sandbox.runWithProvenance?.(prov, fn) ?? fn()`.

###### Type Parameters

| Type Parameter |
| :------ |
| `T` |

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `provenance` | [`EventProvenance`](#eventprovenance) |
| `fn` | () => `T` |

###### Returns

`T`

<a id="snapshot-6"></a>

##### snapshot()

```ts
snapshot(): SandboxSnapshot;
```

Capture a snapshot of every service's state. For v1 with only
Firestore, the return value carries a `firestore` key mapping doc
paths to data. Future services will add their own keys.

###### Returns

[`SandboxSnapshot`](#sandboxsnapshot-2)

<a id="withauth-6"></a>

##### withAuth()

```ts
withAuth(auth: {
  token?: Record<string, unknown>;
  uid: string;
}): SandboxContext;
```

Derive a context bound to this sandbox under the given auth
identity. Operations through services attached to the returned
context evaluate rules under that identity. Many contexts can
coexist for one sandbox; data is shared.

`null` is anonymous; an `AuthState` object names the user (and
optional custom claims). Passing `undefined` is a deliberate
error — say `withAuth(null)` for anonymous so the call site is
unambiguous.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `Record`\<`string`, `unknown`\> |
| `auth.uid` | `string` |

###### Returns

[`SandboxContext`](#sandboxcontext)

###### Example

```ts
const sandbox = initializeSandbox();
const dbAlice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const dbAnon  = getFirestore(sandbox.withAuth(null));
```

***

<a id="sandboxcommitevent"></a>

### SandboxCommitEvent

Canonical committed mutation event. Unlike `operation`, this fires only when
state actually changed. Replay and branch tooling should eventually consume
these service adapters instead of filtering Firestore-only `write` events.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="at-3"></a> `at` | `number` |
| <a id="auth-6"></a> `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `Record`\<`string`, `unknown`\> |
| `auth.uid` | `string` |
| <a id="data"></a> `data?` | `unknown` |
| <a id="detail-1"></a> `detail?` | `Record`\<`string`, `unknown`\> |
| <a id="groupid-1"></a> `groupId?` | `string` |
| <a id="groupkind-1"></a> `groupKind?` | `"transaction"` \| `"batch"` |
| <a id="id-3"></a> `id` | `string` |
| <a id="kind-2"></a> `kind` | `"commit"` |
| <a id="method-2"></a> `method` | `string` |
| <a id="nextstate"></a> `nextState?` | `unknown` |
| <a id="path-2"></a> `path?` | `string` |
| <a id="priorstate"></a> `priorState?` | `unknown` |
| <a id="replay"></a> `replay?` | \{ `autoId?`: `string`; `requestTime?`: `number`; `sentinels?`: \{ `field`: `string`; `kind`: `string`; \}[]; \} |
| `replay.autoId?` | `string` |
| `replay.requestTime?` | `number` |
| `replay.sentinels?` | \{ `field`: `string`; `kind`: `string`; \}[] |
| <a id="service-2"></a> `service` | [`EventService`](#eventservice) |

***

<a id="sandboxconfig"></a>

### SandboxConfig

Initialization config for a sandbox. All fields are optional; an
empty config produces a sandbox with no rules and no seeded data.

**No `auth` field.** Identity belongs to [SandboxContext](#sandboxcontext), not
the sandbox. Service handles always require an explicit context.

***

<a id="sandboxcontext"></a>

### SandboxContext

Identity-bearing handle on a [Sandbox](#sandbox-3). A
`(sandbox, auth, operationContext)`
tuple — cheap to create, immutable, freely shareable. Service
factories require a `SandboxContext`; bare `Sandbox` is a type
error so every call site states identity explicitly.

Constructed via `Sandbox.withAuth(auth)` or chained via
`SandboxContext.withAuth(auth)`. The concrete class is exported
from `pyric/sandbox` for `instanceof` routing in service
factories; consumers don't construct it directly.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="auth-7"></a> `auth` | `readonly` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | The identity rules evaluate under for operations through this context. |
| `auth.token?` | `public` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `public` | `string` | - |
| <a id="operationcontext-3"></a> `operationContext` | `readonly` | [`OperationContext`](#operationcontext-2) | Immutable provenance bound to every operation issued through this handle. |
| <a id="sandbox-4"></a> `sandbox` | `readonly` | [`Sandbox`](#sandbox-3) | The data foundation this context operates against. |

#### Methods

<a id="withauth-8"></a>

##### withAuth()

```ts
withAuth(auth: {
  token?: Record<string, unknown>;
  uid: string;
}): SandboxContext;
```

Derive a sibling context on the same sandbox with different auth.
Replaces auth and its lens while preserving the operation source and
optional plan identity.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `Record`\<`string`, `unknown`\> |
| `auth.uid` | `string` |

###### Returns

[`SandboxContext`](#sandboxcontext)

***

<a id="sandboxlistenerevent"></a>

### SandboxListenerEvent

Canonical listener lifecycle/delivery event. Firestore's existing snapshot
delivery/lifecycle variants are preserved; this shape gives RTDB and future
service listeners the same debuggable surface.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="at-4"></a> `at` | `number` |
| <a id="auth-8"></a> `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `Record`\<`string`, `unknown`\> |
| `auth.uid` | `string` |
| <a id="detail-2"></a> `detail?` | `Record`\<`string`, `unknown`\> |
| <a id="error-1"></a> `error?` | \{ `code?`: `string`; `message`: `string`; `reasons?`: `string`[]; \} |
| `error.code?` | `string` |
| `error.message` | `string` |
| `error.reasons?` | `string`[] |
| <a id="id-4"></a> `id` | `string` |
| <a id="kind-3"></a> `kind` | `"listener"` |
| <a id="listenerid-1"></a> `listenerId` | `string` |
| <a id="phase"></a> `phase` | `"attach"` \| `"detach"` \| `"delivery"` \| `"suppressed"` \| `"errored"` |
| <a id="reason"></a> `reason?` | `string` |
| <a id="result-2"></a> `result?` | `"allow"` \| `"deny"` \| `"unsupported"` \| `"error"` |
| <a id="sample"></a> `sample?` | `unknown` |
| <a id="service-3"></a> `service` | [`EventService`](#eventservice) |
| <a id="size"></a> `size?` | `number` |
| <a id="target-1"></a> `target` | \{ `kind`: `string`; `path?`: `string`; `query?`: `unknown`; \} |
| `target.kind` | `string` |
| `target.path?` | `string` |
| `target.query?` | `unknown` |
| <a id="triggeredby-1"></a> `triggeredBy?` | \{ `method`: `string`; `path?`: `string`; \} |
| `triggeredBy.method` | `string` |
| `triggeredBy.path?` | `string` |

***

<a id="sandboxoperationevent"></a>

### SandboxOperationEvent

Canonical service operation event. This is the service-neutral successor to
Firestore's `request` traffic shape: every user-visible operation can be
represented here, whether it is backed by security rules (Firestore/RTDB/
Storage) or by a service control plane (Auth).

Existing Firestore `request` events remain for compatibility. New cross-
service consumers should prefer `operation` because it carries an explicit
`service` discriminator and does not require RTDB/Storage/Auth to pretend
their state is a Firestore document.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="at-5"></a> `at` | `number` | - |
| <a id="auth-9"></a> `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | - |
| `auth.token?` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="detail-3"></a> `detail?` | `Record`\<`string`, `unknown`\> | - |
| <a id="durationms"></a> `durationMs?` | `number` | - |
| <a id="groupid-2"></a> `groupId?` | `string` | - |
| <a id="groupkind-2"></a> `groupKind?` | `"transaction"` \| `"batch"` | - |
| <a id="id-5"></a> `id` | `string` | - |
| <a id="kind-4"></a> `kind` | `"operation"` | - |
| <a id="method-3"></a> `method` | `string` | - |
| <a id="origin-1"></a> `origin` | `"admin"` \| `"user"` \| `"listener"` \| `"transaction"` \| `"batch"` \| `"system"` | - |
| <a id="path-3"></a> `path?` | `string` | - |
| <a id="reasons-3"></a> `reasons?` | `string`[] | - |
| <a id="request-3"></a> `request?` | \{ `data?`: `unknown`; `query?`: `unknown`; `resourceData?`: `unknown`; \} | - |
| `request.data?` | `unknown` | - |
| `request.query?` | `unknown` | - |
| `request.resourceData?` | `unknown` | - |
| <a id="resourceafter-1"></a> `resourceAfter?` | \{ `data`: `unknown`; `exists`: `boolean`; \} | - |
| `resourceAfter.data` | `unknown` | - |
| `resourceAfter.exists` | `boolean` | - |
| <a id="resourcebefore-1"></a> `resourceBefore?` | \{ `data`: `unknown`; `exists`: `boolean`; \} | - |
| `resourceBefore.data` | `unknown` | - |
| `resourceBefore.exists` | `boolean` | - |
| <a id="result-3"></a> `result` | `"allow"` \| `"deny"` \| `"unsupported"` \| `"error"` \| `"not-applicable"` | - |
| <a id="rules-2"></a> `rules?` | \{ `engine`: `"firestore"` \| `"storage"` \| `"rtdb"`; `errorCode?`: `string`; `matchedPath?`: `string`; `matchedRule?`: `string`; `operations?`: `string`[]; `pathVariableBindings?`: `Record`\<`string`, `string`\>; `reason?`: `string`; `ruleIndex?`: `number`; \} | - |
| `rules.engine` | `"firestore"` \| `"storage"` \| `"rtdb"` | - |
| `rules.errorCode?` | `string` | - |
| `rules.matchedPath?` | `string` | - |
| `rules.matchedRule?` | `string` | - |
| `rules.operations?` | `string`[] | - |
| `rules.pathVariableBindings?` | `Record`\<`string`, `string`\> | - |
| `rules.reason?` | `string` | - |
| `rules.ruleIndex?` | `number` | - |
| <a id="rulesdisposition-1"></a> `rulesDisposition?` | [`RulesDisposition`](#rulesdisposition-2) | Canonical statement of whether Security Rules evaluated this operation. Service emitters may provide it directly; the recorder normalizes legacy operation shapes at the unified stream seam. |
| <a id="service-4"></a> `service` | [`EventService`](#eventservice) | - |
| <a id="triggeredby-2"></a> `triggeredBy?` | \{ `method`: `string`; `path?`: `string`; \} | - |
| `triggeredBy.method` | `string` | - |
| `triggeredBy.path?` | `string` | - |

***

<a id="sandboxpersistenceoptions"></a>

### SandboxPersistenceOptions

Controller options. See [Sandbox.enablePersistence](#enablepersistence-4).

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="backend"></a> `backend?` | `"indexedDB"` \| `"memory"` | Storage backend. `indexedDB` requires a browser environment; in non-browser hosts (Bun, Node, tests) the controller falls back to `memory` automatically unless an `injectedBackend` is supplied. Default: `indexedDB`. |
| <a id="flushintervalms"></a> `flushIntervalMs?` | `number` | Debounce window before write events are flushed to the backend. Buffers rapid bursts (e.g., a batch of seed writes) into one flush. Default: 250ms. |
| <a id="injectedbackend"></a> `injectedBackend?` | [`PersistenceBackend`](#persistencebackend) | Override the backend with an injected implementation. Used by tests and hosts that have their own storage adapter. When set, `backend` is ignored. |
| <a id="key"></a> `key` | `string` | IndexedDB database name (or generic bucket key for other backends). Different keys persist to different storage locations — use one key per logical sandbox if you run several in parallel. |
| <a id="sessionstorage"></a> `sessionStorage?` | \{ `local`: [`WebStorageLike`](#webstoragelike); `session`: [`WebStorageLike`](#webstoragelike); \} | Optional web-storage pair for current-session persistence. When provided, the controller reads and writes the signed-in uid here (honoring the auth `setPersistence` mode) so page reloads restore the signed-in user — exactly like `browserLocalPersistence` in prod Firebase. When omitted, the user DATABASE still persists (Phase 1), but the CURRENT SESSION is not restored on reload. This is the honest no-fake-durability choice for environments where web storage isn't available (Bun tests, Node servers, etc.). `local` maps to `localStorage` semantics (survives reload + restart); `session` maps to `sessionStorage` semantics (survives reload, cleared on tab close). The controller picks which store to write based on the auth `setPersistence` mode recorded on the backend: LOCAL → local (default; matches Firebase's default) SESSION → session NONE → neither (uid is not stored) Both storages are read on restore (mode-agnostic — a prior session may have used a different mode). Exactly one store holds the uid at any time; a mode change migrates the uid to the new store. |
| `sessionStorage.local` | [`WebStorageLike`](#webstoragelike) | - |
| `sessionStorage.session` | [`WebStorageLike`](#webstoragelike) | - |

***

<a id="sandboxruntimeerrorevent"></a>

### SandboxRuntimeErrorEvent

Canonical non-rules operational failure.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="at-6"></a> `at` | `number` |
| <a id="auth-10"></a> `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `Record`\<`string`, `unknown`\> |
| `auth.uid` | `string` |
| <a id="detail-4"></a> `detail?` | `Record`\<`string`, `unknown`\> |
| <a id="error-2"></a> `error` | \{ `code?`: `string`; `message`: `string`; \} |
| `error.code?` | `string` |
| `error.message` | `string` |
| <a id="id-6"></a> `id` | `string` |
| <a id="kind-5"></a> `kind` | `"runtime_error"` |
| <a id="method-4"></a> `method` | `string` |
| <a id="path-4"></a> `path?` | `string` |
| <a id="service-5"></a> `service` | [`EventService`](#eventservice) |

***

<a id="sandboxsnapshot-2"></a>

### SandboxSnapshot

Sandbox-level snapshot — a coarse capture of every service's state
keyed by service name. The `firestore` key is always present; the
`services` map holds one entry per registered persistable service
(auth users, future storage objects, etc.). Service-specific
snapshot types live in their service modules; `/app` keeps the index
structural so it stays decoupled from service implementations.

v2 shape — `services` was added when the persistable-service registry
landed. Prior `{ firestore }` v1 blobs are treated as having an empty
`services` map on restore.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="firestore"></a> `firestore` | `Record`\<`string`, `Record`\<`string`, `unknown`\>\> | Firestore documents, keyed by full path. Always present — empty `{}` for a fresh or just-reset sandbox. Per-document values are the post-resolution state the keyspace stored. |
| <a id="services"></a> `services` | `Record`\<`string`, `unknown`\> | Per-service opaque state, keyed by service name (e.g. `'auth'`). Each entry is whatever the service's `PersistableService.snapshot()` returned. May be `{}` when no services are registered. |

***

<a id="servicemutationevent"></a>

### ServiceMutationEvent

Cross-service mutation event — the unified envelope the NON-Firestore
services (`auth` / `storage` / `rtdb`) emit into the single
`onEvent`/`history()` stream (Pyric Studio keystone, track T1).

**Why a new variant rather than reusing `request`/`write`.** Firestore's
existing kinds are tightly coupled to the rules-simulator: `RequestEvent`
carries `result: 'allow'|'deny'`, `evalMs`, the simulator's `reasons[]`,
and `matchedRule`; `WriteSandboxEvent` carries Firestore-specific
`sentinels`, `autoId`, and a Firestore `requestTime` Timestamp. Auth user-
DB mutations (no path, no rule eval), Storage object puts, and RTDB tree
writes don't have those concepts, and bending them into the Firestore
shapes would either lie (synthesize a fake `result`/`requestTime`) or
pollute the Firestore consumer contract. So this is ONE small, additive
variant the three services share — Firestore consumers filter on their
existing `kind`s and never see it. See the design rationale.

It is intentionally generic: `op` is a free-ish string discriminated by
`service`, and `before`/`after` are best-effort serializable snapshots
(omitted when not meaningful — e.g. a sign-out has no `after`). Studio's
data grids / Action Center render `service` + `op` + `path` directly and
diff `before`→`after` when both are present.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="after"></a> `after?` | `unknown` | Best-effort serializable snapshot of the state AFTER the mutation. Absent on deletes / sign-outs (nothing remains). |
| <a id="at-7"></a> `at` | `number` | - |
| <a id="auth-11"></a> `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | Identity in effect when the op ran (the service's `request.auth` equivalent). `null` for admin/anonymous-driven mutations (e.g. `sandbox.createUser`, an unauthenticated RTDB write). |
| `auth.token?` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="before"></a> `before?` | `unknown` | Best-effort serializable snapshot of the state BEFORE the mutation. Absent when there was no prior state (a create) or it isn't cheap to capture. |
| <a id="detail-5"></a> `detail?` | `Record`\<`string`, `unknown`\> | Free-form, service-specific extras a consumer may surface without re-deriving (e.g. storage `{ size, contentType }`, rtdb `{ committed }` for a transaction). Kept loose on purpose — it's a display hint, not a contract. |
| <a id="id-7"></a> `id` | `string` | - |
| <a id="kind-6"></a> `kind` | `"service_mutation"` | - |
| <a id="op-2"></a> `op` | `string` | Service-scoped operation name. Stable, lowercase, snake/kebab-free: - auth: `user_create` | `user_update` | `user_delete` | `users_clear` | `sign_in` | `sign_out` - storage: `object_put` | `object_delete` | `metadata_update` - rtdb: `set` | `update` | `remove` | `transaction` - ai: `generate_content` | `stream_generate_content` | `count_tokens` | `request_rejected` New ops can be added without a breaking change (consumers switch with a default branch). |
| <a id="path-5"></a> `path?` | `string` | The thing mutated, in the service's own addressing scheme: - auth: the user `uid` (or `'*'` for a clear-all). Absent for a sign-out with no prior user. - storage: the object `fullPath` (e.g. `avatars/alice.png`). - rtdb: the database path (e.g. `/rooms/r1/messages`), or for a multi-path `update` the ref path the call targeted. |
| <a id="service-6"></a> `service` | `"auth"` \| `"storage"` \| `"rtdb"` \| `"messaging"` \| `"ai"` | Which service performed the mutation. Always one of the non-Firestore services — Firestore rides its own `request`/`write` path. (The provenance `service` field on the stamped event mirrors this; it is set redundantly here so a consumer matching purely on `kind` still gets the discriminator without reaching into provenance.) |

***

<a id="sessionboundaryevent"></a>

### SessionBoundaryEvent

Session boundary — emitted before `sandbox.reset()` swaps the env,
and before `sandbox.dispose()` tears it down. Lets consumers segment
a persisted event stream into "session N pre-reset" / "session N+1
post-reset" runs.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="at-8"></a> `at` | `number` | - |
| <a id="id-8"></a> `id` | `string` | - |
| <a id="kind-7"></a> `kind` | `"session_boundary"` | - |
| <a id="phase-1"></a> `phase` | `"reset"` \| `"dispose"` | - |
| <a id="prioropcount"></a> `priorOpCount` | `number` | Total events emitted on this sandbox before the boundary. |

***

<a id="snapshotdeliveryevent"></a>

### SnapshotDeliveryEvent

Snapshot delivered to a `onSnapshot` listener's user callback.

Fires AFTER the no-op suppression check — every `snapshot_delivery`
event corresponds to an actual user-callback invocation. Listener
re-evals that resolved to no-ops emit [SnapshotSuppressedEvent](#snapshotsuppressedevent)
instead.

`sample` carries best-effort serializable views of the docs the
callback received; consumers truncate before persisting if the
scenario produces large snapshots.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="addedcount"></a> `addedCount` | `number` | - |
| <a id="at-9"></a> `at` | `number` | - |
| <a id="auth-12"></a> `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | - |
| `auth.token?` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="id-9"></a> `id` | `string` | - |
| <a id="kind-8"></a> `kind` | `"snapshot_delivery"` | - |
| <a id="listenerid-2"></a> `listenerId` | `string` | Opaque listener id assigned at attach time. |
| <a id="modifiedcount"></a> `modifiedCount` | `number` | - |
| <a id="removedcount"></a> `removedCount` | `number` | - |
| <a id="sample-1"></a> `sample?` | \{ `docs`: \{ `data`: `Record`\<`string`, `unknown`\>; `path`: `string`; \}[]; \} | Doc payloads, in the order the user callback saw them. |
| `sample.docs` | \{ `data`: `Record`\<`string`, `unknown`\>; `path`: `string`; \}[] | - |
| <a id="size-1"></a> `size` | `number` | `1` for doc-kind (exists) / `0` (deleted), `n` for query-kind. |
| <a id="target-2"></a> `target` | \| \{ `kind`: `"doc"`; `path`: `string`; \} \| \{ `collection`: `string`; `kind`: `"query"`; \} | - |
| <a id="triggeredby-3"></a> `triggeredBy?` | \{ `method`: `string`; `path`: `string`; \} | The user op that triggered this re-eval. Absent on initial fire and on `deployRules`-driven re-evals. |
| `triggeredBy.method` | `string` | - |
| `triggeredBy.path` | `string` | - |

***

<a id="snapshoterrorevent"></a>

### SnapshotErrorEvent

Eval-time payload emitted to Sandbox.onSnapshotError subscribers.

Stream-level error from a Firestore `onSnapshot` listener — the
listener has been silently terminated and will deliver no further
snapshots (matches production: a stream error is once-per-stream and
the listener stays "subscribed" from the consumer's perspective but
receives nothing further). Carries the `target` so the host UI can
attribute the error to a specific watch.

Currently `permission-denied` is the only code the sandbox produces
(production also emits `unavailable`, `aborted`, `resource-exhausted`
— none of which have a sandbox analog: no network stream to drop, no
quota, no concurrent transactions to conflict). Documented divergence
from production; new codes can be added if a sandbox-specific
scenario surfaces them.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="auth-13"></a> `auth?` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} |
| `auth.token?` | `Record`\<`string`, `unknown`\> |
| `auth.uid` | `string` |
| <a id="code-2"></a> `code` | `"permission-denied"` |
| <a id="message-1"></a> `message` | `string` |
| <a id="reasons-4"></a> `reasons?` | `string`[] |
| <a id="request-4"></a> `request?` | \{ `method`: `"get"` \| `"list"` \| `"create"` \| `"update"` \| `"delete"`; `path`: `string`; `resourceData?`: `Record`\<`string`, `unknown`\>; \} |
| `request.method` | `"get"` \| `"list"` \| `"create"` \| `"update"` \| `"delete"` |
| `request.path` | `string` |
| `request.resourceData?` | `Record`\<`string`, `unknown`\> |
| <a id="resource-2"></a> `resource?` | \{ `data`: `Record`\<`string`, `unknown`\>; `exists`: `boolean`; \} |
| `resource.data` | `Record`\<`string`, `unknown`\> |
| `resource.exists` | `boolean` |
| <a id="target-3"></a> `target` | \| \{ `kind`: `"doc"`; `path`: `string`; \} \| \{ `collection`: `string`; `kind`: `"query"`; \} |

***

<a id="snapshotsuppressedevent"></a>

### SnapshotSuppressedEvent

Listener re-eval that was suppressed before delivery — the re-eval
ran but produced no observable change vs the prior snapshot, so the
user callback wasn't invoked.

Useful for "why didn't my listener fire" debugging. Default UIs
should filter these out; only the inspector-style consumer needs
them.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="at-10"></a> `at` | `number` | - |
| <a id="auth-14"></a> `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | - |
| `auth.token?` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="id-10"></a> `id` | `string` | - |
| <a id="kind-9"></a> `kind` | `"snapshot_suppressed"` | - |
| <a id="listenerid-3"></a> `listenerId` | `string` | - |
| <a id="reason-1"></a> `reason` | `"no-op"` | Why this re-eval was suppressed. v1 only emits `'no-op'`. |
| <a id="target-4"></a> `target` | \| \{ `kind`: `"doc"`; `path`: `string`; \} \| \{ `collection`: `string`; `kind`: `"query"`; \} | - |
| <a id="triggeredby-4"></a> `triggeredBy?` | \{ `method`: `string`; `path`: `string`; \} | - |
| `triggeredBy.method` | `string` | - |
| `triggeredBy.path` | `string` | - |

***

<a id="tabsyncoptions"></a>

### TabSyncOptions

Options for `sandbox.enableTabSync(options?)`. All fields are optional;
the defaults provide a ready-to-use configuration for browser environments.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="channel-1"></a> `channel?` | [`BroadcastChannelLike`](#broadcastchannellike) | The broadcast channel to use. Defaults to `new BroadcastChannel('pyric:tabsync')` when omitted and `BroadcastChannel` is available in the global scope. Pass a custom implementation for tests or Node environments. |
| <a id="originid"></a> `originId?` | `string` | A string that uniquely identifies this tab's sandbox instance. Used for echo suppression (messages with `origin === originId` are silently dropped) and for directing `state` replies to the requesting tab. Defaults to `crypto.randomUUID()` when available, otherwise a counter + process-uptime string (no `Date.now()` or `Math.random()` — those change every call and can collide in fast tests). |

***

<a id="webstoragelike"></a>

### WebStorageLike

Minimal web-storage-like contract the session persistence controller
reads/writes. Matches the `localStorage` / `sessionStorage` browser
API subset that `pyric dev`'s `SessionStore` already uses, so
browsers pass real storages and tests pass in-memory Map-backed fakes.

Why the minimal subset (get/set/remove) instead of the full
`Storage` interface: this library targets multiple environments
(browser, Bun, Node) and the full `Storage` interface carries
length + key() + clear() that aren't needed here — narrowing the
contract keeps tests simple and Node/Bun hosts from having to
implement a complete polyfill.

#### Methods

<a id="getitem"></a>

##### getItem()

```ts
getItem(key: string): string;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `key` | `string` |

###### Returns

`string`

<a id="removeitem"></a>

##### removeItem()

```ts
removeItem(key: string): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `key` | `string` |

###### Returns

`void`

<a id="setitem"></a>

##### setItem()

```ts
setItem(key: string, value: string): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `key` | `string` |
| `value` | `string` |

###### Returns

`void`

***

<a id="writesandboxevent"></a>

### WriteSandboxEvent

Committed write — a `create`/`update`/`set`/`delete` that the rule
engine allowed AND that the keyspace successfully applied. Includes
pre- and post-state so consumers can render diffs and (in a future
`sandbox.history()` API) reconstruct state by replay.

Fires AFTER the corresponding `kind: 'request'` event for the same
op. A denied or rolled-back write surfaces as a request-deny only;
`write` events only fire for committed writes.

`sentinels` and `autoId` are placeholders for the eventual replay
engine — v1 of the unified channel leaves them undefined. The shape
is locked so consumers can build against it without churn when
sentinel/auto-id capture lands.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="at-11"></a> `at` | `number` | - |
| <a id="auth-15"></a> `auth` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | - |
| `auth.token?` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="autoid"></a> `autoId?` | `string` | Minted document ID when this write came from `collection.add()` / `LocalEnvironment.createWithAutoId`. The replay engine aliases the path's last segment to a fresh mint on replay (rather than preserving the original auto-ID). |
| <a id="data-1"></a> `data?` | `Record`\<`string`, `unknown`\> | Pre-resolution write payload — `FieldValue.*` sentinels preserved as marker shapes (`{ __type: 'serverTimestamp' }`, etc.) so the replay engine can re-resolve them. The rule engine evaluated against the resolved form internally; the resolved form lives on [nextState](#nextstate-1). Absent on `delete`. |
| <a id="detail-6"></a> `detail?` | \{ `admin?`: `boolean`; \} & `Record`\<`string`, `unknown`\> | Free-form write metadata. `admin: true` marks a rules-bypassing setup/admin commit so replay can apply it as context without asking candidate rules to permit it. |
| <a id="groupid-3"></a> `groupId?` | `string` | - |
| <a id="groupkind-3"></a> `groupKind?` | `"transaction"` \| `"batch"` | - |
| <a id="id-11"></a> `id` | `string` | - |
| <a id="kind-10"></a> `kind` | `"write"` | - |
| <a id="method-5"></a> `method` | `"create"` \| `"update"` \| `"delete"` \| `"set"` | - |
| <a id="nextstate-1"></a> `nextState` | `Record`\<`string`, `unknown`\> | State AFTER this write. `null` on `delete`. |
| <a id="path-6"></a> `path` | `string` | - |
| <a id="priorstate-1"></a> `priorState` | `Record`\<`string`, `unknown`\> | State BEFORE this write. `null` for a non-existent doc. |
| <a id="requesttime"></a> `requestTime` | \{ `nanoseconds`: `number`; `seconds`: `number`; \} | Server time at which the rule engine evaluated this write — pinned per op (or shared across sub-ops in a batch / transaction). The replay engine re-issues this exact value when re-resolving `serverTimestamp()` sentinels so resolved fields are bit-identical on replay. Shape mirrors the Firestore Web SDK Timestamp (`{ seconds, nanoseconds }`). |
| `requestTime.nanoseconds` | `number` | - |
| `requestTime.seconds` | `number` | - |
| <a id="sentinels"></a> `sentinels?` | \{ `field`: `string`; `kind`: \| `"delete"` \| `"serverTimestamp"` \| `"increment"` \| `"arrayUnion"` \| `"arrayRemove"`; \}[] | FieldValue sentinels (serverTimestamp / increment / arrayUnion / arrayRemove / deleteField → 'delete') extracted from the pre-resolution write payload. The replay engine consumes this to re-issue the same sentinels at replay time without consulting resolved values that would have drifted. Path syntax: dotted with bracket-indices ('a.b[0].c'). Absent when the write contained no sentinels. |

## Type Aliases

<a id="authlens-2"></a>

### AuthLens

```ts
type AuthLens =
  | {
  mode: "admin";
}
  | {
  mode: "as";
  token?: Record<string, unknown>;
  uid: string;
}
  | {
  mode: "app-session";
}
  | {
  mode: "anon";
};
```

The identity/rules lens an operation actually ran under.

***

<a id="authstate"></a>

### AuthState

```ts
type AuthState =
  | {
  token?: Record<string, unknown>;
  uid: string;
}
  | null;
```

A signed-in identity for sandbox operations. `null` is anonymous.

`token` is the Firebase Auth token claims map (custom claims plus
standard ones). It surfaces the same way it does in production rules
via `request.auth.token.*`. Omit it for plain UID-only auth.

Renamed from `AuthContext` (pre-multi-context) so the data type
doesn't visually collide with `SandboxContext` (the identity-bearing
handle). They sit at different layers — payload vs. handle — and the
names should reflect that.

***

<a id="difftarget"></a>

### DiffTarget

```ts
type DiffTarget = LocalSandbox | SandboxSnapshot;
```

A reference to diff a branch against: a live sandbox or a bare snapshot.

***

<a id="divergence"></a>

### Divergence

```ts
type Divergence =
  | {
  after: unknown;
  before: unknown;
  field: string;
  kind: "sentinel-drift";
  path: string;
  sentinelKind:   | "serverTimestamp"
     | "increment"
     | "arrayUnion"
     | "arrayRemove"
     | "delete";
}
  | {
  kind: "autoid-alias";
  originalPath: string;
  replayedPath: string;
}
  | {
  after: unknown;
  before: unknown;
  field: string;
  kind: "time-drift";
  path: string;
}
  | {
  after: unknown;
  before: unknown;
  field?: string;
  kind: "real-divergence";
  path: string;
};
```

***

<a id="eventactor"></a>

### EventActor

```ts
type EventActor =
  | {
  kind: "app";
}
  | {
  kind: "studio";
}
  | {
  kind: "agent";
  name: string;
}
  | {
  kind: "app-builder";
}
  | {
  kind: "unattributed";
};
```

Who initiated the operation behind an event. Missing source is represented
explicitly as `unattributed`; it is never silently promoted to app traffic.

***

<a id="eventservice"></a>

### EventService

```ts
type EventService = "firestore" | "auth" | "storage" | "rtdb" | "messaging" | "ai";
```

Which sandbox service emitted an event.

***

<a id="remotesandboxfactory"></a>

### RemoteSandboxFactory()

```ts
type RemoteSandboxFactory = (opts?: RemoteSandboxFactoryOptions) => RemoteSandbox;
```

The factory `@pyric/cli/register` installs at
`globalThis[`[REMOTE\_SANDBOX\_FACTORY](#remote_sandbox_factory)`]`. SYNCHRONOUS by contract:
`initializeApp()` is sync in firebase-admin, so the factory must return
the branded handle without awaiting (connection establishment may be
lazy inside the handle's channel).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `opts?` | [`RemoteSandboxFactoryOptions`](#remotesandboxfactoryoptions) |

#### Returns

[`RemoteSandbox`](#remotesandbox)

***

<a id="rulesdisposition-2"></a>

### RulesDisposition

```ts
type RulesDisposition =
  | {
  kind: "evaluated";
  verdict: "allow" | "deny";
}
  | {
  kind: "bypassed";
  reason: "admin";
}
  | {
  kind: "not-evaluated";
  reason: "no-rules" | "unsupported" | "not-a-rules-operation" | "runtime-error";
};
```

What happened at the Security Rules seam. Admin is a lens; `bypassed` is
the rules disposition.

***

<a id="sandboxerrorcode-1"></a>

### SandboxErrorCode

```ts
type SandboxErrorCode =
  | "invalid-argument"
  | "permission-denied"
  | "not-found"
  | "already-exists"
  | "failed-precondition"
  | "aborted"
  | "unavailable"
  | "unimplemented"
  | "not-seeded"
  | "rules-not-loaded";
```

Error codes raised by the sandbox layer.

The first batch matches Firebase / gRPC conventions so existing
`if (e.code === 'permission-denied')` code from production paths
keeps working. The second batch is sandbox-specific and exists so
agents can distinguish "sandbox doesn't simulate this" from "your
code is wrong" without parsing message strings.

***

<a id="sandboxevent"></a>

### SandboxEvent

```ts
type SandboxEvent =
  | RequestEvent
  | WriteSandboxEvent
  | SnapshotDeliveryEvent
  | SnapshotSuppressedEvent
  | ListenerLifecycleEvent
  | SessionBoundaryEvent
  | ServiceMutationEvent
  | SandboxOperationEvent
  | SandboxCommitEvent
  | SandboxListenerEvent
  | SandboxRuntimeErrorEvent & EventProvenance;
```

Discriminated union of every event the sandbox emits to
[Sandbox.onEvent](#onevent-4) subscribers.

Issue #307 — replaces the prior three-channel surface
(`onRequest` / `onDenial` / `onSnapshotError`). Filter on `kind`
to recover the subset each old channel covered:
  - request:        `kind === 'request'`
  - denial:         `kind === 'request' && result === 'deny'`
  - snapshotError:  `kind === 'listener_errored'`

See the design rationale for the
field-by-field rationale.

## Variables

<a id="remote_sandbox-1"></a>

### REMOTE\_SANDBOX

```ts
const REMOTE_SANDBOX: unique symbol;
```

Brand stamped (value `true`) on every remote sandbox handle.
`Symbol.for` — registered globally so `pyric-admin`'s check matches the
stamp even if two copies of `pyric` end up in one process.

***

<a id="remote_sandbox_factory"></a>

### REMOTE\_SANDBOX\_FACTORY

```ts
const REMOTE_SANDBOX_FACTORY: unique symbol;
```

Well-known global key under which `@pyric/cli/register` installs the
remote-sandbox factory: `globalThis[REMOTE_SANDBOX_FACTORY]`.

This is the AMBIENT-INIT seam (adoption experience, layer 3): when
`pyric-admin/app`'s bare `initializeApp()` sees `PYRIC_SANDBOX=remote[:url]`
it reads this global and calls the installed [RemoteSandboxFactory](#remotesandboxfactory)
to obtain the branded handle — without importing `@pyric/cli` (which is
a devDependency of the app, not of `pyric-admin`). `Symbol.for` so the
installer and the reader agree even across duplicated copies of `pyric`.

## Functions

<a id="apply"></a>

### apply()

```ts
function apply(branch: Branch, events: readonly SandboxEvent[]): Branch;
```

Apply a stream of events to a branch by re-issuing their writes against
the branch's CURRENT state.

This is the same per-write re-issue logic `replay()` runs (filter to
`kind: 'write'`, honour `autoId` / pinned `requestTime`, prefer the
pre-resolution `request.resourceData` so sentinels re-resolve), but
applied *incrementally* on the branch's existing env rather than on a
fresh empty sandbox — so it composes over base docs (e.g. an `update`
lands on a doc the snapshot seeded) and accumulates across multiple
`apply` calls. The applied events are folded into `branch.events` so
[promote](#promote) can reproduce the same sequence on the target.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `branch` | [`Branch`](#branch) |
| `events` | readonly [`SandboxEvent`](#sandboxevent)[] |

#### Returns

[`Branch`](#branch)

the same branch (mutated in place) for chaining.

***

<a id="attachpersistence"></a>

### attachPersistence()

```ts
function attachPersistence(sandbox: Sandbox, rawOptions: SandboxPersistenceOptions): Promise<PersistenceController>;
```

Construct a controller, restore any prior snapshot, and wire the
auto-flush subscription. Returns once restore has completed (callers
can `await sandbox.enablePersistence(...)` and be sure the in-memory
state reflects the persisted blob).

Late service registration: services (e.g. auth) may register with the
sandbox AFTER this call returns (the user calls `enablePersistence`
then later `getAuth(sandbox)` which triggers `registerPersistableService`).
We handle this in two parts:
  1. `restore()` returns the raw `services` blob map so the controller
     can apply it to late-arriving services.
  2. `setServiceRegistrationHook` fires on each registration — we
     immediately apply the saved blob data (if any) AND subscribe the
     service's change notifier for future flushes.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | [`Sandbox`](#sandbox-3) |
| `rawOptions` | [`SandboxPersistenceOptions`](#sandboxpersistenceoptions) |

#### Returns

`Promise`\<[`PersistenceController`](#persistencecontroller)\>

***

<a id="attachtabsync"></a>

### attachTabSync()

```ts
function attachTabSync(sandbox: LocalSandbox, options?: TabSyncOptions): () => void;
```

Attach cross-tab sync to a sandbox. Called by `SandboxImpl.enableTabSync`;
kept in a separate module so `sandbox-impl.ts` stays thin.

Returns a `disable` function: calling it unsubscribes the onEvent listener,
removes the channel message listener, and closes the channel.

#### Parameters

| Parameter | Type | Description |
| :------ | :------ | :------ |
| `sandbox` | [`LocalSandbox`](#localsandbox) | The sandbox to sync. Must expose `onEvent`, `admin`, and `snapshot`. |
| `options?` | [`TabSyncOptions`](#tabsyncoptions) | Optional channel and origin override. |

#### Returns

```ts
(): void;
```

##### Returns

`void`

***

<a id="bundlerecords"></a>

### bundleRecords()

```ts
function bundleRecords(records: ReadonlyMap<string, unknown>): string;
```

Bundle v3 records into one committable JSON string, for single-blob stores
(serve's exportable `.pyric/state` file, an HTTP state endpoint). Inverse of
[parseBundle](#parsebundle). This deliberately collapses the chunking into one blob:
it is the single-artifact EXPORT shape, not the scale path (that is the
record-shaped backend).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `records` | `ReadonlyMap`\<`string`, `unknown`\> |

#### Returns

`string`

***

<a id="createindexeddbbackend"></a>

### createIndexedDBBackend()

```ts
function createIndexedDBBackend(): PersistenceBackend;
```

Build an IndexedDB-backed `PersistenceBackend`. Throws synchronously when
called outside a browser (no `indexedDB` global) so callers can detect the
absence and fall back to memory.

#### Returns

[`PersistenceBackend`](#persistencebackend)

***

<a id="creatememorybackend"></a>

### createMemoryBackend()

```ts
function createMemoryBackend(): PersistenceBackend;
```

#### Returns

[`PersistenceBackend`](#persistencebackend)

***

<a id="deserializefrombuckets"></a>

### deserializeFromBuckets()

```ts
function deserializeFromBuckets(records: Iterable<[string, unknown]>): {
  firestore: Record<string, Record<string, unknown>>;
  services: Record<string, unknown>;
};
```

Reassemble a firestore snapshot + services from v3 records (any iterable of
 [recordId, record] pairs). Rehydrates wrapper types from their markers.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `records` | `Iterable`\<\[`string`, `unknown`\]\> |

#### Returns

```ts
{
  firestore: Record<string, Record<string, unknown>>;
  services: Record<string, unknown>;
}
```

##### firestore

```ts
firestore: Record<string, Record<string, unknown>>;
```

##### services

```ts
services: Record<string, unknown>;
```

***

<a id="diff"></a>

### diff()

```ts
function diff(branch: Branch, target: DiffTarget): Divergence[];
```

Structural diff of a branch's current state against a reference.

Reuses the replay engine's `Divergence` result type and mirrors its
doc-level + field-level walk (see diffDocSets). With no captured
write metadata in play, differences surface as `real-divergence`
(field/doc changed) — the honest classification for "branch vs live".
Added/removed docs surface as presence divergences (one side
`undefined`).

#### Parameters

| Parameter | Type | Description |
| :------ | :------ | :------ |
| `branch` | [`Branch`](#branch) | The experiment. |
| `target` | [`DiffTarget`](#difftarget) | Live sandbox or a snapshot to compare against. |

#### Returns

[`Divergence`](#divergence)[]

***

<a id="discard"></a>

### discard()

```ts
function discard(branch: Branch): void;
```

Discard a branch: drop its sandbox and mark it spent. The target is
never touched (nothing was promoted). Idempotent.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `branch` | [`Branch`](#branch) |

#### Returns

`void`

***

<a id="fork"></a>

### fork()

```ts
function fork(snapshot: SandboxSnapshot, rules?: string): Branch;
```

Fork a new branch from a snapshot.

Seeds a fresh sandbox with `rules` and the snapshot's Firestore docs
(the same `seed({ rules, documents })` path replay uses to stand up a
clean environment). The branch is fully isolated: writes on it never
touch the source sandbox.

#### Parameters

| Parameter | Type | Description |
| :------ | :------ | :------ |
| `snapshot` | [`SandboxSnapshot`](#sandboxsnapshot-2) | Baseline state — typically `liveSandbox.snapshot()`. |
| `rules?` | `string` | Rules source for the branch. Pass the live rules to reproduce production behaviour, or an *edited* ruleset to test a rules change in isolation (Studio F4). |

#### Returns

[`Branch`](#branch)

***

<a id="initializesandbox"></a>

### initializeSandbox()

```ts
function initializeSandbox(_config?: SandboxConfig): LocalSandbox;
```

Create a sandbox.

Identity is **not** part of init — call `sandbox.withAuth(...)` to
derive a [SandboxContext](#sandboxcontext) for service operations. Service-
specific configuration (rules, seed data) happens through service-specific
sandbox controls — for example, `setRules(sandbox, source)` from
`pyric/sandbox/firestore`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `_config?` | [`SandboxConfig`](#sandboxconfig) |

#### Returns

[`LocalSandbox`](#localsandbox)

#### Example

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin/firestore';

const sandbox = initializeSandbox();
const dbAlice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const dbAnon  = getFirestore(sandbox.withAuth(null));
```

***

<a id="isoperationevent"></a>

### isOperationEvent()

```ts
function isOperationEvent(event: SandboxEvent): event is OperationEvent;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `event` | [`SandboxEvent`](#sandboxevent) |

#### Returns

`event is OperationEvent`

***

<a id="isremotesandbox"></a>

### isRemoteSandbox()

```ts
function isRemoteSandbox(sandbox: Sandbox): sandbox is RemoteSandbox;
```

Is this sandbox a remote handle? Backend dispatch guard for consumers
(e.g. `pyric-admin`'s RTDB/Auth sandbox backends) that must route a
remote sandbox's operations through [RemoteSandbox.channel](#channel) rather
than into process-local state.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | [`Sandbox`](#sandbox-3) |

#### Returns

`sandbox is RemoteSandbox`

***

<a id="operationcontextfor"></a>

### operationContextFor()

```ts
function operationContextFor(event: Pick<EventProvenance, "operationContext" | "actor" | "authLens" | "planId">): OperationContext;
```

The canonical context on a recorded event. Old/pre-context events are
explicitly unattributed rather than silently asserted to be app traffic.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `event` | `Pick`\<[`EventProvenance`](#eventprovenance), `"operationContext"` \| `"actor"` \| `"authLens"` \| `"planId"`\> |

#### Returns

[`OperationContext`](#operationcontext-2)

***

<a id="parsebundle"></a>

### parseBundle()

```ts
function parseBundle(blob: string): Map<string, unknown>;
```

Parse a v3 bundle blob back into records. Returns an empty map for an
unrecognized blob (e.g. a legacy v2 single-blob snapshot); migrate-on-open (a
later commit) handles converting a v2 blob to v3 records.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `blob` | `string` |

#### Returns

`Map`\<`string`, `unknown`\>

***

<a id="promote"></a>

### promote()

```ts
function promote(branch: Branch, target: LocalSandbox): void;
```

Promote a branch's mutations onto a target (live) sandbox.

"Honest promote": it computes the doc-level delta between the branch's
BASE snapshot and its current state — i.e. exactly what the applied
events changed — and lands only those mutations on the target through
the admin plane:
  - docs added/changed on the branch → `admin.setDocument`
  - docs deleted on the branch       → `admin.deleteDocument`
  - docs the branch never touched    → left untouched on the target

Admin-plane application fires the target's listeners (matching how
persistence restore lands docs), so live UI/handles see the promotion.

The branch is marked discarded afterward — a promoted branch is spent.

#### Parameters

| Parameter | Type | Description |
| :------ | :------ | :------ |
| `branch` | [`Branch`](#branch) | The experiment to land. |
| `target` | [`LocalSandbox`](#localsandbox) | The live sandbox to land it on. |

#### Returns

`void`

***

<a id="recordbackendoverblob"></a>

### recordBackendOverBlob()

```ts
function recordBackendOverBlob(io: {
  clear: Promise<void>;
  read: Promise<string>;
  write: Promise<void>;
}): PersistenceBackend;
```

A record-shaped backend over a single-blob store (read/write/clear ONE blob).
The whole record set is bundled into that blob, for serve's committable export
file / HTTP state endpoint and any single-key store. It loses chunking's scale
benefit by design (the blob IS the single artifact). The blob is loaded once and
cached, so a restore (list + per-record get) costs one read, not one per record.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `io` | \{ `clear`: `Promise`\<`void`\>; `read`: `Promise`\<`string`\>; `write`: `Promise`\<`void`\>; \} |
| `io.clear` |
| `io.read` |
| `io.write` |

#### Returns

[`PersistenceBackend`](#persistencebackend)

***

<a id="rehydratedocvalue"></a>

### rehydrateDocValue()

```ts
function rehydrateDocValue(value: unknown): unknown;
```

Walk a parsed JSON tree and re-wrap any marker shape back into its real
wrapper-class instance. Visits arrays and plain objects recursively. Plain
values (and plain objects without a recognized discriminator) pass through.

This is the canonical rehydrate used by BOTH the sandbox persistence
serializer and the SharedWorker wire protocol, so the IDB format and the
MessagePort wire format are guaranteed identical.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

`unknown`

***

<a id="replay-1"></a>

### replay()

```ts
function replay(
   events: readonly SandboxEvent[],
   rules: string,
   options?: ReplayOptions,
   originalState?: Record<string, DocData>): ReplayResult;
```

Replay a captured SandboxEvent stream on a fresh sandbox.

The `originalState` snapshot is optional — when provided, the engine
diffs the replayed sandbox's final state against it and returns
classified divergences. When omitted, divergences is `[]` (you still
get the replayed sandbox; you can inspect its state manually).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `events` | readonly [`SandboxEvent`](#sandboxevent)[] |
| `rules` | `string` |
| `options?` | [`ReplayOptions`](#replayoptions) |
| `originalState?` | `Record`\<`string`, `DocData`\> |

#### Returns

[`ReplayResult`](#replayresult)

***

<a id="rulesdispositionfor"></a>

### rulesDispositionFor()

```ts
function rulesDispositionFor(event: OperationEvent): RulesDisposition;
```

Normalize the legacy per-service markers exactly once, at the sandbox
stream seam. Consumers must not inspect `detail.admin`, `origin`, or the
presence of a trace themselves.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `event` | `OperationEvent` |

#### Returns

[`RulesDisposition`](#rulesdisposition-2)

***

<a id="serializetobuckets"></a>

### serializeToBuckets()

```ts
function serializeToBuckets(
   firestore: Record<string, Record<string, unknown>>,
   services: Record<string, unknown>,
savedAt: number): Map<string, BucketRecord | MetaRecord>;
```

Partition a firestore doc map into v3 records: one bucket record per occupied
bucket plus the `meta` record. The returned map's keys are record ids; values
are structured-clone-safe.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `firestore` | `Record`\<`string`, `Record`\<`string`, `unknown`\>\> |
| `services` | `Record`\<`string`, `unknown`\> |
| `savedAt` | `number` |

#### Returns

`Map`\<`string`, `BucketRecord` \| `MetaRecord`\>

***

<a id="tooperationrecord"></a>

### toOperationRecord()

```ts
function toOperationRecord(event: SandboxEvent): OperationRecord;
```

Project either traffic event family into the canonical record.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `event` | [`SandboxEvent`](#sandboxevent) |

#### Returns

[`OperationRecord`](#operationrecord)
