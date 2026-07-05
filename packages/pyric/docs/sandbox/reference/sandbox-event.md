# `SandboxEvent`

The discriminated union `sandbox.onEvent(cb)` delivers. Filter on `kind` to
recover any individual event family. The unified channel replaces the prior
`onRequest` / `onDenial` / `onSnapshotError` triplet.

## The union

```ts
type SandboxEvent =
  | RequestEvent              // kind: 'request'
  | WriteSandboxEvent         // kind: 'write'
  | SnapshotDeliveryEvent     // kind: 'snapshot_delivery'
  | SnapshotSuppressedEvent   // kind: 'snapshot_suppressed'
  | ListenerLifecycleEvent    // kind: 'listener_attach' | 'listener_detach' | 'listener_errored'
  | SessionBoundaryEvent;     // kind: 'session_boundary'
```

Every event carries `kind: <discriminator>`, `id: string` (unique within the sandbox process; React-list-key safe), and `at: number` (`Date.now()` at emission).

## `kind: 'request'` — every evaluated op

```ts
interface RequestEvent {
  kind: 'request';
  id: string;
  at: number;
  evalMs: number;
  method: 'get' | 'list' | 'create' | 'update' | 'set' | 'delete';
  path: string;
  auth: AuthState;
  result: 'allow' | 'deny' | 'unsupported';
  reasons: string[];
  request?: { resourceData?: Record<string, unknown> };
  resourceBefore?: { data: Record<string, unknown> | null; exists: boolean };
  resourceAfter?: { data: Record<string, unknown> | null; exists: boolean };
  matchedRule?: { ruleIndex: number; operations: string[] };
  origin: 'user' | 'listener' | 'transaction' | 'batch';
  groupId?: string;
  groupKind?: 'batch' | 'transaction';
  triggeredBy?: { method: string; path: string };
}
```

Fires once per simulator-evaluated op. Denials surface here with `result: 'deny'`; the previous `DenialEvent` shape lives on as a derived field-projection — filter `kind === 'request' && result === 'deny'` to recover it.

**`method`** preserves the caller's verb. `set` stays `'set'` (the rule engine maps it internally to `'create'` or `'update'` based on whether the doc exists; that mapping appears on `matchedRule.operations`).

**`origin`** disambiguates user-driven single ops from batch / transaction sub-ops and from listener re-evals. `groupId` is shared across the sub-ops of a single batch or transaction; `groupKind` tells you which.

**`triggeredBy`** populates on `origin: 'listener'` events when the listener re-eval was caused by a user op (write, batch, or transaction). Initial-fire events and `deployRules`-driven re-evals carry no `triggeredBy`.

**`evalMs`** is the wall-clock duration of `simulator.simulate(...)`. Sub-millisecond for trivial rules; a traffic-monitor validation probe measured ~95ms p99 on connect-four's deep boolean chains.

## `kind: 'write'` — committed writes only

```ts
interface WriteSandboxEvent {
  kind: 'write';
  id: string;
  at: number;
  method: 'create' | 'update' | 'set' | 'delete';
  path: string;
  auth: AuthState;
  data?: Record<string, unknown>;
  priorState: Record<string, unknown> | null;
  nextState: Record<string, unknown> | null;
  groupId?: string;
  groupKind?: 'batch' | 'transaction';
  sentinels?: Array<{ field: string; kind: 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete' }>;
  autoId?: string;
  requestTime: { seconds: number; nanoseconds: number };
}
```

Fires AFTER the corresponding `kind: 'request'` event for the same op, and ONLY for writes that the rule engine allowed AND the keyspace successfully applied. Denied or rolled-back writes don't emit a write event — they surface as `kind: 'request' && result: 'deny'` only.

**`data`** is the **pre-resolution** payload — the user's intent. `FieldValue.*` sentinels are preserved as their marker shapes (`{ __type: 'serverTimestamp' }`, etc.); plain values pass through unchanged. The replay engine re-resolves the markers against a fresh sandbox so `pinRequestTime: false` actually drifts and `pinRequestTime: true` matches capture. Absent on `delete`. The materialized values the keyspace applied live on `nextState`.

**`priorState`** / **`nextState`** are full **post-resolution** doc snapshots — actual stored state. `null` when the doc is absent. Use these for diff rendering, undo, or forensic logging.

**`sentinels`** is a flat index of the markers in `data`, keyed by field path (dotted with bracket-indices, `a.b[0].c`). Redundant with `data` (you could walk it yourself), but cheap to consume and emitted unconditionally when sentinels are present. Absent when the write had none.

**`autoId`** is the minted document ID (the path's last segment) when the write came from `collection.add()` / `LocalEnvironment.createWithAutoId`. The replay engine aliases this path to a fresh mint rather than reusing the original ID. Absent on explicit-ID writes.

**`requestTime`** pins the `request.time` the rule engine evaluated against — shape mirrors the Firestore Web SDK Timestamp (`{ seconds, nanoseconds }`). Required. The replay engine re-issues this exact value when re-resolving `serverTimestamp()` sentinels so resolved fields are bit-identical on replay; rules that branch on `request.time` evaluate identically. Within a batch or transaction, all sub-ops share the same `requestTime`.

## `kind: 'snapshot_delivery'` — listener callback fired

```ts
interface SnapshotDeliveryEvent {
  kind: 'snapshot_delivery';
  id: string;
  at: number;
  listenerId: string;
  target: { kind: 'doc'; path: string } | { kind: 'query'; collection: string };
  auth: AuthState;
  addedCount: number;
  modifiedCount: number;
  removedCount: number;
  size: number;
  sample?: {
    docs: Array<{ path: string; data: Record<string, unknown> | null }>;
  };
  triggeredBy?: { method: string; path: string };
}
```

Fires AFTER the user callback runs — corresponds 1:1 with actual snapshot deliveries.

**`addedCount` + `modifiedCount` + `removedCount`** match `QuerySnapshot.docChanges()`. Doc-target listeners report exactly one of (added=1, removed=1, modified=1) per fire. Query-target listeners can report any combination — initial fire surfaces every doc as `added`.

**`size`** is the doc count surfaced to the listener: `1` (exists) / `0` (deleted) for doc-target, `n` for query-target.

**`sample.docs`** carries the docs as the user callback received them, serialization-ready. Consumers truncate before persisting if scenarios produce large snapshots — the sandbox doesn't truncate itself.

**`triggeredBy`** absent on initial fire (no user op caused it) and on `deployRules`-driven re-evals.

## `kind: 'snapshot_suppressed'` — re-eval ran but didn't deliver

```ts
interface SnapshotSuppressedEvent {
  kind: 'snapshot_suppressed';
  id: string;
  at: number;
  listenerId: string;
  target: { kind: 'doc'; path: string } | { kind: 'query'; collection: string };
  auth: AuthState;
  reason: 'no-op';
  triggeredBy?: { method: string; path: string };
}
```

Fires when a listener wakes up on a write but the diff against the prior snapshot finds nothing observable changed — Slice 3's no-op suppression. Useful for "why didn't my listener fire" debugging.

**`reason`** is `'no-op'` in v1. The discriminator exists so future suppression sources (auth changes, rules changes mid-listen) can land without reshape.

## `kind: 'listener_attach' | 'listener_detach' | 'listener_errored'`

```ts
interface ListenerLifecycleEvent {
  kind: 'listener_attach' | 'listener_detach' | 'listener_errored';
  id: string;
  at: number;
  listenerId: string;
  target: { kind: 'doc'; path: string } | { kind: 'query'; collection: string };
  auth: AuthState;
  error?: {
    code: 'permission-denied';
    message: string;
    reasons?: string[];
  };
}
```

**`listener_attach`** fires once when `onSnapshot` registers a record, BEFORE the initial-snapshot delivery.

**`listener_detach`** fires once when the returned unsubscribe is called against a still-registered listener. Idempotent unsubscribes don't double-emit. Listeners dropped by `sandbox.reset()` don't emit detach — the `session_boundary` event covers the rollover.

**`listener_errored`** fires when a stream-level rule denial silently terminates the listener (initial-read denial, change-driven re-read denial, or `deployRules` flipping a listener allowed → denied). The listener stops delivering snapshots after this event and the user's `errorCallback` fires once with the same error.

**`error`** is populated on `listener_errored` only. The shape mirrors what the previous `SnapshotErrorEvent` carried.

## `kind: 'session_boundary'` — reset / dispose

```ts
interface SessionBoundaryEvent {
  kind: 'session_boundary';
  id: string;
  at: number;
  phase: 'reset' | 'dispose';
  priorOpCount: number;
}
```

Fires BEFORE the env swap on `sandbox.reset()` and BEFORE registry teardown on `sandbox.dispose()`. The subscription itself survives `reset()` — only `dispose()` clears it.

**`priorOpCount`** is the cumulative count of events emitted from this sandbox prior to the boundary. Useful for verifying a persisted stream's segmentation against the sandbox's own bookkeeping.

## Filter cookbook

```ts
// All denials (replaces the old onDenial channel).
const isDenial = (e: SandboxEvent): e is RequestEvent =>
  e.kind === 'request' && e.result === 'deny';

// Snapshot stream errors (replaces the old onSnapshotError channel).
const isStreamError = (e: SandboxEvent): e is ListenerLifecycleEvent =>
  e.kind === 'listener_errored';

// Every committed write (replaces tapping the internal EventLog).
const isCommittedWrite = (e: SandboxEvent): e is WriteSandboxEvent =>
  e.kind === 'write';

// Anything a listener delivered to user code.
const isLiveDelivery = (e: SandboxEvent): e is SnapshotDeliveryEvent =>
  e.kind === 'snapshot_delivery';
```

## See also

- [Observe sandbox events — how-to](../how-to/observe-events.md) — usage patterns + subscriber contract.
- [`Sandbox.onEvent`](./sandbox-and-context.md#onevent) — the method docs.
- design rationale — the rationale for replacing the three-channel surface with one.
