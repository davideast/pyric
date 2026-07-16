---
title: "API reference: @pyric/cli/bridge/client"
navLabel: "@pyric/cli/bridge/client"
group: "API reference"
section: "@pyric/cli"
order: 9014
description: "Published declarations for @pyric/cli/bridge/client."
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/bridge/client"
apiSubpath: "bridge/client"
apiSymbolCount: 14
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="connectbridgeoptions"></a>

### ConnectBridgeOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="dispatcher"></a> `dispatcher?` | [`SandboxToolDispatcher`](#sandboxtooldispatcher) | Custom tool dispatcher. Defaults to the built-in sandbox tool dispatcher (see `./dispatch.ts`). Hosts can replace this to extend the tool surface. |
| <a id="fetchimpl"></a> `fetchImpl?` | *typeof* `fetch` | Injectable fetch for the standby health poll (tests). Default: global. |
| <a id="initialreconnectdelayms"></a> `initialReconnectDelayMs?` | `number` | Initial reconnect delay in ms (default 500). |
| <a id="maxreconnectdelayms"></a> `maxReconnectDelayMs?` | `number` | Max reconnect delay in ms (default 30_000). |
| <a id="noreconnect"></a> `noReconnect?` | `boolean` | Disable the auto-reconnect loop (useful in tests where the test harness explicitly controls connection lifecycle). |
| <a id="onstatechange"></a> `onStateChange?` | (`state`: [`ConnectedBridgeState`](#connectedbridgestate-2)) => `void` | Called whenever the client transitions connection state. |
| <a id="sandboxid"></a> `sandboxId?` | `string` | Stable identifier for this sandbox session — surfaces in the bridge's audit log entries. Default: a random UUID per page load. |
| <a id="standbypollms"></a> `standbyPollMs?` | `number` | Standby poll interval in ms (default 2_000). When the bridge closes this connection with the REPLACED code (another tab took the peer slot), the client polls the health endpoint at this cadence — plus per-poll jitter, so two standby tabs don't stampede a freshly vacant slot — and only reconnects when `sandboxConnected` is false. |
| <a id="toolnames"></a> `toolNames?` | `string`[] | Tool names to advertise to the bridge in the hello message. Defaults to `SANDBOX_TOOL_NAMES`. Override when supplying a custom dispatcher. |
| <a id="url"></a> `url?` | `string` | Bridge WebSocket URL. Overrides the discovery chain. Example: `ws://localhost:5174/sandbox`. |
| <a id="workerrelay"></a> `workerRelay?` | [`WorkerRelay`](#workerrelay-1) | Generic worker relay (remote sandbox, slice 1). When supplied, the client advertises the `worker-relay` capability in its hello and routes `worker-op` / `worker-sub` / `worker-unsub` frames through it — on the worker path this forwards them into the SharedWorker port (`relayWorkerOp` / `relayWorkerSub` in `serve/worker/client.ts`). |

***

<a id="connectedbridge"></a>

### ConnectedBridge

#### Methods

<a id="disconnect"></a>

##### disconnect()

```ts
disconnect(): void;
```

Close the bridge connection. Does NOT close the underlying sandbox.

###### Returns

`void`

<a id="state"></a>

##### state()

```ts
state(): ConnectedBridgeState;
```

Current connection state.

###### Returns

[`ConnectedBridgeState`](#connectedbridgestate-2)

***

<a id="hellofrombridge"></a>

### HelloFromBridge

Bridge → browser: acknowledge connection.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bridgeversion"></a> `bridgeVersion` | `string` | Bridge version, for compatibility checks. |
| <a id="protocol"></a> `protocol` | `1` | - |
| <a id="type"></a> `type` | `"hello-ack"` | - |

***

<a id="hellofromclient"></a>

### HelloFromClient

Browser → bridge: "I'm here and ready to receive tool calls."

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="capabilities"></a> `capabilities?` | `string`[] | Optional peer capabilities (additive). The bridge only sends `worker-*` frames to a peer that declared WORKER\_RELAY\_CAPABILITY — an old peer that omits it simply never receives them, and worker ops against it fail fast with a clear error instead of timing out. |
| <a id="protocol-1"></a> `protocol` | `1` | Protocol version. Bump if the wire format changes incompatibly. |
| <a id="sandboxid-1"></a> `sandboxId` | `string` | Stable identifier for this sandbox session (for audit log). |
| <a id="tools"></a> `tools` | `string`[] | Tool names the browser can dispatch. Bridge uses this to size MCP tool surface. |
| <a id="type-1"></a> `type` | `"hello"` | - |

***

<a id="sandboxtooldispatcher"></a>

### SandboxToolDispatcher()

```ts
SandboxToolDispatcher(
   sandbox: LocalSandbox,
   name: string,
   args: Record<string, unknown>): Promise<{
  data?: unknown;
  ok: boolean;
  summary: string;
}>;
```

Dispatch a tool call. Throws if the tool isn't recognised
(the bridge advertises only what this dispatcher reports it
can handle, so unknowns indicate wire-level drift).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `LocalSandbox` |
| `name` | `string` |
| `args` | `Record`\<`string`, `unknown`\> |

#### Returns

`Promise`\<\{
  `data?`: `unknown`;
  `ok`: `boolean`;
  `summary`: `string`;
\}\>

***

<a id="toolcallrequest"></a>

### ToolCallRequest

Bridge → browser: please dispatch this tool call into the sandbox.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="args"></a> `args` | `Record`\<`string`, `unknown`\> | Tool arguments (JSON-serializable). |
| <a id="id"></a> `id` | `string` | Correlation id — browser must echo in `ToolCallResponse`. |
| <a id="name"></a> `name` | `string` | Tool name (e.g. `firestore_simulator_create`). |
| <a id="type-2"></a> `type` | `"tool-call"` | - |

***

<a id="toolcallresponse"></a>

### ToolCallResponse

Browser → bridge: tool call result.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="error"></a> `error?` | \{ `code`: `string`; `message`: `string`; \} | - |
| `error.code` | `string` | - |
| `error.message` | `string` | - |
| <a id="id-1"></a> `id` | `string` | Correlation id from the matching request. |
| <a id="ok"></a> `ok` | `boolean` | When `ok===false`, `error` is populated and `result` is omitted. |
| <a id="result"></a> `result?` | \{ `data?`: `unknown`; `ok`: `boolean`; `summary`: `string`; \} | Tool result (matches `ToolResult` shape from `@inbrowser/agent`). |
| `result.data?` | `unknown` | - |
| `result.ok` | `boolean` | - |
| `result.summary` | `string` | - |
| <a id="type-3"></a> `type` | `"tool-result"` | - |

***

<a id="workerrelay-1"></a>

### WorkerRelay

Host-supplied handlers that forward relay frames into the SharedWorker.

#### Methods

<a id="op"></a>

##### op()

```ts
op(op: WorkerOpPayload): Promise<unknown>;
```

Dispatch one worker op; resolves with the worker's `res.value`.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `op` | `WorkerOpPayload` |

###### Returns

`Promise`\<`unknown`\>

<a id="subscribe"></a>

##### subscribe()

```ts
subscribe(sub: WorkerSubPayload, onValue: (value: unknown) => void): () => void;
```

Register a worker subscription; `onValue` receives every snap value
(including the `{ __error }` establishment-failure convention).
Returns the unsubscribe function.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `sub` | `WorkerSubPayload` |
| `onValue` | (`value`: `unknown`) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

## Type Aliases

<a id="bridgemessage"></a>

### BridgeMessage

```ts
type BridgeMessage =
  | HelloFromClient
  | HelloFromBridge
  | AttachFromConsumer
  | AttachAckFromBridge
  | ToolCallRequest
  | ToolCallResponse
  | WorkerOpFrame
  | WorkerResFrame
  | WorkerSubFrame
  | WorkerUnsubFrame
  | WorkerSnapFrame
  | Ping
  | Pong;
```

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

<a id="connectedbridgestate-2"></a>

### ConnectedBridgeState

```ts
type ConnectedBridgeState =
  | {
  kind: "connecting";
}
  | {
  bridgeVersion: string;
  kind: "connected";
}
  | {
  kind: "disconnected";
  reason: string;
}
  | {
  attempt: number;
  delayMs: number;
  kind: "reconnecting";
}
  | {
  kind: "standby";
};
```

#### Type Declaration

```ts
{
  kind: "connecting";
}
```

##### kind

```ts
kind: "connecting";
```

```ts
{
  bridgeVersion: string;
  kind: "connected";
}
```

##### bridgeVersion

```ts
bridgeVersion: string;
```

##### kind

```ts
kind: "connected";
```

```ts
{
  kind: "disconnected";
  reason: string;
}
```

##### kind

```ts
kind: "disconnected";
```

##### reason

```ts
reason: string;
```

```ts
{
  attempt: number;
  delayMs: number;
  kind: "reconnecting";
}
```

##### attempt

```ts
attempt: number;
```

##### delayMs

```ts
delayMs: number;
```

##### kind

```ts
kind: "reconnecting";
```

```ts
{
  kind: "standby";
}
```

##### kind

```ts
kind: "standby";
```

Another tab holds the peer slot (this connection was closed with the
REPLACED code). The client health-polls until the slot is vacant, then
reconnects. Distinct from `reconnecting`: the bridge is healthy and
deliberately serving a different tab.

## Variables

<a id="default_bridge_port"></a>

### DEFAULT\_BRIDGE\_PORT

```ts
const DEFAULT_BRIDGE_PORT: 5174 = 5174;
```

Default port the standalone bridge binds to.

***

<a id="default_sandbox_path"></a>

### DEFAULT\_SANDBOX\_PATH

```ts
const DEFAULT_SANDBOX_PATH: "/sandbox" = "/sandbox";
```

Default WS path the browser connects to.

## Functions

<a id="connectbridge"></a>

### connectBridge()

```ts
function connectBridge(sandbox: LocalSandbox, opts?: ConnectBridgeOptions): ConnectedBridge;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `sandbox` | `LocalSandbox` |
| `opts?` | [`ConnectBridgeOptions`](#connectbridgeoptions) |

#### Returns

[`ConnectedBridge`](#connectedbridge)

***

<a id="topageoriginwsurl"></a>

### toPageOriginWsUrl()

```ts
function toPageOriginWsUrl(raw: string, loc: {
  host: string;
  href: string;
  protocol: string;
}): string;
```

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

| Parameter | Type |
| :------ | :------ |
| `raw` | `string` |
| `loc` | \{ `host`: `string`; `href`: `string`; `protocol`: `string`; \} |
| `loc.host` | `string` |
| `loc.href` | `string` |
| `loc.protocol` | `string` |

#### Returns

`string`
