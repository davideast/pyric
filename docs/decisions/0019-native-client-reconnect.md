# 0019: Native bridge clients reconnect and restore their listeners

Status: Accepted

Date: 2026-10-07

Amended: 2026-10-14. Decision 7 now holds an operation issued while a client
reconnects instead of failing it, and binds the web hosted client too. See
[the amendment](#amendment-2026-10-14-operations-issued-while-reconnecting-are-held).

Amended: 2026-10-14. Every client sends a heartbeat and treats a silent socket
as a drop, the host runs a consumer's Realtime Database onDisconnect operations
when its socket closes, and the decision binds the Node remote client too. See
[the amendment](#amendment-2026-10-14-clients-send-a-heartbeat-and-a-closed-socket-runs-ondisconnect).

Amended: 2026-10-16. Every client serves `.info` locally, and an operation
issued when `.info/connected` turns true is sent on the new connection after
the restore, so an app can re-arm its onDisconnect operations. See
[the amendment](#amendment-2026-10-16-every-client-serves-info-locally).

Amended: 2026-10-17. An operation whose frame the transport refused, or that
the client had not yet handed to the transport when the socket dropped, is
held under decision 7 instead of failing. See
[the amendment](#amendment-2026-10-17-a-frame-that-never-left-the-device-is-held).

Amended: 2026-10-17. Every client follows one delivery contract for
operations and subscriptions: call order, settling once, close, registration
before return, delivery order, getters that match their streams, and
cancellation. See
[the amendment](#amendment-2026-10-17-one-delivery-contract-for-every-client).

## Context

The Dart (`packages/flutter-client`), Swift (`packages/swift-client`) and Kotlin
(`packages/kt-client`) clients each talk to the bridge over one WebSocket. When
that socket closes, all three fail every pending operation and every
subscription with `unavailable` and stay disconnected. A listener the app
registered never delivers again, even after the bridge is reachable. Swift's
`SnapshotSubscriptionCoordinator` re-subscribes only when the Auth lens
changes, not after a transport loss.

The web hosted client (`packages/cli/src/serve/worker/client/websocket-connection.ts`
and `core.ts`) already recovers: it retries with bounded backoff, re-attaches,
replays its observation subscriptions, restores Auth on a replaced host, and
fails requests that were in flight once without replaying them. Its first
connection can also retry (`retryInitialConnection`).

### What the bridge already supports

The native clients use the consumer relay leg of the bridge
(`packages/cli/src/bridge/server/peer.ts`, `createConsumerSession`), not the
`worker-port` leg the web client uses. On that leg:

- `attach` accepts `clientSessionId` (or its alias `sessionId`). The bridge
  adopts the requested id instead of minting one, and echoes it in
  `attach-ack.clientSessionId`. `attach-ack` also carries `hostInstanceId`,
  which is fixed for the life of the bridge process.
- When a consumer socket closes, `detach()` unsubscribes that socket's relayed
  subscriptions, fails its relayed operations still in flight, and removes it
  from presence. It does not send `worker-client-disconnect`, so the worker's
  virtual port for that `clientSessionId`, including its signed-in Auth user,
  survives the drop.
- Every relayed `worker-op` and `worker-sub` is stamped `resumeSession: true`,
  so a session the host marked closed is reopened by the next frame for it.
- `auth.restorePortSession { uid, tenantId }` is an ordinary worker operation,
  reachable over `worker-op`.

So re-attach, listener replay and Auth restore need no new frame and no new
field. The wire protocol does not change.

## Decision

All three clients implement one reconnect protocol in their bridge client
(`PyricBridgeClient` in each language).

1. **Connection states.** `connecting`, `attached`, `interrupted`, `closed`,
   exposed as a stream or flow. `closed` means no reconnect is scheduled. An
   explicit disconnect reaches it and is final. A failure that permits no retry
   also reaches it; each client then keeps its existing behavior for a later
   explicit `connect()` (the Dart client is disposed, as before; the Swift and
   Kotlin clients start a new attempt).

2. **When to retry.** After the first successful attach, any socket close or
   socket error starts a reconnect, except a close with code 1008 (policy),
   which closes the client. Before the first attach, a failed attempt closes the
   client unless it was constructed with `retryInitialConnection: true`, in
   which case the first connection retries on the same schedule. An
   `attach-ack` with `peerConnected: false` counts as a failed attempt, and so
   does an attempt that has not attached within 5 seconds of starting,
   including any Auth restore (the web client's attach deadline).

3. **Backoff schedule.** Attempt `n` (starting at 0, reset to 0 on every
   successful attach) waits
   `min(5000, base + jitter)` milliseconds, where
   `base = min(5000, 250 * 2^n)` and `jitter` is uniform in
   `[0, min(250, base / 10))`. That is 250, 500, 1000, 2000, 4000, then 5000 ms
   for every later attempt, each with up to 250 ms of jitter, never above
   5000 ms. This is the web client's schedule. Retries continue until the client
   is closed.

4. **Re-attach with `clientSessionId`.** Every attach after the first sends the
   `clientSessionId` from the previous `attach-ack`. Because the worker's
   virtual port for that id survives the drop, the session keeps its signed-in
   user, its tenant and any server-side per-session state.

5. **What is restored.**
   - **Listens.** Every subscription that is still live (Firestore document and
     query listeners, Realtime Database listeners, and the `authState` and
     `idToken` observers) is re-sent as a `worker-sub` frame with its original
     `subId` and its original payload, including the `actAs` lens it was opened
     with. The bridge cleared its own record of those `subId`s when the old
     socket closed, so reusing them does not collide.
   - **Auth.** On the same host, nothing is sent: the session's user is still
     on the host, and the re-sent `authState` and `idToken` observers deliver
     it. When `attach-ack.hostInstanceId` differs from the previous one, the
     host is a new process and holds no user for this session. Before any
     listener is re-sent, the client's Auth layer runs
     `auth.restorePortSession { uid, tenantId }` for the user it had signed in,
     as the web client does on a replaced host. If that operation fails, the
     observers deliver the host's state (signed out), and listeners are still
     restored. "Same host" means the same bridge process: `hostInstanceId`
     names the process, not the sandbox behind it. A sandbox peer replaced
     under the same bridge, such as a reloaded browser tab, is not detected,
     and the observers then report the session as signed out.
   - **Messaging.** The native clients expose no Messaging surface, so there is
     nothing to restore. A Messaging subscription added later is a subscription
     like any other and is restored by the listener replay above.

6. **How a gap is reported.** A gap is the time between the drop and the first
   snapshot after re-attach. Pyric does not replay what changed during it; it
   reports it the way the Firestore SDKs report going offline.
   - On the drop, every Firestore listener that has delivered a snapshot and
     was registered with `includeMetadataChanges: true` receives a fresh
     snapshot of the documents it last delivered, with
     `metadata.fromCache == true` and no document changes. `hasPendingWrites`
     keeps the value of the last frame the listener received rather than
     reporting false: production keeps pending writes visible while offline
     (observation `firestore-browser-lifecycle`,
     `offlineSnapshotHasPendingWrites: true`). The Swift and Kotlin clients
     rebuild the gap snapshot from that last frame, so their document and query
     gap snapshots carry its `hasPendingWrites`. The Dart client's gap mapping
     does not pass the frame's `hasPendingWrites` yet and reports false; that
     divergence remains open.
   - After re-attach, the re-sent listener's first snapshot arrives with
     `fromCache == false`, and its document changes are computed against the
     last snapshot the listener delivered, so writes made during the gap appear
     as `added`, `modified` or `removed`.
   - A listener registered without `includeMetadataChanges` receives neither the
     `fromCache` snapshot nor a restored snapshot whose content equals the last
     one it delivered, because production raises a change in sync state alone
     only to listeners that asked for metadata changes. The same rule applies
     to Realtime Database listeners and the Auth observers: a restored first
     value equal to the last delivered value is not raised again.

7. **Operations.** This decision binds all four clients: the three native
   clients and the web hosted client. An operation is in flight once the client
   has handed its frame to a socket. It is held while the client is not
   attached and has not sent it.
   - **In flight at the drop.** When the socket drops, every operation awaiting
     a `worker-res` fails once with `unavailable` and the message "The bridge
     connection was lost. Requests already sent may have completed; check state
     before retrying." It is never re-sent: the host may already have applied
     it.
   - **Issued while not attached.** An operation issued while the client is
     `connecting` or `interrupted` (or, on the web client, `restoring`) is held:
     neither sent nor failed. When the client next attaches, held operations are
     sent once, in the order they were issued, after every frame of the restore
     in decision 5. On a replaced host that means after Auth is restored, so the
     host evaluates each held operation under the identity the app had when it
     issued it. The client's own restore traffic is never held.
   - **Hold deadline.** An operation is held for at most 10 seconds from the
     moment it was issued. If the client has not attached by then, the
     operation fails once with `unavailable` and the message "The bridge
     connection was not restored within 10 seconds. The request was not sent."
     A later attach never sends it. Once a held operation is sent, its own
     timeout starts as for any other operation; the hold does not count against
     it.
   - **Replaced host.** Held operations survive a replaced host (a changed
     `hostInstanceId`, or on the web client a fresh session after its resume
     grant expired) and are sent to it once Auth is restored. If that restore
     fails, every held operation fails once with `unavailable` and is not sent.
     The web client already closes when its restore fails, so its held
     operations fail through the close rule below.
   - **Close.** An explicit disconnect or close, or a failure that permits no
     retry (decision 2), fails every held operation once with the error that
     client gives operations pending at close, and sends none of them.
   - **Reads and writes alike.** The rule does not distinguish reads, writes,
     Auth operations or transactions.
   - **Before the first attach.** The same rule applies. An operation issued
     before the first attach is held across attempts until the client attaches
     or 10 seconds pass. A client built without `retryInitialConnection` closes
     on its first failed attempt, so its held operations fail then. Holding an
     operation never starts an attempt ahead of the schedule, and an explicit
     `connect()` starts an attempt only when none is in progress or scheduled.
   - **Subscriptions.** A subscription opened while the client is not attached
     is not an operation and has no deadline. It is sent once when the client
     attaches, after the restored listeners, and is restored like any other from
     then on.

8. **Clients built on one supplied transport do not reconnect.** Swift's
   `init(channel:)` and Kotlin's `PyricBridgeClient(transport)` wrap a single
   transport that cannot be reopened. A drop on those fails pending operations
   and listeners with `unavailable` and schedules no reconnect. Reconnect
   requires the URL or a transport factory.

## Consequences

- A listener registered on a native client keeps delivering across any
  interruption that the platform reports as a socket close or error, such as a
  bridge restart, and an app can show an offline indicator from `fromCache`, as
  it would against production.
- As first accepted, there was no application-level liveness check. A network
  loss that the platform does not report left the socket half-open, and no gap
  was reported until the platform closed it; only the Kotlin client's OkHttp
  protocol pings detected that case. The heartbeat amendment below adds a
  check to every client.
- Kotlin query snapshots carry no document changes today, before or after a
  gap; this decision does not add them.
- A client can re-attach before the bridge has processed the old socket's
  close. The bridge settles a consumer socket's close against that socket only:
  it rejects the operations that socket dispatched and removes the presence
  entry only while it still belongs to that socket, so the re-attached session
  keeps its presence and its in-flight operations.

## What this decision leaves out

These parts of the web hosted client are not ported:

- **Auth restore on a fresh session.** The web client also restores Auth when
  its resume grant has expired and it attaches as a new session. The native
  clients have no resume grant; they always re-attach with the same
  `clientSessionId`, and restore Auth only on a changed `hostInstanceId`.
- **The liveness timer.** As first accepted, the web client's heartbeat was not
  ported. The heartbeat amendment below ports it to every client.

## Amendment (2026-10-14): operations issued while reconnecting are held

As first accepted, decision 7 failed an operation issued while the client was
`interrupted` at once with `unavailable`. A host restarted in place is back in
one to two seconds, and any app call made inside that window (`getDoc`,
`setDoc`, an Auth `getIdToken` behind a request header) threw although nothing
had been sent. Decision 7 now holds such an operation and sends it once after
re-attach, or fails it once at a deadline. Operations already in flight keep
the original rule. The web hosted client, which this decision first described
only as the reference, is bound by decision 7 as amended; it words both
messages with "The hosted sandbox connection" as it does today.

### The hold deadline is 10 seconds

- Reconnect attempts start about 0.25, 0.75, 1.75, 3.75 and 7.75 seconds after
  a drop (decision 3, before jitter and before the time each attempt takes). An
  operation issued at the drop waits through five attempts, which covers a host
  restarted in place with room to spare.
- Once backoff reaches its cap, an attempt takes at most 5 seconds (the attach
  deadline in decision 2) and the next starts at most 5 seconds later.
  Successive attempts therefore start at most 10 seconds apart, so every held
  operation is held across at least one attempt, wherever in the schedule it
  was issued.
- The web client's heartbeat (15 seconds) and liveness timeout (45 seconds) do
  not bound the hold. They detect a half-open socket while the client believes
  it is attached, and an operation issued then is sent and in flight, not held.
- The hold is well inside the host's 60-second session retention, so an
  operation held through a short drop normally reaches the session it was
  issued in.
- The production Firestore Web SDK uses the same figure: it reports the client
  offline when a stream attempt fails or 10 seconds pass without one
  succeeding (see the comparison below).

The deadline is a constant in each client, like the attach deadline. A client
may let tests pass a shorter value, as Kotlin's `attachTimeoutMs` already does.

### Held operations survive a replaced host, but not a lost identity

A held operation never reached any host, so sending it to a replaced host
cannot apply it twice. The app addresses the project, not a host process, and
the most common replacement is the restart this amendment exists for; failing
held operations there would bring back the errors the hold removes.

What a held operation must keep is its identity. It is sent only after Auth is
restored, so rules see the user and tenant the app had when it issued it. When
the restore fails, the host holds a signed-out session, and sending the
operation would evaluate it as a user the app never was; it fails instead. The
limit in decision 5 still applies: a sandbox peer replaced under the same
bridge is not detected, and an operation sent after that re-attach, held or
not, runs as signed out.

### Held operations follow the whole restore

Held operations are sent after the Auth restore, the Auth observers, the
listener replay and, on the web client, the Messaging restore. A held operation
then behaves exactly like one issued the instant after attach, and the restore
sequence is the same whether or not anything is held. The production Realtime
Database Web SDK orders its reconnect the same way: it re-sends Auth, then
listens, then queued writes, then queued reads. The order is frame order on one
socket. The host can finish a held write before or after a restored listener's
first snapshot; either way the listener reports it, inside the restored
snapshot's changes or in the next one. The web client currently sends its queue
before the listener replay, and moves it after.

### Reads and writes are treated alike, unlike production

What production does, verified in the Web SDK sources installed in this
repository (`@firebase/firestore` 4.14.1 and `@firebase/database` 1.1.3):

| Call while reconnecting | Production Web SDK | Pyric, as amended |
| --- | --- | --- |
| Firestore write (`setDoc`, `updateDoc`, batch `commit`) | Applied to the local cache at once. The promise resolves only when the backend acknowledges it; the typings state it "won't resolve while you're offline". No deadline. | Held, then sent once, or failed after 10 seconds. |
| Firestore `getDoc` | Waits while the online state is unknown. After one failed stream attempt or 10 seconds the client is offline; a document in the local cache is returned with `fromCache`, and one that is not fails with `unavailable` ("Failed to get document because the client is offline."). | Held, then sent once, or failed after 10 seconds. |
| Realtime Database write (`set`, `update`) | Queued, then sent after listens on reconnect. A write that was in flight at the drop is sent again. | Held, then sent once, or failed after 10 seconds. A write in flight at the drop fails and is not re-sent. |
| Realtime Database `get` | Answered from an active listener's value if there is one; otherwise waits for a connection with no client-side deadline. | Held, then sent once, or failed after 10 seconds. |

Not verified: the Android, iOS and Flutter Firebase SDKs, and transactions on
either product. This amendment assumes the native SDKs follow the same split
and makes no claim about offline transactions.

Production splits reads from writes because it has a local cache: the cache
answers reads, and latency compensation shows writes before the backend
accepts them. The pyric bridge clients have neither; every operation is
answered by the host. A held write has no local effect to show, and a held read
has no cache to answer from, so pyric cannot reproduce the split and applies
one rule. Reads land close to Firestore, which also fails an uncached read
within about 10 seconds. Writes diverge: production waits indefinitely, and
pyric fails a held write after 10 seconds. Without a local view, a write that
waits indefinitely gives the app no signal at all, while a bounded failure that
says the request was not sent is safe to retry. The Realtime Database's
re-sending of in-flight writes is not adopted; decision 7's never-resend rule
for operations in flight is unchanged.

### All four clients change

This decision exists so the clients behave alike. If only the web client held
operations, the same `getDoc` would wait on the web and throw on Android, iOS
and Flutter during the same restart. The three native clients share one shape
here: `op` throws when the client has attached before and is not connected now,
and otherwise awaits `connect()`. The change is local to that branch in each.
Clients built on one supplied transport (decision 8) close on a drop, so they
fail held operations through the close rule.

### Before the first attach follows the same rule

Decision 7 as first written failed an operation when the attempt it waited for
failed, and dropped it so a later attempt could not send it. That kept two
properties: an operation fails once, and an operation that failed is never
sent. The hold keeps both, and its deadline bounds the wait the old rule
bounded by a single attempt. One rule now covers the first connection and every
reconnect.

### Consequences of the amendment

- An app call made during a short drop waits up to 10 seconds and then
  succeeds or fails, instead of failing at once. An app that used the
  immediate `unavailable` as an offline signal should observe the connection
  state instead.
- A held operation that fails says it was not sent, so the app can retry it
  without checking state first. An operation in flight at the drop still says
  it may have completed.
- Held operations occupy memory and, on the web client, the per-client
  operation budget until they are sent or fail. The 10-second deadline bounds
  how long.

## Amendment (2026-10-14): clients send a heartbeat, and a closed socket runs onDisconnect

The Node host closes a socket that has sent a `ping` and then sends nothing for
90 seconds (#965), so a page frozen in the back-forward cache, a killed tab or
a sleeping laptop has its Realtime Database onDisconnect operations run. The
host starts that watch at a client's first `ping`, and as first accepted only
the web hosted client sent one. A half-open socket from a native client or the
Node remote client was never closed, so its listeners stayed registered and its
presence entry stayed in place until the platform closed the socket.

Closing the socket would not have been enough. When a consumer socket closes,
the bridge unsubscribes its listeners and fails its operations in flight, but
it sends the host nothing that runs the session's onDisconnect operations, and
none of these clients ever sends `worker-client-disconnect` (see the Context
above). A native client's onDisconnect operations therefore never ran on the
Node host: not after a clean close, not after the app was killed, only when the
host exited.

This amendment adds a heartbeat to every client and runs a consumer's
onDisconnect operations when its socket closes.

### Every client sends a heartbeat

- On each attach, a client sends `{ "type": "ping", "id": "<id>" }` at once,
  then every 15 seconds while it stays attached. The interval is the web
  client's (`HOSTED_HEARTBEAT_INTERVAL_MS`).
- The ping at attach is what starts the host's watch, so a client that is
  suspended within 15 seconds of attaching is still watched. The web client
  keeps its schedule; the host already watches it from attach.
- The heartbeat belongs to one socket. It starts on each attach, stops at the
  drop or the close, and never pings an old socket.
- The bridge already answers `ping` with `pong`. The wire protocol does not
  change.

### Forty-five seconds without a frame is a drop

- Before each heartbeat, a client that has received no frame of any kind for
  45 seconds (three heartbeats) treats the socket as dropped, as the web client
  does. Any frame counts, not only `pong`.
- The drop is decision 2's. The client goes to `interrupted` and reconnects on
  decision 3's schedule. Operations in flight fail once and are never re-sent,
  and operations issued after the drop are held under decision 7 as amended. A
  client built on one supplied transport (decision 8) closes instead.
- The check runs before the send. A client the platform suspended, such as an
  iOS app in the background, reconnects on its first heartbeat after it resumes
  instead of pinging a socket the host has already closed. Where the platform
  offers a clock that keeps running while the device sleeps, the client
  measures with it.
- The 15 and 45 seconds are constants in each client, like the hold deadline. A
  client may let tests pass shorter values.
- The Kotlin client's OkHttp transport keeps its WebSocket protocol pings every
  30 seconds. OkHttp fails the socket when a protocol pong does not arrive,
  which is an ordinary drop. The host does not count protocol pings as traffic;
  only application frames keep a watched socket open.

### The host's watch is unchanged

The host watches a socket from its first `ping` and closes it once
`HOST_PEER_LIVENESS_TIMEOUT_MS` (90 seconds, six heartbeats) passes with no
frame. A client that never pings, such as an app built before this amendment,
is not watched and is never closed for being quiet. Watching every socket from
attach would close such a client after every 90 idle seconds, and mobile app
builds routinely lag the host they connect to.

### A consumer socket's close runs its onDisconnect operations

- When a consumer socket closes, whether by a close frame, an error, or the host
  closing a silent socket, the bridge tells the host the session was
  interrupted, as it already does for the web client. The host runs the
  session's Realtime Database onDisconnect operations.
- The session survives. Its virtual port and its signed-in user stay on the
  host, and decision 4's re-attach is unchanged.
- This runs on every close, including one the client recovers from a second
  later, such as a host restarted in place. Production runs onDisconnect
  operations on every connection loss, and apps register them again from
  `.info/connected`.
- **A replaced socket runs nothing.** When the client has re-attached on a newer
  socket before the bridge processes the old socket's close (see Consequences
  above), the old socket no longer owns the session, and its close runs no
  onDisconnect operations. The operations belong to the session, not the
  socket, so running them then would discard what the re-attached client
  registered.
- This applies on the Node host. In bridge mode, where the sandbox runs in a
  browser tab, the tab's sandbox does not accept the interruption, so a
  consumer attached through it still runs no onDisconnect operations on close.
- The web hosted client is unchanged: its worker session already runs them.

### The Node remote client is bound too

`connectRemoteSandbox` and the lazy `remoteSandbox` handle that
`@pyric/cli/register` installs attach on the same consumer leg as the native
clients. The heartbeat, the 45-second check and the close rule all apply to
them.

- A drop takes the client's existing loss path. The lazy handle reconnects
  live listeners on decision 3's schedule and subscribes them again, and its
  next operation connects again. The eager handle ends its listeners with
  `unavailable`.
- The heartbeat's timers do not keep an idle Node process alive; a finished
  script still exits.
- Its operations keep their existing behavior. An operation issued on the lazy
  handle while it is reconnecting waits for the connection attempt in progress,
  or starts one, and fails if that attempt fails. This amendment does not
  extend decision 7's hold, across attempts with a 10-second deadline, to the
  Node remote client.
- `pyric-admin` does not implement onDisconnect, so an admin process registers
  none through it, and the close rule releases its listeners and its presence
  entry. An onDisconnect operation sent over the handle's raw relay channel
  (`channel.op`) is the same `worker-op` a native client sends, and the close
  rule runs it the same way.

### Consequences of the amendment

- A client that stops sending, whether frozen, suspended, or cut off by a
  network loss the platform does not report, is closed by the host within
  90 seconds. Its onDisconnect operations run, its listeners are released and
  it leaves presence. The client notices within 45 seconds that the host has
  stopped answering, and reconnects.
- A native app that is killed or closes its socket now has its onDisconnect
  operations run. Before this amendment they never ran on the Node host.
- A client built before this amendment sends no heartbeat and is still not
  watched, but its close now runs its onDisconnect operations, because that
  rule is in the host.
- A host restarted in place runs every connected client's onDisconnect
  operations, so presence goes offline. An app registers them again from
  `.info/connected`, which every client serves under
  [the 2026-10-16 amendment](#amendment-2026-10-16-every-client-serves-info-locally).
- Each attached client sends one small frame every 15 seconds.

## Amendment (2026-10-16): every client serves `.info` locally

A host restarted in place runs every connected client's onDisconnect
operations (the amendment above), and the new host instance holds none of
them. Production apps register them again when `.info/connected` turns true,
as the Firebase presence sample does. The web hosted client serves
`.info/connected` from its socket. The native clients send `.info` listeners to
the host as ordinary subscriptions, and the host answers `connected: true` at
all times, so an app on them never sees the reconnect and never re-arms
([#990](https://github.com/davideast/pyric/issues/990)).

This amendment is the contract every client follows. The web hosted client
already meets it. The Kotlin, Swift and Dart clients follow in their own
changes, each with its own conformance rows.

### Which paths are served

`.info` is a client-side tree in every production SDK: the Android, iOS and
JavaScript Repos each keep their own and write `connected = false` when they
are built. Every Pyric client serves these paths itself:

| Path | Value |
| --- | --- |
| `/.info/connected` | `true` or `false` |
| `/.info/serverTimeOffset` | `0` |
| `/.info` | `{ connected, serverTimeOffset: 0 }` |
| any other path under `/.info` | `null` |

A path is under `/.info` when its first segment is `.info`, the test
`isInfoPath` in `packages/pyric/src/database/writable-path.ts` applies. Value,
single-event and child listeners and one-time reads on these paths are answered
by the client. They never reach the host and are not replayed on re-attach.

### When the value changes

- A listener receives the current value when it is registered, which is `false`
  before the first attach, as in production.
- After that, `connected` changes only when the connection state does. It turns
  `false` when the client is `interrupted` or `closed`, or when `goOffline()`
  turns the database's network flag off. It turns `true` when the client is
  `attached` and the database is online. Repeated values are not delivered.
- `connected` is per database instance, as the web client's
  `observeRtdbConnection` keeps it.

### An operation issued on `true` follows the restore

An operation issued from the callback that sees `connected` turn `true`, such
as an onDisconnect registration, is sent on the new socket after the whole
restore in decision 5 and after every operation held under decision 7.

- The web hosted client raises `true` after that sequence: Auth restore,
  listener replay, Messaging restore, then the held operations.
- The native clients raise it when they reach `attached`. Each already sends an
  operation issued from that callback behind the restore and the held queue,
  so `true` is derived from the existing `attached` state and the state
  machine does not change.
- Production differs by SDK in the same way. Android and iOS raise `true`
  before the restore when the app has an Auth token, and queue an onDisconnect
  registered then until the restore completes. The JavaScript SDK raises it
  after the restore. In every SDK the registration reaches the server on the
  new connection, after the restore.

`packages/cli/test/serve/worker/client/rtdb-info-connected-order.test.ts` pins
the web client's order.

### The host keeps the re-registration

- The host chains the onDisconnect operations it runs for an old socket ahead
  of every later frame for that session (`owned.pending` in
  `packages/cli/src/serve/hosted/runtime.ts`). A registration the re-attached
  client sends on `true` is never consumed by the old socket's drain, and the
  next close runs it. `packages/cli/test/serve/fixtures/hosted-sqlite-rearm-after-interrupt.ts`
  pins this for a native client's `worker-op` and a page's worker port.
- A replaced socket's close runs nothing (the amendment above), so the
  registration also survives a close the bridge processes after the re-attach.
- On a Vite dev server restart, the replacement closes the old host before it
  opens the store, and that close waits for every session's onDisconnect
  operations and flushes them. The restarted host therefore reads the values
  they wrote. `test/apps/presence-rearms-after-restart` drives this through the
  dev server: an app that does not re-arm reads `offline` after a restart, one
  that re-arms reads `online`, and closing the page then runs the
  re-registration.

### What is not ported

- Production clients apply their own onDisconnect operations to their local
  cache when the connection drops. Pyric clients have no cache, and listeners
  report the host's value after re-attach.
- `serverTimeOffset` is always `0`. The bridge handshake carries no server
  timestamp. Production delivers no offset until its first handshake.
- Android's `.info/authenticated` is not served.
- Android's 60-second idle disconnect is not modeled.
- Kotlin opens one connection per database URL. Swift and Dart share one
  connection per app, so `.info/connected` on every database follows that
  shared socket.
- A replaced host whose Auth restore fails still reports `true`. Production
  also keeps connected and authenticated apart; the app's re-registration then
  runs signed out, and the rules decide it.
- Writes under `.info` are refused by the host (`invalidInfoWrite`). The
  native clients do not yet refuse them before sending, as production SDKs do.

### Consequences of the amendment

- An app that re-arms presence from `.info/connected`, as the Firebase docs
  show, stays `online` across a host restart once its client meets this
  contract. The web hosted client does today; the native clients do once their
  changes land.
- An app that writes its presence only once goes `offline` on every host
  restart and stays there, as it would in production after a reconnect.

## Amendment (2026-10-17): a frame that never left the device is held

Decision 7 defines an operation as in flight once the client has handed its
frame to a socket. As first written, each native client also failed two kinds
of operation as if they were in flight: one whose frame the transport refused,
and one whose frame was still queued in the client when the drop was processed
([#1033](https://github.com/davideast/pyric/issues/1033)). Neither frame left
the device, so the host cannot have applied either.

This amendment is the contract the native clients follow. The Kotlin and Swift
clients change in their own pull requests. The Dart client keeps its behavior
and adds a test that pins it in its own pull request. The web hosted client
does not change.

- **Not handed over is not sent.** Such an operation is held under decision 7
  as amended on 2026-10-14. It is sent once after the next attach's restore, or
  fails once at the hold deadline, measured from when the app issued it.
- **What counts as a refusal.** A refusal is a positive signal that the
  transport did not take the frame. On Kotlin, `BridgeTransport.send` returns
  false (OkHttp returns false only when it did not enqueue the frame), or there
  is no current transport. On Swift, there is no current transport, or the
  built-in `URLSessionWebSocketTransport` throws `WebSocketSendRefusedError`,
  which it does when its task is no longer running before the send. That error
  has `package` access, so a custom `WebSocketTransport` cannot signal a
  refusal, and any error it throws leaves the operation in flight. Any other
  send error, and any frame the transport accepted, means the operation is in
  flight. If the socket then drops, the operation fails once with the
  connection-lost message and is never re-sent.
- **Order.** A held operation keeps the place it was admitted in. Operations
  that were refused or never written are sent in admission order, ahead of
  every operation held after the drop. After a re-attach, the client releases
  held operations only once every send started before the drop has returned.
- **A refusal is not a drop.** The socket's close still decides whether the
  client reconnects (decision 2), and a refused operation waits for that close.
  If the close permits no retry, or the app disconnects, the operation fails
  once with that error, like any held operation.
- **Unchanged.** On a client built on one supplied transport (decision 8), a
  refused operation fails as before. Restore traffic is never held, so a
  refused Auth restore operation fails the restore.
- **Subscriptions.** A subscription whose `worker-sub` frame is refused stays
  registered, and the next attach's restore sends it, as decision 7 already
  does for a subscription opened while not attached.
- **Where a refusal cannot be seen.** The Dart client and the web hosted client
  write through sinks that drop a frame on a closing socket without reporting
  it: `web_socket_channel`'s `GuaranteeChannel` and `AdapterWebSocketChannel`,
  and the browser `WebSocket.send`. They cannot tell a dropped frame from a
  lost one, so such an operation still fails as in flight. This is the safe
  direction: no client re-sends a frame the host may have seen.
- **Production.** The Android, iOS and JavaScript Realtime Database SDKs keep
  every unacknowledged put and re-send it on reconnect, and cancel only a
  transaction put already marked sent, "since we don't know if our sent
  transactions succeeded or not". The Firestore SDKs write every
  unacknowledged batch again after the next handshake. Pyric keeps decision
  7's rule that an operation in flight is never re-sent, and applies the
  sent/unsent split to every operation.

## Amendment (2026-10-17): one delivery contract for every client

Each earlier amendment fixed one property of the path from an app's call to
the host's reply, and each fix found the next unstated one: write order
([#1026](https://github.com/davideast/pyric/issues/1026),
[#1032](https://github.com/davideast/pyric/issues/1032)), a frame that never
left the device ([#1033](https://github.com/davideast/pyric/issues/1033)), and
a stream registered from inside a task. An audit of the four clients against
the rules those fixes assumed found violations of every rule on at least one
client. This amendment states the rules once. They bind the four clients that
decision 7 binds: Kotlin, Swift, Dart and the web hosted client.

An operation is any request that awaits a `worker-res`: a Realtime Database,
Firestore, Storage, Messaging or Auth call, an onDisconnect operation, a batch
commit or a transaction step. A subscription is any `worker-sub`, and any
stream the client produces locally that app code or the client's own layers
listen to, such as Auth observers, `.info`, the connection state, and the
debug and lens streams. Each rule has a label so that a pull request can cite
it.

### Operations

- **D1. Call order.** Two operations that the app issues in program order on
  one client reach the host in that order. This holds across services and
  whether the operations are sent at once, held, or released after a
  re-attach. A client never moves a send onto a task, coroutine, queue or
  microtask whose start order can differ from the issue order.
- **D2. Fate decided at the call.** By the time the call returns, the
  operation has been sent, admitted to the hold queue, or failed. On Dart and
  the web client that means before its first `await`, on Kotlin before its
  first suspension, and on Swift within the caller's turn. Which thread the
  scheduler runs first never changes the outcome.
- **D3. Settled exactly once.** Every operation completes once, with a result
  or an error. That includes a reply that races a timeout, a drop, a close or
  a cancellation, an app callback that throws, and a reply for an id already
  settled. No operation waits on a thread that its own reply needs.
- **D4. Drop classification.** This is decision 7 as amended earlier today. An
  operation whose frame the transport took fails once with the
  connection-lost message and is never sent again, including by a
  transaction's retry loop. One whose frame was refused or never handed over
  is held.
- **D5. Release order.** After a re-attach the client sends, in this order:
  the restore (Auth on a replaced host, then the restored listeners in the
  order they were opened), then subscriptions opened while not attached, then
  held operations in the order they were admitted. Release starts only after
  every send started before the drop has returned.
- **D6. Close.** An explicit close, or a failure that permits no retry,
  fails every pending and held operation once with that client's close error,
  sends none of them, and ends every subscription once. A client that closed
  after a failure with no retry does not reopen until the app calls
  `connect()`. After close returns, nothing is delivered to app code.

### Subscriptions and streams

- **D7. Registered before the call returns.** A subscription, observer or
  stream is in the client's routing table before the call that creates it
  returns. A stream the client creates lazily is registered before the first
  frame or local event it could receive. An event that arrives after that
  point is delivered, never dropped because registration was still running on
  another task.
- **D8. Delivery order, without loss.** Events for one subscription reach app
  code in the order their frames arrived or their local events happened, and
  none is dropped because the app is slow to consume them. Two subscriptions
  fed from one socket keep their relative order. A connection state stream,
  and `.info/connected`, report every transition, including a drop and
  re-attach that complete while the app is still handling an earlier event.
- **D9. Getters match their streams.** A synchronous getter that mirrors a
  stream, such as `currentUser`, the current lens or the connection state,
  never reports a value older than the last one the stream delivered. The
  stream never delivers a value older than one the getter has already
  reported. An operation that reads such a value, such as the lens it acts
  as, reads the value the last setter call stored.
- **D10. Cancellation.** Cancelling a subscription sends `worker-unsub` once,
  and only if its `worker-sub` was sent. Nothing reaches app code after the
  cancel returns. The subscription leaves the restore set, including when it
  is cancelled while the client is not attached. Cancelling a stream and
  listening to it again gives a working subscription.

### Tests

- **T1. No timing oracles.** A test observes order and state through events,
  continuations or explicit gates. It never relies on a sleep, a fixed delay,
  or a poll of state that another thread can change between the poll and the
  assertion. A test that a fix touches moves to gates in the same change.

### Consequences of the amendment

- The audit's findings land as fixes grouped by rule, in one pull request per
  affected client. Each one cites the rules it brings its client into line
  with, and its tests are written from the audit's probes, with gates instead
  of sleeps.
- D3 and D4 are fixed first, because they can apply a write twice or hang a
  client: a Firestore transaction retry that re-sends a commit that was in
  flight, an RTDB transaction completion that runs twice, and a
  completion-form Firestore transaction that blocks the threads its own reply
  needs.
- A pull request that adds an entry point or a stream on any client states
  which of D1 to D10 it was checked against.
