# 0019: Native bridge clients reconnect and restore their listeners

Status: Accepted

Date: 2026-10-07

Amended: 2026-10-14. Decision 7 now holds an operation issued while a client
reconnects instead of failing it, and binds the web hosted client too. See
[the amendment](#amendment-2026-10-14-operations-issued-while-reconnecting-are-held).

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
- There is no application-level liveness check. The bridge sends no `ping` to
  consumers, and the native clients send none. A network loss that the
  platform does not report leaves the socket half-open, and no gap is reported
  until the platform closes it. The Kotlin client's OkHttp transport sends
  WebSocket protocol pings every 30 seconds and detects that case; the Dart and
  Swift transports do not.
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
- **The liveness timer.** The web client sends `ping` every 15 seconds and
  treats 45 seconds without a frame as a drop.

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
