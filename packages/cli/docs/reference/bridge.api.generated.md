<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# @pyric/cli/bridge

## Interfaces

### Bridge

#### Properties

##### instanceId

> `readonly` **instanceId**: `string`

Stable per-process identity (see HealthReport.instanceId).

##### project

> `readonly` **project**: `string`

##### startedAt

> `readonly` **startedAt**: `string`

##### version

> `readonly` **version**: `string`

#### Methods

##### dispatch()

> **dispatch**(`name`, `args`): `Promise`\<`BridgeToolResult`\>

Dispatch a tool call to the connected sandbox peer.

###### Parameters

###### name

`string`

###### args

`Record`\<`string`, `unknown`\>

###### Returns

`Promise`\<`BridgeToolResult`\>

##### dispatchWorkerOp()

> **dispatchWorkerOp**(`op`): `Promise`\<`unknown`\>

Relay a generic worker op to the peer's SharedWorker. Resolves with the
worker's `res.value`; rejects with an Error carrying `.code` on worker
failure, timeout, no peer, or a peer without the worker relay.

###### Parameters

###### op

`WorkerOpPayload`

###### Returns

`Promise`\<`unknown`\>

##### handleSandboxMessage()

> **handleSandboxMessage**(`msg`, `generation?`): `void`

Handle a message from the sandbox peer (tool-result, pong, …).
`generation` is the peer generation the transport captured at
registration; when provided, `worker-res`/`worker-snap` frames from a
stale generation are dropped.

###### Parameters

###### msg

`BridgeMessage`

###### generation?

`number`

###### Returns

`void`

##### health()

> **health**(): [`HealthReport`](#healthreport)

/health endpoint payload.

###### Returns

[`HealthReport`](#healthreport)

##### isSandboxConnected()

> **isSandboxConnected**(): `boolean`

True if a sandbox peer is currently registered.

###### Returns

`boolean`

##### peerGeneration()

> **peerGeneration**(): `number`

Generation counter of the CURRENT peer registration (0 = no peer has
ever registered). The transport captures this right after registering
and tags every inbound message with it, so a frame arriving on a
REPLACED peer's socket (tab refresh mid-flight) can never resolve a new
peer's pending call or deliver a stale subscription snapshot.

###### Returns

`number`

##### recordToolEvent()

> **recordToolEvent**(`event`): `void`

Record a tool event in the bridge's audit pipeline. In-process sandbox
tools use this path; forwarded tools log inside dispatch().

###### Parameters

###### event

`BridgeToolEvent`

###### Returns

`void`

##### registerSandboxPeer()

> **registerSandboxPeer**(`send`, `tools`, `sandboxId`, `capabilities?`, `onReplaced?`): () => `void`

Register a browser-side peer. Returns a disconnect function the
caller MUST invoke when the WS closes. Last-wins: a new
registration disconnects the previous peer (its pending calls
fail with a clear error).

`capabilities` come from the peer's `hello` — the bridge only sends
`worker-*` frames to a peer that declared `'worker-relay'`.

`onReplaced` fires when a NEWER registration displaces this peer. The
transport MUST use it to close the old socket: the browser side's
close handler tears down its relayed worker subscriptions — without
this, a replaced tab's SharedWorker listeners would live until the tab
closed, streaming snaps the bridge drops as stale-generation forever.

###### Parameters

###### send

`SendToPeer`

###### tools

`string`[]

###### sandboxId

`string`

###### capabilities?

`string`[]

###### onReplaced?

() => `void`

###### Returns

> (): `void`

###### Returns

`void`

##### subscribeWorker()

> **subscribeWorker**(`sub`, `onSnap`): () => `void`

Register a worker subscription. Ownership lives HERE: the registry
survives peer churn, and every registered sub is re-issued to a new
peer on registration (RTDB value / auth-state subs re-deliver a fresh
initial snapshot, so replay is cursor-free). `onSnap` receives every
relayed snap value verbatim — including the worker host's
`{ __error: { code, message } }` establishment-failure convention.
Returns the unsubscribe function.

###### Parameters

###### sub

`WorkerSubPayload`

###### onSnap

(`value`) => `void`

###### Returns

> (): `void`

###### Returns

`void`

##### toolNames()

> **toolNames**(): `string`[]

Tool names the bridge currently exposes to MCP.

###### Returns

`string`[]

***

### BridgeOptions

#### Properties

##### callTimeoutMs?

> `optional` **callTimeoutMs**: `number`

Per-call request timeout in ms when forwarding to the browser.
Defaults to 30s; the bridge rejects the MCP call with a clear
"sandbox call timed out" error after this.

##### onToolEvent()?

> `optional` **onToolEvent**: (`event`) => `void`

Hook called whenever a tool finishes (success or failure).
Use this for the audit log — write the entry to disk here.
The bridge does not own audit-log persistence.

###### Parameters

###### event

`BridgeToolEvent`

###### Returns

`void`

##### project?

> `optional` **project**: `string`

Sandbox label surfaced in /health and audit-log paths.

##### version

> **version**: `string`

Bridge version surfaced in /health + Hello messages.

***

### HealthReport

Health report returned by the bridge's `GET /health` endpoint.

#### Properties

##### instanceId

> **instanceId**: `string`

Random identity, stable for this bridge process's lifetime. The discovery
pointer (`.pyric/serve.json`) records the same value, so a proxy can confirm
it reached the SAME server the pointer names — two sandboxes can collide on
one port across loopback families (IPv4 `*:P` + IPv6 `[::1]:P`), and `mode`
alone can't tell them apart. (Not `version` — that's hardcoded.)

##### mode

> **mode**: `"sandbox"`

Constant provenance marker: the programmatic bridge is sandbox-only.

##### project

> **project**: `string`

Sandbox identifier surfaced in health and audit metadata.

##### sandboxConnected

> **sandboxConnected**: `boolean`

Whether a browser tab is currently connected over `/sandbox`.

##### startedAt

> **startedAt**: `string`

ISO timestamp the bridge started.

##### status

> **status**: `"ok"`

##### version

> **version**: `string`

Bridge package version.

***

### ServerHandle

#### Properties

##### auditLogPath

> `readonly` **auditLogPath**: `string`

##### bridge

> `readonly` **bridge**: [`Bridge`](#bridge)

##### port

> `readonly` **port**: `number`

##### url

> `readonly` **url**: `string`

#### Methods

##### stop()

> **stop**(): `Promise`\<`void`\>

###### Returns

`Promise`\<`void`\>

***

### StartServerOptions

#### Properties

##### allowedHosts?

> `optional` **allowedHosts**: `string`[]

Extra hostnames allowed past the WS-upgrade rebinding/origin guard
 (besides the loopback set the bridge binds to). Mirrors serve's
 `--allowed-host`.

##### auditWriter?

> `optional` **auditWriter**: `AuditWriter`

Override the audit writer (testing).

##### disableAuditLog?

> `optional` **disableAuditLog**: `boolean`

Disable the audit log writer (useful in tests).

##### logger?

> `optional` **logger**: `BridgeLogger`

Premortem #U1 — logger; defaults to stderr `[pyric]` prefix.

##### maxSessions?

> `optional` **maxSessions**: `number`

Premortem #A2 — refuse new sessions when this many are active. Default 50.

##### port?

> `optional` **port**: `number`

Port to bind. Default: 5174. Env: PYRIC_PORT.

##### project?

> `optional` **project**: `string`

Sandbox label surfaced in health and audit metadata.

##### sessionIdleMs?

> `optional` **sessionIdleMs**: `number`

Premortem #A2 — kill idle sessions after this many ms. Default 10 min.

##### silent?

> `optional` **silent**: `boolean`

Convenience: install a silent logger (tests).

## Variables

### DEFAULT\_BRIDGE\_PORT

> `const` **DEFAULT\_BRIDGE\_PORT**: `5174` = `5174`

Default port the standalone bridge binds to.

***

### DEFAULT\_HEALTH\_PATH

> `const` **DEFAULT\_HEALTH\_PATH**: `"/health"` = `"/health"`

Default health endpoint path.

***

### DEFAULT\_MCP\_PATH

> `const` **DEFAULT\_MCP\_PATH**: `"/mcp"` = `"/mcp"`

Default HTTP path the MCP client connects to.

***

### DEFAULT\_SANDBOX\_PATH

> `const` **DEFAULT\_SANDBOX\_PATH**: `"/sandbox"` = `"/sandbox"`

Default WS path the browser connects to.

## Functions

### createBridge()

> **createBridge**(`opts`): [`Bridge`](#bridge)

#### Parameters

##### opts

[`BridgeOptions`](#bridgeoptions)

#### Returns

[`Bridge`](#bridge)

***

### startServer()

> **startServer**(`opts?`): `Promise`\<[`ServerHandle`](#serverhandle)\>

#### Parameters

##### opts?

[`StartServerOptions`](#startserveroptions)

#### Returns

`Promise`\<[`ServerHandle`](#serverhandle)\>
