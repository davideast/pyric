---
title: "API reference: @pyric/cli/bridge"
navLabel: "@pyric/cli/bridge"
outcome: "Published declarations for @pyric/cli/bridge."
slug: "pyric-cli-bridge-reference-api"
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/bridge"
apiSubpath: "bridge"
apiSymbolCount: 11
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="bridge"></a>

### Bridge

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="instanceid"></a> `instanceId` | `readonly` | `string` | Stable per-process identity (see HealthReport.instanceId). |
| <a id="project"></a> `project` | `readonly` | `string` | - |
| <a id="startedat"></a> `startedAt` | `readonly` | `string` | - |
| <a id="version"></a> `version` | `readonly` | `string` | - |

#### Methods

<a id="dispatch"></a>

##### dispatch()

```ts
dispatch(name: string, args: Record<string, unknown>): Promise<BridgeToolResult>;
```

Dispatch a tool call to the connected sandbox peer.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `name` | `string` |
| `args` | `Record`\<`string`, `unknown`\> |

###### Returns

`Promise`\<`BridgeToolResult`\>

<a id="dispatchworkerop"></a>

##### dispatchWorkerOp()

```ts
dispatchWorkerOp(op: WorkerOpPayload): Promise<unknown>;
```

Relay a generic worker op to the peer's SharedWorker. Resolves with the
worker's `res.value`; rejects with an Error carrying `.code` on worker
failure, timeout, no peer, or a peer without the worker relay.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `op` | `WorkerOpPayload` |

###### Returns

`Promise`\<`unknown`\>

<a id="handlesandboxmessage"></a>

##### handleSandboxMessage()

```ts
handleSandboxMessage(msg: BridgeMessage, generation?: number): void;
```

Handle a message from the sandbox peer (tool-result, pong, …).
`generation` is the peer generation the transport captured at
registration; when provided, `worker-res`/`worker-snap` frames from a
stale generation are dropped.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `msg` | `BridgeMessage` |
| `generation?` | `number` |

###### Returns

`void`

<a id="health"></a>

##### health()

```ts
health(): HealthReport;
```

/health endpoint payload.

###### Returns

[`HealthReport`](#healthreport)

<a id="issandboxconnected"></a>

##### isSandboxConnected()

```ts
isSandboxConnected(): boolean;
```

True if a sandbox peer is currently registered.

###### Returns

`boolean`

<a id="peergeneration"></a>

##### peerGeneration()

```ts
peerGeneration(): number;
```

Generation counter of the CURRENT peer registration (0 = no peer has
ever registered). The transport captures this right after registering
and tags every inbound message with it, so a frame arriving on a
REPLACED peer's socket (tab refresh mid-flight) can never resolve a new
peer's pending call or deliver a stale subscription snapshot.

###### Returns

`number`

<a id="recordtoolevent"></a>

##### recordToolEvent()

```ts
recordToolEvent(event: BridgeToolEvent): void;
```

Record a tool event in the bridge's audit pipeline. In-process sandbox
tools use this path; forwarded tools log inside dispatch().

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `event` | `BridgeToolEvent` |

###### Returns

`void`

<a id="registersandboxpeer"></a>

##### registerSandboxPeer()

```ts
registerSandboxPeer(
   send: SendToPeer,
   tools: string[],
   sandboxId: string,
   capabilities?: string[],
   onReplaced?: () => void): () => void;
```

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

| Parameter | Type |
| :------ | :------ |
| `send` | `SendToPeer` |
| `tools` | `string`[] |
| `sandboxId` | `string` |
| `capabilities?` | `string`[] |
| `onReplaced?` | () => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

<a id="subscribeworker"></a>

##### subscribeWorker()

```ts
subscribeWorker(sub: WorkerSubPayload, onSnap: (value: unknown) => void): () => void;
```

Register a worker subscription. Ownership lives HERE: the registry
survives peer churn, and every registered sub is re-issued to a new
peer on registration (RTDB value / auth-state subs re-deliver a fresh
initial snapshot, so replay is cursor-free). `onSnap` receives every
relayed snap value verbatim — including the worker host's
`{ __error: { code, message } }` establishment-failure convention.
Returns the unsubscribe function.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `sub` | `WorkerSubPayload` |
| `onSnap` | (`value`: `unknown`) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

<a id="toolnames"></a>

##### toolNames()

```ts
toolNames(): string[];
```

Tool names the bridge currently exposes to MCP.

###### Returns

`string`[]

***

<a id="bridgeoptions"></a>

### BridgeOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="calltimeoutms"></a> `callTimeoutMs?` | `number` | Per-call request timeout in ms when forwarding to the browser. Defaults to 30s; the bridge rejects the MCP call with a clear "sandbox call timed out" error after this. |
| <a id="ontoolevent"></a> `onToolEvent?` | (`event`: `BridgeToolEvent`) => `void` | Hook called whenever a tool finishes (success or failure). Use this for the audit log — write the entry to disk here. The bridge does not own audit-log persistence. |
| <a id="project-1"></a> `project?` | `string` | Sandbox label surfaced in /health and audit-log paths. |
| <a id="version-1"></a> `version` | `string` | Bridge version surfaced in /health + Hello messages. |

***

<a id="healthreport"></a>

### HealthReport

Health report returned by the bridge's `GET /health` endpoint.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="instanceid-1"></a> `instanceId` | `string` | Random identity, stable for this bridge process's lifetime. The discovery pointer (`.pyric/serve.json`) records the same value, so a proxy can confirm it reached the SAME server the pointer names — two sandboxes can collide on one port across loopback families (IPv4 `*:P` + IPv6 `[::1]:P`), and `mode` alone can't tell them apart. (Not `version` — that's hardcoded.) |
| <a id="mode"></a> `mode` | `"sandbox"` | Constant provenance marker: the programmatic bridge is sandbox-only. |
| <a id="project-2"></a> `project` | `string` | Sandbox identifier surfaced in health and audit metadata. |
| <a id="sandboxconnected"></a> `sandboxConnected` | `boolean` | Whether a browser tab is currently connected over `/sandbox`. |
| <a id="startedat-1"></a> `startedAt` | `string` | ISO timestamp the bridge started. |
| <a id="status"></a> `status` | `"ok"` | - |
| <a id="version-2"></a> `version` | `string` | Bridge package version. |

***

<a id="serverhandle"></a>

### ServerHandle

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="auditlogpath"></a> `auditLogPath` | `readonly` | `string` |
| <a id="bridge-1"></a> `bridge` | `readonly` | [`Bridge`](#bridge) |
| <a id="port"></a> `port` | `readonly` | `number` |
| <a id="url"></a> `url` | `readonly` | `string` |

#### Methods

<a id="stop"></a>

##### stop()

```ts
stop(): Promise<void>;
```

###### Returns

`Promise`\<`void`\>

***

<a id="startserveroptions"></a>

### StartServerOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="allowedhosts"></a> `allowedHosts?` | `string`[] | Extra hostnames allowed past the WS-upgrade rebinding/origin guard (besides the loopback set the bridge binds to). Mirrors serve's `--allowed-host`. |
| <a id="auditwriter"></a> `auditWriter?` | `AuditWriter` | Override the audit writer (testing). |
| <a id="disableauditlog"></a> `disableAuditLog?` | `boolean` | Disable the audit log writer (useful in tests). |
| <a id="logger"></a> `logger?` | `BridgeLogger` | Premortem #U1 — logger; defaults to stderr `[pyric]` prefix. |
| <a id="maxsessions"></a> `maxSessions?` | `number` | Premortem #A2 — refuse new sessions when this many are active. Default 50. |
| <a id="port-1"></a> `port?` | `number` | Port to bind. Default: 5174. Env: PYRIC_PORT. |
| <a id="project-3"></a> `project?` | `string` | Sandbox label surfaced in health and audit metadata. |
| <a id="sessionidlems"></a> `sessionIdleMs?` | `number` | Premortem #A2 — kill idle sessions after this many ms. Default 10 min. |
| <a id="silent"></a> `silent?` | `boolean` | Convenience: install a silent logger (tests). |

## Variables

<a id="default_bridge_port"></a>

### DEFAULT\_BRIDGE\_PORT

```ts
const DEFAULT_BRIDGE_PORT: 5174 = 5174;
```

Default port the standalone bridge binds to.

***

<a id="default_health_path"></a>

### DEFAULT\_HEALTH\_PATH

```ts
const DEFAULT_HEALTH_PATH: "/health" = "/health";
```

Default health endpoint path.

***

<a id="default_mcp_path"></a>

### DEFAULT\_MCP\_PATH

```ts
const DEFAULT_MCP_PATH: "/mcp" = "/mcp";
```

Default HTTP path the MCP client connects to.

***

<a id="default_sandbox_path"></a>

### DEFAULT\_SANDBOX\_PATH

```ts
const DEFAULT_SANDBOX_PATH: "/sandbox" = "/sandbox";
```

Default WS path the browser connects to.

## Functions

<a id="createbridge"></a>

### createBridge()

```ts
function createBridge(opts: BridgeOptions): Bridge;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `opts` | [`BridgeOptions`](#bridgeoptions) |

#### Returns

[`Bridge`](#bridge)

***

<a id="startserver"></a>

### startServer()

```ts
function startServer(opts?: StartServerOptions): Promise<ServerHandle>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `opts?` | [`StartServerOptions`](#startserveroptions) |

#### Returns

`Promise`\<[`ServerHandle`](#serverhandle)\>
