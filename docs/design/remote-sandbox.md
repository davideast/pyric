# Remote Sandbox for `pyric-admin` (Gate B0 design spike)

Status: spike complete — analysis + phased plan, no implementation.
Scope: server-side `pyric-admin` (and, later, the Node client SDK)
reaching the browser-hosted SharedWorker sandbox over the existing
bridge transport. First slice: RTDB + Auth.

## Feasibility verdict

**Feasible, with one design correction.** The transport and worker
protocol are largely already built: the worker protocol has every RTDB
op the admin surface needs (`rtdb.get/set/update/remove/push`), an RTDB
value subscription, and the full set of admin auth user-CRUD ops
(`auth.listUsers` / `auth.adminCreateUser` / `auth.adminUpdateUser` /
`auth.adminDeleteUser`), and the WS bridge already relays request/
response frames server→browser→worker with correlation ids and
last-connection-wins peer semantics. The missing piece is a generic
op/subscription relay frame (today only `tool-call` crosses the WS) and
the Node-side `connectRemoteSandbox()`.

**The correction:** the assumed design — "`pyric-admin`'s entire seam
is the `Sandbox` handle passed to `initializeApp({ sandbox })`, so a
remote `Sandbox` plugs in with zero `pyric-admin` changes" — is **false
for the RTDB and Auth sandbox backends as written**. Both keep their
data in **process-local in-memory state keyed off the `Sandbox` object
identity via a `WeakMap`**, consuming almost nothing from the `Sandbox`
surface itself:

- RTDB: `stateBySandbox = new WeakMap<Sandbox, SandboxState>()`
  (`packages/pyric-admin/src/database/index.ts:171`); all ref ops read/
  write a local JSON tree (`readPath`/`writePath`, lines 292–354). The
  only `Sandbox` member consumed is `sandbox.onEvent` — to wipe the
  tree on `session_boundary` (lines 183–187).
- Auth: `sandboxStores = new WeakMap<Sandbox, AuthStore>()`
  (`packages/pyric-admin/src/auth/index.ts:142`); user records live in a
  local `Map<uid, UserRecord>` (line 112). Again only `sandbox.onEvent`
  is consumed (lines 167–174). Tokens are stateless strings
  (`SANDBOX_TOKEN_PREFIX`, line 194).

A perfect remote `Sandbox` handle passed unchanged would therefore give
the Node process a **private** RTDB tree and a **private** user table
that never reach the browser worker — the first user's server-side
writes would be invisible in Studio and in their app, which defeats the
gate. (Note also: the spike brief said `pyric-admin/database` "delegates
to pyric's own `adminGetDatabase`/`getDatabaseWithUrl` over the
sandbox" — those imports are **firebase-admin's**, used only on the
prod path; see `packages/pyric-admin/src/database/index.ts:63–67` and
`126–129`.)

So the design is: `connectRemoteSandbox()` (Node, pyric-tools) returns
a **branded remote handle** that satisfies the subset of `Sandbox` that
`pyric-admin` consumes and carries an internal **op channel** speaking
the existing worker protocol over the bridge WS. `pyric-admin`'s
`database` and `auth` sandbox backends gain a second dispatch arm: when
the app's sandbox carries the remote brand, ref/auth methods route
through the channel (worker ops) instead of the local WeakMap state.
`initializeApp({ sandbox })` and all user-facing signatures stay
unchanged — the change is internal to the two backend files, and we are
pre-npm, so this is cheap now and expensive later.

A pleasant side effect: routing admin ops through the worker makes
server-side writes emit real `SandboxEvent`s into the unified stream
(the worker's RTDB backend emits `operation`/`commit`/
`service_mutation` events — `packages/pyric/src/database/sandbox/backend.ts`
imports `emitSandboxEvent` and friends), so agent/Studio provenance
sees server activity "for free". This is a deliberate behavior change
from the current silent local tree, and the right one.

## 1. The `Sandbox` surface, and what `pyric-admin` actually needs

`Sandbox` is defined in `packages/pyric/src/sandbox/types.ts:954–1205`
(exported via `pyric/sandbox`). Full member classification:

| Member | Sync/async | Remotable as RPC? |
|---|---|---|
| `withAuth(auth): SandboxContext` | sync | yes — pure local pair construction (`SandboxContext` is `(sandbox, auth)`, types.ts:1218) |
| `onEvent(cb): () => void` | sync subscribe, async delivery | yes — subscribe locally, feed from a WS event-stream sub |
| `history(): SandboxEvent[]` | **sync return** | no — needs async variant or local event cache |
| `admin` (`getDocument`/`listDocuments`/`setDocument`/`deleteDocument`) | **all sync** (types.ts:325–362) | no — Firestore admin plane is synchronous by contract |
| `reset(): void` | **sync** (fire-and-forget possible) | degraded — can relay as fire-and-forget op; completion unobservable |
| `dispose(): void` | sync | yes — local teardown |
| `snapshot(): SandboxSnapshot` | **sync return** | no |
| `loadSnapshot(data): void` | **sync** | degraded (fire-and-forget) |
| `currentUser: AuthState` | **sync property** | no — needs a locally cached mirror fed by a subscription |
| `onCurrentUserChanged(cb)` | sync subscribe | yes (mirror-fed) |
| `enableTabSync(options)` | sync | n/a in Node — no-op |
| `enablePersistence(opts)` | async | n/a — worker owns persistence; throw with guidance |
| `flush()` / `clearPersistence()` | async | n/a — same |
| `registerPersistableService(name, hooks)` | sync | n/a — worker owns persistence; throw with guidance |

**What `pyric-admin` transitively consumes today:**

- `pyric-admin/app` (`packages/pyric-admin/src/app/index.ts:64–76`):
  stores the reference only. Needs nothing but a stable object.
- RTDB path (`packages/pyric-admin/src/database/index.ts`): `onEvent`
  (line 183) + object identity. Every `Reference` data method is
  **already async** (`set`/`get`/`once('value')`/`update`/`remove`
  return Promises, lines 491–534) — they map 1:1 onto worker ops. The
  one sync-shaped API is `push()` (line 542): it returns a
  `ThenableReference` whose `.key` must be available synchronously.
  This is already solved by the worker protocol: the **client mints the
  push id** and sends it (`rtdb.push` carries `key`,
  `packages/pyric-tools/src/serve/worker/protocol.ts:367`; the push-id
  generator is already inlined in pyric-admin, database/index.ts:409).
  `ref()`/`child()`/`parent`/`DataSnapshot` accessors are pure local
  path/value manipulation — no relay needed.
- Auth path (`packages/pyric-admin/src/auth/index.ts`): `onEvent`
  (line 169) + identity. Every implemented method is **already async**:
  `createUser`, `getUser`, `getUserByEmail`, `deleteUser`,
  `setCustomUserClaims` return Promises (lines 358–440).
  `createCustomToken`/`verifyIdToken` (lines 276–350) are **stateless
  string transforms** — they need no relay at all and work identically
  against a remote sandbox (the token format round-trips through any
  instance of the same backend).

**Conclusion on the sync-member risk:** for slice 1 it is a non-issue —
nothing `pyric-admin`'s RTDB/Auth paths need is sync-only. The `onEvent`
consumption (reset detection) becomes unnecessary once the backends are
remote-routed: they hold no local data to wipe. Proposed handling for
the rest of the surface, pre-npm:

1. `connectRemoteSandbox()` is **async** (`await connect…`) and its
   handshake snapshots static config (project, databaseUrl, worker
   `instanceId`/version via the existing `getVersion` op) so anything
   config-shaped is available synchronously afterward.
2. `currentUser` is a locally cached mirror fed by an `authState`
   subscription established during the handshake.
3. Genuinely sync members that cannot be mirrored (`admin.*`,
   `snapshot()`, `history()`) **throw a branded, remediating error**
   ("not available on a remote sandbox — use the async worker client
   ops / Studio") on the remote handle. The handle is typed as
   `RemoteSandbox` (structurally a `Sandbox`) with the limitation
   documented; since we are pre-npm we can also split a
   `MinimalSandbox` interface later if a second consumer appears.

## 2. Worker protocol coverage

From `packages/pyric-tools/src/serve/worker/protocol.ts` (ops) and
`host.ts` / `host-auth.ts` (handlers):

**RTDB — fully covered for the admin data plane:**

| Need (admin `Reference`) | Existing op | Evidence |
|---|---|---|
| `get()` / `once('value')` | `rtdb.get` | protocol.ts:363; host.ts:900 |
| `set(value)` | `rtdb.set` | protocol.ts:364; host.ts:908 |
| `update(values)` | `rtdb.update` | protocol.ts:365; host.ts:918 |
| `remove()` / `set(null)` | `rtdb.remove` | protocol.ts:366; host.ts:927 |
| `push(value?)` (client-minted key) | `rtdb.push` | protocol.ts:367; host.ts:936 |
| whole-tree admin read | `rtdb.adminSnapshot` | protocol.ts:368; host.ts:952 |
| value subscription | `RtdbValueSubMessage` `{ t:'sub', target:{service:'rtdb', path} }` | protocol.ts:507–513; host.ts:1214 (`handleRtdbSub`, delivers `{t:'snap'}` per change) |

Every op accepts an `actAs` auth lens (protocol.ts:436–444);
`{ mode: 'admin' }` routes through the rule-bypass RTDB handle
(`lensRtdb`, host.ts:479) — exactly firebase-admin's rules-bypass
semantics. The remote admin backend should pin `actAs: { mode:'admin' }`
on every relayed op.

**Auth — covered for the pyric-admin subset:**

| Need (admin `Auth`) | Existing op | Evidence |
|---|---|---|
| `createUser(props)` | `auth.adminCreateUser` | protocol.ts:399; host-auth.ts:282 → `authSandboxOps.createUser` |
| `getUser(uid)` / `getUserByEmail` | `auth.listUsers` (filter client-side) | protocol.ts:398; host-auth.ts:274 |
| `deleteUser(uid)` | `auth.adminDeleteUser` | protocol.ts:401; host-auth.ts:303 |
| `setCustomUserClaims(uid, claims)` | `auth.adminUpdateUser` — `UpdateUserRequest.customClaims` exists (`packages/pyric/src/auth/sandbox-backend.ts:199–203`) | protocol.ts:400; host-auth.ts:292 |
| `createCustomToken` / `verifyIdToken` | none needed — stateless local strings | pyric-admin/src/auth/index.ts:276–350 |
| clear-all (tests) | `auth.adminClearUsers` | protocol.ts:402; host-auth.ts:311 |

**Gaps (all small, none gating slice 1):**

- No single-user lookup op (`auth.getUser`) — `listUsers` + filter is
  O(n) over the wire; fine at sandbox scale, add a dedicated op if it
  ever matters.
- No RTDB `child_added`/`child_changed` granular listener relay — only
  `value`. The admin sandbox backend throws on `on()` today anyway
  (database/index.ts:578), so wiring admin `on('value')` via the value
  sub is a strict **improvement** over the local backend, and other
  event types stay not-implemented with the same error.
- No RTDB transaction op — admin `transaction()` throws today
  (line 587); parity preserved.
- No RTDB query ops over the wire — query builders throw today
  (lines 600–631); parity preserved.
- Semantics note: the worker's `rtdb.update` goes through
  `pyric/database/modular`'s full multi-path update, while the local
  admin tree only does shallow merge (database/index.ts:44–47). Remote
  routing *upgrades* this — document it.

## 3. Bridge transport extension

**Today's flow (tool calls only):**

1. MCP call → `bridge.dispatch(name, args)` → `dispatchSandbox`
   (`packages/pyric-tools/src/bridge/server/bridge.ts:261–302`): mints a
   `randomUUID()` correlation id, stores a `PendingCall` with a **30s
   timeout** (`callTimeoutMs`, line 156), sends
   `{ type:'tool-call', id, name, args }` to the one peer.
2. `attachPeer` (`bridge/server/peer.ts:18–63`) adapts the `ws` socket;
   registration on `hello`, last-connection-wins
   (`registerSandboxPeer`, bridge.ts:179–200 — a new peer fails all of
   the old peer's pending calls).
3. Browser peer (`bridge/client/bridge.ts`) receives `tool-call` and
   dispatches; on the worker path the dispatcher is
   `(_s, name, args) => workerCallTool(wdb, name, args)`
   (`serve/entries/runtime.ts:510–515`), which posts a
   `{ t:'tool', id, name, args }` worker message
   (`serve/worker/client.ts:414–424`) → `handleTool` (host.ts:1317).
   Result flows back as `{ type:'tool-result', id, … }`.

**Extension — four new `BridgeMessage` frames** (in
`bridge/protocol.ts`, protocol bump not needed if additive; peers that
don't understand them simply never receive them because the bridge only
sends worker frames after a capability flag in `hello`):

```
server→browser  { type:'worker-op',    id, op: OpMessage }        // any worker op, actAs pinned by server
browser→server  { type:'worker-res',   id, ok, value? , error? }  // relayed ResMessage
server→browser  { type:'worker-sub',   subId, sub: SubMessage }   // rtdb value sub (slice 1), events later
server→browser  { type:'worker-unsub', subId }
browser→server  { type:'worker-snap',  subId, value }             // relayed SnapMessage / EventStreamMessage
```

The browser relay is mechanical: forward `op`/`sub` to the worker port
(namespacing `subId` as `bridge:<subId>` to avoid collisions with the
page's own subs), forward `res`/`snap` back. Reuse the existing
`hello.tools` mechanism plus a new `hello.capabilities: ['worker-relay']`
so the bridge can fail fast against an old peer.

Design points:

- **Correlation ids.** Server-minted UUIDs, echoed back — same as
  tool-calls. Late/unknown ids are already dropped silently
  (bridge.ts:309). Tag each peer registration with a generation counter
  so a frame from a replaced peer's socket can never resolve a new
  peer's pending call (today `attachPeer`'s closure + `pending.delete`
  make this near-impossible, but subscriptions make stale delivery
  likelier — check generation on `worker-snap`).
- **Subscription lifecycle over a reconnecting WS.** Ownership lives on
  the **Node side**: `connectRemoteSandbox` keeps a registry of active
  subs (subId → target + callback). The bridge keeps a mirror of
  bridge-side subs. On peer replacement (tab refresh) or WS reconnect,
  the bridge re-issues every registered `worker-sub` to the new peer on
  `hello`. RTDB `value` semantics make this safe and cursor-free: every
  (re)subscribe delivers a fresh initial snapshot, and value listeners
  are last-value-wins — the Node consumer just sees an extra snapshot.
  The worker's state survives tab refresh (IndexedDB persistence +
  SharedWorker lifetime), so the re-subscribed value is continuous.
  Surface a `stream-reset` notification on the Node handle for
  consumers that care.
- **The 30s timeout.** Keep it for `worker-op` (same `callTimeoutMs`
  budget as tool-calls; `mcp-proxy` already sits above it at 35s,
  `cli/mcp-proxy.ts:55`). Subscriptions get no per-frame timeout;
  liveness comes from the existing ping/pong. Sub **establishment**
  errors must relay: `handleRtdbSub` posts a
  `{ value: { __error } }` snap on failure (host.ts:1231–1234) — the
  relay forwards it and the Node side rejects the subscribe promise.
- **Last-connection-wins with a Node client + agent tools sharing the
  peer.** Both multiplex over the ONE bridge core and the ONE peer —
  no change to peer semantics. Consequences: (a) a tab refresh fails
  all in-flight ops for **both** consumers with "sandbox peer replaced"
  (bridge.ts:186) — the Node client should classify that error as
  retryable and retry once after the new peer's hello; (b) two browser
  tabs still race for peerhood, but both tabs front the same
  SharedWorker, so whichever tab wins relays to the same sandbox —
  benign; (c) ops are async-multiplexed, so a slow agent tool call does
  not block admin ops.
- **Backpressure.** Slice 1 relays only RTDB value subs, which are
  coalescible: if `ws.bufferedAmount` (browser) exceeds a threshold,
  keep only the **latest** pending snap per subId (value subs are
  last-value-wins, dropping intermediates is semantically safe). The
  unified event stream (`target:'events'`, history batches) is NOT
  coalescible — defer relaying it to slice 2 with an explicit bound
  (cap + drop-oldest + `overflow: true` marker frame).

## 4. Connection lifecycle

- **Discovery.** Same pattern as `mcp-proxy`
  (`packages/pyric-tools/src/cli/mcp-proxy.ts:132–193`): read
  `.pyric/serve.json` in cwd — serve writes
  `{ url, mcpUrl, port, pid, instanceId, project }`
  (`packages/pyric-tools/src/cli/serve.ts:362–370`) — probe
  `/__pyric/health` on both loopback families explicitly
  (`basesForPort`, mcp-proxy.ts:84), and **pin `instanceId`** to avoid
  the cross-family port-squatter split-brain. Factor `discoverServe`
  out of `cli/` into a shared module rather than duplicating it.
- **No browser tab open.** Health reports `sandboxConnected: false`
  (`bridge.ts:349–359`). `connectRemoteSandbox()` fails fast, mirroring
  `NO_SANDBOX_ERROR_MESSAGE` (`bridge/protocol.ts:146`):
  `"no browser tab is connected to the sandbox — open <serve url> and retry"`
  using the pointer's `url`. Optionally accept
  `{ waitForPeer: ms }` to poll health briefly (a user who just ran
  `pyric serve` has a tab opening). Do **not** silently fall back to an
  in-process sandbox (the headless path `runHeadlessMcp` exists,
  mcp-proxy.ts:236–240, but silently splitting the backend is exactly
  the failure the gate is meant to avoid).
- **Reconnect across tab refresh.** Three lifetimes to distinguish:
  1. *Tab refresh, other tabs open* — SharedWorker lives; only the peer
     WS churns. Bridge re-issues subs to the new peer (section 3);
     Node-invisible apart from possible one failed in-flight op.
  2. *All tabs closed, then reopened* — SharedWorker dies and restarts;
     state restores from IndexedDB (worker persistence). Value subs
     re-fire with restored state on re-subscribe. Nothing else to
     re-establish: pyric-admin's plane is admin (no auth session), and
     sandbox tokens are stateless.
  3. *serve restarted* — new `instanceId`; the pinned identity check
     fails; the Node handle surfaces a terminal
     `"serve restarted — reconnecting"` and re-runs discovery.
  What the Node side re-establishes, exhaustively: **subscriptions**
  (registry replay) and its **`currentUser` mirror** (re-subscribe
  `authState`). No admin auth session exists to restore.

## 5. Phased implementation plan

### Slice 1 — RTDB + Auth (the first user)

| # | Work item | Files | Effort |
|---|---|---|---|
| 1 | Bridge frames: `worker-op`/`worker-res`/`worker-sub`/`worker-snap`/`worker-unsub` + `hello.capabilities` | `src/bridge/protocol.ts` | S |
| 2 | Bridge core: generic op dispatch (reuse `PendingCall` machinery), bridge-side sub registry, resubscribe-on-new-peer, generation tagging | `src/bridge/server/bridge.ts`, `peer.ts` | M |
| 3 | Browser relay: forward worker frames to the worker port; subId namespacing; buffered-amount coalescing for value snaps | `src/bridge/client/bridge.ts`, `src/serve/entries/runtime.ts`, small additions to `src/serve/worker/client.ts` | M |
| 4 | `connectRemoteSandbox()` (Node): shared discovery (extract from `cli/mcp-proxy.ts`), WS client (`ws` pkg), handshake (getVersion + authState sub), branded `RemoteSandbox` handle with op channel + sub registry + fail-fast messaging | new `src/remote/` in pyric-tools | M |
| 5 | `pyric-admin` remote dispatch: brand check in `getDatabase`/`getAuth` sandbox arms; route `Reference`/`Auth` methods through the channel (`actAs: admin` pinned); keep local backends for in-process sandboxes | `packages/pyric-admin/src/database/index.ts`, `src/auth/index.ts` (+ a tiny channel type in `pyric/sandbox` or a pyric-tools peer dependency seam — decide: the brand + channel should live in a leaf module so pyric-admin doesn't import pyric-tools) | M |
| 6 | Optional worker op `auth.getUser` (else listUsers+filter) | `src/serve/worker/protocol.ts`, `host-auth.ts` | S |
| 7 | Docs + error-message polish ("open <url>") | — | S |

Overall slice-1 estimate: **M — roughly 3–5 focused days**, dominated
by items 2–5. The single design decision to settle first is where the
remote brand/channel interface lives so `pyric-admin` (which depends
only on `pyric` and `firebase-admin`) can recognize a handle
constructed by `pyric-tools` — a `Symbol.for('pyric.remote.sandbox')`
brand plus a structurally-typed channel interface declared in
`pyric/sandbox` types keeps the dependency direction clean.

### Slice 2 — Firestore / Storage / fuller surface

- Firestore admin + modular relay: worker ops already exist
  (`getDoc`…`txnCommit`, `admin.*` — protocol.ts:344–362); Node client
  SDK = re-target `serve/worker/client.ts`'s transport seam from
  `MessagePort` to the WS frames (the client is already engine-free and
  codec-complete). **L**
- Storage: read ops exist (`storage.listAll/getMetadata/getBlob`,
  protocol.ts:407–409); uploads need a new op + binary framing
  (base64 or WS binary frames). **M**
- Event-stream relay (`target:'events'`) with bounded backpressure, so
  Node consumers get `onEvent`/`history` mirrors. **M**
- `snapshot`/`loadSnapshot`/branch ops over the wire
  (`exportState`/`importState`/`saveBranch`… already exist as ops). **S**
- Auth session surface for the Node *client* SDK (per-connection
  sessions mirror the worker's per-port sessions, #754). **M**

### Test strategy

The worker host already runs headless: `handleMessage` is the
documented unit-test seam — existing tests build a real sandbox, fake
`{ postMessage }` ports, and drive the full op/sub lifecycle with **no
SharedWorker and no browser**
(`packages/pyric-tools/test/serve/worker/host.test.ts:1–27`, plus
`auth.test.ts`, `sub-lens.test.ts`, `per-port-sessions.test.ts`, …).

Layered characterization tests:

1. **In-process relay harness (no network):** a fake browser peer =
   a function that receives `worker-op`/`worker-sub` frames and calls
   `handleMessage(ctx, fakePort, …)` directly, piping the fake port's
   posts back as `worker-res`/`worker-snap`. Drives `createBridge` +
   `connectRemoteSandbox`'s core with an injected transport. Covers:
   op round-trips, sub initial fire + updates, unsub, peer replacement
   resubscribe, timeout, error relay (`__error` snap → rejected
   subscribe).
2. **Real-WS characterization:** stand up the actual bridge mount
   (`ws` server via `serve/bridge-mount.ts` path) with the harness peer
   on a real socket — locks the wire format.
3. **pyric-admin conformance:** run the existing
   `pyric-admin` database/auth test expectations (`database.test.ts`,
   `auth.test.ts`) against a remote-branded sandbox backed by the
   harness — the same assertions must pass locally and remotely (the
   compat-model pattern: one oracle, two backends).
4. **One manual end-to-end** against a real `pyric serve --bridge` +
   browser tab before calling the slice done (tab-refresh resubscribe
   is the scenario unit tests fake most heavily).

## Risks

1. **The zero-pyric-admin-change premise is false** (top risk, and a
   contradiction of the assumed design). RTDB/Auth sandbox backends are
   WeakMap-local; the remote design requires a dispatch change inside
   `pyric-admin/{database,auth}`. Contained (two files, additive arm),
   but it must be scoped into the gate, and the brand/channel interface
   placement decides the dependency graph.
2. **Behavioral upgrade is also behavioral change.** Today's local
   admin tree emits no events, evaluates no listeners, and is invisible
   to Studio; remote routing makes server writes emit events and fire
   app listeners. Desired — but the local in-process backend then
   *diverges* from the remote one (silent tree vs. live worker RTDB).
   Consider follow-up: rewire the local admin backend onto
   `pyric/database`'s sandbox backend too, so both arms share one tree
   and one event story.
3. **Tab-refresh + last-connection-wins.** In-flight ops fail on peer
   replacement for both the Node client and agent tools; transparent
   resubscribe needs generation tagging to avoid stale-snap delivery.
   Mitigation is designed (section 3) but is the fiddliest code in the
   slice.
4. **Sync `Sandbox` members are unimplementable remotely**
   (`admin.*`, `snapshot()`, `history()`, sync `currentUser` reads
   before handshake). Slice 1 sidesteps them (pyric-admin doesn't use
   them), but any consumer treating `RemoteSandbox` as a full `Sandbox`
   hits branded throws. Pre-npm is the moment to either split the
   interface or bless the throwing subset.
5. **Backpressure on event streams.** Safe for slice 1 (value subs
   coalesce); becomes real when the unified event stream is relayed in
   slice 2 — needs an explicit bound before that ships.
