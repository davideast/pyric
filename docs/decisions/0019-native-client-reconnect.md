# 0019: Native bridge clients reconnect and restore their listeners

Status: Accepted

Date: 2026-10-07

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

7. **Operations in flight.** When the socket drops, every operation awaiting a
   `worker-res` fails once with `unavailable` and the message "The bridge
   connection was lost. Requests already sent may have completed; check state
   before retrying." It is never re-sent: the host may already have applied it.
   An operation issued while the client is `interrupted` fails at once with
   `unavailable`. Before the first attach, an operation waits for the attempt
   in progress or, while a retry is scheduled, for the next scheduled attempt;
   it never starts an attempt ahead of the schedule. If that attempt fails, the
   operation fails once with `unavailable` and is not sent by a later attempt.
   Subscriptions opened before the first attach are sent when it succeeds. An
   explicit `connect()` follows the same rule: it starts an attempt only when
   none is in progress or scheduled.

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
