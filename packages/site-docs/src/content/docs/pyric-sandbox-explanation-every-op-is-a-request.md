---
title: "Every operation is a request"
group: "pyric / sandbox"
section: "Explanation"
order: 138
---
# Every operation is a request

The sandbox started with one observation channel, `onDenial`, and it surfaced the wrong subset of the truth. We expanded the surface to `onRequest`, then to a per-channel triplet (`onRequest` / `onDenial` / `onSnapshotError`), and finally collapsed them into one unified [`onEvent`](../pyric-sandbox-how-to-observe-events/). This page explains the conceptual arc, what it implies about how to think about sandbox traffic, and the trade-offs we made along the way.

## The original framing was too narrow

`onDenial` was built when the playground's most-visible failure mode was "the user wrote a rule that denied their own app." Showing the rejected operations was actionable: the agent could read the denial, see why, fix the rule. Allowed traffic was framed as *the happy path*: invisible, because everything was fine.

That framing held only as long as the sandbox was used for rule debugging. Two things broke it:

- **Listeners.** Once `onSnapshot` was wired in, every write fanned out into N listener re-evaluations. A listener silently dropping a doc because the read rule denied it had no surface. `onDenial` fired, but the consumer couldn't tell it from a "user-issued get denied" event.
- **Performance.** When connect-four's rules turned into 95ms eval p99 in validation, the question shifted from "did anything deny?" to "what's the rule engine doing with my time?" Allowed ops needed a surface too.

The reframe: **every op the simulator evaluates is a request worth seeing.** Denials are one filtered view. The full stream is the substrate; everything else (the denials panel, an audit log, a perf inspector) is a projection over it.

## Denials are now a filter, not a channel

The unified-channel rollout collapsed the prior three channels into one:
```
sandbox.onEvent         — every observable event
  ├ kind: 'request'
  │   └ filter result==='deny'  →  what onDenial used to deliver
  ├ kind: 'write'                  (committed writes only)
  ├ kind: 'snapshot_delivery'
  ├ kind: 'snapshot_suppressed'
  ├ kind: 'listener_attach' | 'listener_detach' | 'listener_errored'
  │   └ filter kind === 'listener_errored'  →  what onSnapshotError used to deliver
  └ kind: 'session_boundary'
```
One subscription, one mental model. A consumer that wants only denials filters `kind === 'request' && result === 'deny'`. The event carries strictly more information than the old `DenialEvent` did (`evalMs`, `origin`, `matchedRule`, `groupKind`, `groupId`).

## The substrate sits at the right layer

A reasonable alternative would have been to put the request channel in `pyric-admin`. That's where the data-plane operations live, after all. We rejected it. The reason: every adapter (`pyric-admin`, `pyric/firestore`, future `pyric/database`) bottoms out at `LocalEnvironment.execute`. Putting the channel on the substrate means:

- One subscription works regardless of which adapter the consumer uses.
- The data-plane adapters stay shape-faithful to their upstream SDKs. Neither `firebase-admin/firestore` nor `firebase/firestore` has an `onRequest`-like surface, and adding one would muddy the swap-in contract.
- A consumer that uses both adapters in one project doesn't have to wire two streams.

This is the same reasoning that put `onDenial` on the sandbox originally, and the same reasoning that kept `onEvent` there when the three channels collapsed. We're following the existing precedent.

## The listener-suppression trade-off

The single most consequential design decision in this work was about query listener fires.

When a query listener re-evaluates, the rules engine runs a `list` rule against the collection, then runs a `get` rule against each candidate doc to filter the visible set. Production Firestore does the same thing: unreadable docs silently never appear in the snapshot. A validation probe measured **252× amplification per write** in a worst-case load test. 500 writes against a query listener spawned 126,251 events, because each write triggered a query re-eval which internally re-evaluated each of N existing docs.

Two designs were on the table:

1. **Faithful.** Emit one `RequestEvent` per inner per-doc eval. The consumer sees every individual filter decision. Useful for "why was doc X filtered out?" debugging. Bad for the panel's volume.
2. **Suppressed.** Emit one event per outer `list` call; the inner per-doc evals are invisible. Matches the user's mental model: they issued one `onSnapshot`, they should see one event per fire. Good for the panel; loses the per-doc debugging signal.

We picked (2) for v1 with an instance-field flag (`insideListFilter`) suppressing the inner emits. Reasoning:

- The default panel UX is "see what's happening." Volume kills it. Without suppression, the 500-write load test would put 126k rows in the buffer, which no one can read.
- The signal that suppression hides ("doc X was visible to Alice but invisible to Bob") is a niche debugging case. Most consumers don't need it most of the time.
- The suppression is reversible. A future opt-in flag (`{ includeFilterEvents: true }` on the subscription) could expose them without breaking the default.

The asymmetry that remains: write-driven listener re-evals are visible (one `list` event per fire), but the per-doc decisions inside are not. The decision doc records this; the reference page notes it; the inner-doc filter visibility is on the v2 list.

## What about transactions?

Transactions get the `origin: 'transaction'` tag and shared `groupId`, the same as batches. But there's a subtler issue with transactions that's currently unmodelled.

Inside a `runTransaction` callback, the consumer calls `tx.get(ref)` to read docs. Those reads happen against the live state but don't currently flow through `LocalEnvironment.execute`. They go through a separate read path inside the `TransactionContext`. So a `tx.get(ref)` doesn't fire a `RequestEvent` today.

For v1 that's acceptable: transactions are rare in playground scenarios, and the *commit* (which does flow through the request channel as `origin: 'transaction'` events) gives the most useful signal. But it's a gap. The follow-up either threads the transaction read path through `execute` or adds a parallel emit site in the transaction context.

This is one of those decisions where the substrate's internal layering shows through the public API. The pragmatic call for v1 was "ship the writes-side of transactions, fix reads in a follow-up." A purist version would have done both at once.

## The buffer lives at the consumer

The sandbox doesn't keep history. `onEvent` is fire-and-forget. If no subscriber is attached, the event is never built. If a subscriber attaches mid-session, it only sees events from that point forward.

The decision-doc-locked design says: the **consumer** keeps a ring buffer (default 5000 events). The probe measured worst-case per-event size at ~625 bytes, so a 5000-cap buffer is ~3 MB in browser heap, comfortable. Pause/resume is a consumer concern: pause = stop appending; resume = re-attach.

Putting buffering in the sandbox would have meant:

- Memory shape baked into the substrate. Different consumers (a CLI logger vs. a browser UI vs. a test that records to NDJSON) want different cap sizes.
- A history-replay API surface. "Give me everything from event id #N" is a meaningful capability but it's distinct from "live stream"; baking both into one API conflates two concerns.
- A pause/resume semantics question with no good answer at the substrate level: does pause drop incoming, queue them, or block the simulator? Consumer-side, the answer is "drop them; we know we lost data during pause." Substrate-side, it would be a bug if the simulator blocked.

By keeping the substrate purely fire-and-forget, we kept it simple and let consumers compose the behaviour they need on top.

## Relationship to `MutationEvent`

`@inbrowser/agent` has its own append-only event log at `~/.pyric/projects/<id>/events.ndjson`, populated by `wrapMutating`. The shape there is `MutationEvent`:
```ts
interface MutationEvent {
  id: string;
  timestamp: string;
  agentId: string;
  toolName: string;
  phase: 'pre' | 'committed' | 'rolled-back';
  target: { kind: 'doc' | 'rules' | 'seed' | ... };
  input: unknown;
  output?: unknown;
  reverse?: ReverseOp;
}
```
`RequestEvent` and `MutationEvent` aren't the same thing, even though they overlap in spirit.

| | `RequestEvent` | `MutationEvent` |
|---|---|---|
| **Granularity** | Per simulator eval | Per agent tool call |
| **Storage** | In-memory only | Append-only NDJSON |
| **Lifetime** | Session-local | Persistent across sessions |
| **Purpose** | Live observability | Rollback + audit |
| **Generator** | `LocalEnvironment.execute` | `wrapMutating` |

A single agent tool call (e.g. `write_firestore_seed`) produces one `MutationEvent` but possibly many `RequestEvent`s, one per simulator op the underlying write fanned out into. The two channels are complementary: `RequestEvent` answers "what did the rules engine see?", `MutationEvent` answers "what did the agent do?"

Don't try to unify them. They serve different consumers, sit at different layers, and would lose precision if merged.

## The probe-driven design

This shape didn't fall out of a whiteboard session. Validation called out six empirical questions (V1-V6) about volume, eval cost, get-call density, allow/deny ratio, event size, and listener re-eval frequency, then instrumented the sandbox to produce the numbers.

The numbers drove specific design choices:

- **5000-event default buffer**: V5 said max 625 bytes per event, so 5000 caps at ~3 MB.
- **Drop `getCalls` from v1**: V3 said most rules don't `get()` at all, and rules that do average ≤1 call per evaluation. The runtime tracing cost wasn't worth the marginal data.
- **`evalMs` is a first-class column, not a details field**: V2 said connect-four sits at 95ms p99. That's user-perceptible. The column earns its place.
- **Default-hide listener traffic**: V1 and V6 said listener events are 94% to 99.6% of total volume in listener-heavy scenarios. Default-on would drown the user-origin signal.

If you're working on a related feature and need to make a similar call ("should we measure X?"), the lesson is: write a probe before writing a plan. The probe's numbers will rule out half the options you were considering.

## Limits worth knowing

A few specifics about what `RequestEvent` does and doesn't carry, useful when the panel surprises you.

### `auth.token` visibility

`event.auth` is whatever was passed into the simulator's `request.auth`. If a consumer set custom token claims on the op (`{ uid: 'alice', token: { admin: true } }`), `auth.token` shows up on the event. If the op was unauthenticated (`auth: null` at the substrate), `event.auth` is `null`, not an empty object. A rule that branches on `request.auth.token.x` and sees `undefined` produces a denial whose `reasons` will mention the token expression; the event itself doesn't separately surface "the token didn't have x." If you need claim-level audit, snapshot `auth.token` at op-issuance time before the request fires; the sandbox doesn't reconstruct it.

The flip side: a consumer that subscribes for security-audit purposes shouldn't assume `auth.token` is sanitised. The sandbox passes through whatever was set. If the consumer logs `RequestEvent`s long-term, claim contents (which may include PII) go with them.

### Multi-listener fanout multiplies events

`onSnapshot` listeners are independent registrations. Two doc listeners on the same path produce **two** listener-origin events per triggering write, not one. The reasoning: each listener has its own `auth` context and could see a different result (Alice's listener gets `allow`, Bob's gets `deny` for the same doc). Coalescing them would hide that. But it means a UI subscribing to "all writes to this collection" five times, perhaps by accident, multiplies its listener-event volume by 5.

If you're seeing more listener events than you expected, count distinct registrations first. The probe's `listener-storm` scenario (1 doc + 1 query listener, 50 writes = 802 events) shows what one-of-each looks like; double the listeners, double that number.

## What we'd revisit in v2

A few things in this v1 shape that we'd reconsider once consumers exist:

- **Inner per-doc filter visibility.** Opt-in flag for the "why was doc X filtered out" use case.
- **Transaction reads.** Plumb the transaction read path through the request channel.
- **Rule source positions.** `matchedRule.line` and `matchedRule.column` require upstream AST work in `pyric/rules`. The biggest single ergonomic win available, and the most invasive.
- **`getCalls` runtime tracing.** If a consumer says "I need to see the actual paths the rule visited," this is mechanical to add: patch the simulator's `resolveGet` to thread an array through `SimulationContext`. Currently skipped because no consumer asked.

None of these are blocking. They're notes for when someone needs them.

## Mental model

The shortest version of everything above: **the simulator evaluates ops; we made the evaluations observable.** The substrate fires one event per eval. Filtered views (denials, batches, transactions, listeners) are consumer-side projections. The shape is what the data is.
