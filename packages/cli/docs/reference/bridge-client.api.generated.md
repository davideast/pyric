<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# @pyric/cli/bridge/client

## Interfaces

### ConnectBridgeOptions

#### Properties

##### dispatcher?

> `optional` **dispatcher**: [`SandboxToolDispatcher`](#sandboxtooldispatcher)

Custom tool dispatcher. Defaults to the built-in sandbox tool
dispatcher (see `./dispatch.ts`). Hosts can replace this to
extend the tool surface.

##### fetchImpl?

> `optional` **fetchImpl**: *typeof* `fetch`

Injectable fetch for the standby health poll (tests). Default: global.

##### initialReconnectDelayMs?

> `optional` **initialReconnectDelayMs**: `number`

Initial reconnect delay in ms (default 500).

##### maxReconnectDelayMs?

> `optional` **maxReconnectDelayMs**: `number`

Max reconnect delay in ms (default 30_000).

##### noReconnect?

> `optional` **noReconnect**: `boolean`

Disable the auto-reconnect loop (useful in tests where the test
harness explicitly controls connection lifecycle).

##### onStateChange()?

> `optional` **onStateChange**: (`state`) => `void`

Called whenever the client transitions connection state.

###### Parameters

###### state

[`ConnectedBridgeState`](#connectedbridgestate-2)

###### Returns

`void`

##### sandboxId?

> `optional` **sandboxId**: `string`

Stable identifier for this sandbox session — surfaces in the
bridge's audit log entries. Default: a random UUID per page load.

##### standbyPollMs?

> `optional` **standbyPollMs**: `number`

Standby poll interval in ms (default 2_000). When the bridge closes this
connection with the REPLACED code (another tab took the peer slot), the
client polls the health endpoint at this cadence — plus per-poll jitter,
so two standby tabs don't stampede a freshly vacant slot — and only
reconnects when `sandboxConnected` is false.

##### toolNames?

> `optional` **toolNames**: `string`[]

Tool names to advertise to the bridge in the hello message.
Defaults to `SANDBOX_TOOL_NAMES`. Override when supplying a
custom dispatcher.

##### url?

> `optional` **url**: `string`

Bridge WebSocket URL. Overrides the discovery chain.
Example: `ws://localhost:5174/sandbox`.

##### workerRelay?

> `optional` **workerRelay**: [`WorkerRelay`](#workerrelay-1)

Generic worker relay (remote sandbox, slice 1). When supplied, the
client advertises the `worker-relay` capability in its hello and routes
`worker-op` / `worker-sub` / `worker-unsub` frames through it — on the
worker path this forwards them into the SharedWorker port
(`relayWorkerOp` / `relayWorkerSub` in `serve/worker/client.ts`).

***

### ConnectedBridge

#### Methods

##### disconnect()

> **disconnect**(): `void`

Close the bridge connection. Does NOT close the underlying sandbox.

###### Returns

`void`

##### state()

> **state**(): [`ConnectedBridgeState`](#connectedbridgestate-2)

Current connection state.

###### Returns

[`ConnectedBridgeState`](#connectedbridgestate-2)

***

### HelloFromBridge

Bridge → browser: acknowledge connection.

#### Properties

##### bridgeVersion

> **bridgeVersion**: `string`

Bridge version, for compatibility checks.

##### protocol

> **protocol**: `1`

##### type

> **type**: `"hello-ack"`

***

### HelloFromClient

Browser → bridge: "I'm here and ready to receive tool calls."

#### Properties

##### capabilities?

> `optional` **capabilities**: `string`[]

Optional peer capabilities (additive). The bridge only sends `worker-*`
frames to a peer that declared WORKER\_RELAY\_CAPABILITY — an old
peer that omits it simply never receives them, and worker ops against it
fail fast with a clear error instead of timing out.

##### protocol

> **protocol**: `1`

Protocol version. Bump if the wire format changes incompatibly.

##### sandboxId

> **sandboxId**: `string`

Stable identifier for this sandbox session (for audit log).

##### tools

> **tools**: `string`[]

Tool names the browser can dispatch. Bridge uses this to size MCP tool surface.

##### type

> **type**: `"hello"`

***

### SandboxToolDispatcher()

> **SandboxToolDispatcher**(`sandbox`, `name`, `args`): `Promise`\<\{ `data?`: `unknown`; `ok`: `boolean`; `summary`: `string`; \}\>

Dispatch a tool call. Throws if the tool isn't recognised
(the bridge advertises only what this dispatcher reports it
can handle, so unknowns indicate wire-level drift).

#### Parameters

##### sandbox

`LocalSandbox`

##### name

`string`

##### args

`Record`\<`string`, `unknown`\>

#### Returns

`Promise`\<\{ `data?`: `unknown`; `ok`: `boolean`; `summary`: `string`; \}\>

***

### ToolCallRequest

Bridge → browser: please dispatch this tool call into the sandbox.

#### Properties

##### args

> **args**: `Record`\<`string`, `unknown`\>

Tool arguments (JSON-serializable).

##### id

> **id**: `string`

Correlation id — browser must echo in `ToolCallResponse`.

##### name

> **name**: `string`

Tool name (e.g. `firestore_simulator_create`).

##### type

> **type**: `"tool-call"`

***

### ToolCallResponse

Browser → bridge: tool call result.

#### Properties

##### error?

> `optional` **error**: `object`

###### code

> **code**: `string`

###### message

> **message**: `string`

##### id

> **id**: `string`

Correlation id from the matching request.

##### ok

> **ok**: `boolean`

When `ok===false`, `error` is populated and `result` is omitted.

##### result?

> `optional` **result**: `object`

Tool result (matches `ToolResult` shape from `@inbrowser/agent`).

###### data?

> `optional` **data**: `unknown`

###### ok

> **ok**: `boolean`

###### summary

> **summary**: `string`

##### type

> **type**: `"tool-result"`

***

### WorkerRelay

Host-supplied handlers that forward relay frames into the SharedWorker.

#### Methods

##### op()

> **op**(`op`): `Promise`\<`unknown`\>

Dispatch one worker op; resolves with the worker's `res.value`.

###### Parameters

###### op

`WorkerOpPayload`

###### Returns

`Promise`\<`unknown`\>

##### subscribe()

> **subscribe**(`sub`, `onValue`): () => `void`

Register a worker subscription; `onValue` receives every snap value
(including the `{ __error }` establishment-failure convention).
Returns the unsubscribe function.

###### Parameters

###### sub

`WorkerSubPayload`

###### onValue

(`value`) => `void`

###### Returns

> (): `void`

###### Returns

`void`

## Type Aliases

### BridgeMessage

> **BridgeMessage** = [`HelloFromClient`](#hellofromclient) \| [`HelloFromBridge`](#hellofrombridge) \| `AttachFromConsumer` \| `AttachAckFromBridge` \| [`ToolCallRequest`](#toolcallrequest) \| [`ToolCallResponse`](#toolcallresponse) \| `WorkerOpFrame` \| `WorkerResFrame` \| `WorkerSubFrame` \| `WorkerUnsubFrame` \| `WorkerSnapFrame` \| `Ping` \| `Pong`

`@pyric/cli/bridge` — browser-side entry.

Resolved by the `browser` condition in `package.json`'s exports map.
Exports `connectBridge`, which the host app calls to register its
in-page sandbox with a running pyric bridge process. After
registration, MCP tool calls reaching the bridge are forwarded over
WebSocket and dispatched into the local sandbox.

The Node-side server entry lives in `./server.ts`. Wire format
shared by both lives in `./protocol.ts`.

ALSO reachable as `@pyric/cli/bridge/client` — an explicit, condition-free
subpath for browser apps whose TYPE resolution doesn't apply the `browser`
condition (Pyric Studio's `moduleResolution: bundler` tsconfig resolves the
`./bridge` subpath's top-level `types` to the SERVER entry). Same file,
same surface.

***

### ConnectedBridgeState

> **ConnectedBridgeState** = \{ `kind`: `"connecting"`; \} \| \{ `bridgeVersion`: `string`; `kind`: `"connected"`; \} \| \{ `kind`: `"disconnected"`; `reason`: `string`; \} \| \{ `attempt`: `number`; `delayMs`: `number`; `kind`: `"reconnecting"`; \} \| \{ `kind`: `"standby"`; \}

#### Type Declaration

\{ `kind`: `"connecting"`; \}

##### kind

> **kind**: `"connecting"`

\{ `bridgeVersion`: `string`; `kind`: `"connected"`; \}

##### bridgeVersion

> **bridgeVersion**: `string`

##### kind

> **kind**: `"connected"`

\{ `kind`: `"disconnected"`; `reason`: `string`; \}

##### kind

> **kind**: `"disconnected"`

##### reason

> **reason**: `string`

\{ `attempt`: `number`; `delayMs`: `number`; `kind`: `"reconnecting"`; \}

##### attempt

> **attempt**: `number`

##### delayMs

> **delayMs**: `number`

##### kind

> **kind**: `"reconnecting"`

\{ `kind`: `"standby"`; \}

##### kind

> **kind**: `"standby"`

Another tab holds the peer slot (this connection was closed with the
REPLACED code). The client health-polls until the slot is vacant, then
reconnects. Distinct from `reconnecting`: the bridge is healthy and
deliberately serving a different tab.

## Variables

### DEFAULT\_BRIDGE\_PORT

> `const` **DEFAULT\_BRIDGE\_PORT**: `5174` = `5174`

Default port the standalone bridge binds to.

***

### DEFAULT\_SANDBOX\_PATH

> `const` **DEFAULT\_SANDBOX\_PATH**: `"/sandbox"` = `"/sandbox"`

Default WS path the browser connects to.

## Functions

### connectBridge()

> **connectBridge**(`sandbox`, `opts?`): [`ConnectedBridge`](#connectedbridge)

#### Parameters

##### sandbox

`LocalSandbox`

##### opts?

[`ConnectBridgeOptions`](#connectbridgeoptions)

#### Returns

[`ConnectedBridge`](#connectedbridge)

***

### toPageOriginWsUrl()

> **toPageOriginWsUrl**(`raw`, `loc`): `string`

Re-anchor a bridge WebSocket URL to the page's own origin.

`pyric dev` / the vite plugin bake their OWN host into the bridge URL it
sends the page (e.g. `ws://localhost:5173/__pyric/sandbox`). But the page may
have been loaded over a different host (Tailscale, a LAN IP) or scheme
(`https` via `tailscale serve`, which then requires `wss`). Connecting to the
baked `localhost` from a remote tab dials the WRONG machine (the client's own
localhost), so the WS fails.

Keep only the PATH from the server's URL and rebuild the scheme + host from the
page's `location`. The bridge is always mounted on the same server that served
the page, so the page's origin is the correct target wherever it is reached,
with no plugin configuration. This also sidesteps the localhost / 127.0.0.1 /
::1 family ambiguity, because the browser dials the exact host it loaded from.

Pure (location is injected) so it is unit-testable. Returns `raw` unchanged if
it cannot be parsed.

#### Parameters

##### raw

`string`

##### loc

###### host

`string`

###### href

`string`

###### protocol

`string`

#### Returns

`string`
