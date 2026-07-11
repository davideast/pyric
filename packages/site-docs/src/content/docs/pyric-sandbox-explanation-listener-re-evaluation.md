---
title: "Listener re-evaluation on deployRules"
navLabel: "Listener re-evaluation"
group: "pyric / sandbox"
section: "Explanation"
order: 14021
---
# Listener re-evaluation on `deployRules`

A snapshot listener attached before a `deployRules` call gets re-evaluated under the new rules. This is a deliberate departure from production Firestore behaviour. The reasoning matters; this page lays it out.

## What production does

In production, a `cloud.firestore` ruleset change does **not** affect listeners that are already attached. The listener keeps using whatever rules were in force when it was created. Subsequent `deployRules` calls roll out for new listeners and new operations, but live streams continue with their original gating until the consumer detaches and re-attaches.

This matches how production thinks about rules deployment: deploys are eventually-consistent, propagation takes seconds to minutes, and a listener's evaluation context is captured at attach time.

## What the sandbox does

`pyric/sandbox` re-evaluates every active listener immediately after `deployRules` succeeds. Three cases:

- **Allowed → denied**: the listener is marked errored. Its `onError` callback fires (if provided); `onSnapshot` does not fire again. Once-per-stream error semantics.
- **Errored → allowed**: the `errored` flag clears and the listener fires as an initial snapshot. The consumer sees a fresh baseline.
- **Allowed → allowed**: behaves like a write-driven re-evaluation. Diff against the listener's last delivered snapshot; suppress if unchanged; fire if it changed.

For query listeners, the same logic applies per-doc: added / removed change entries surface as the readable doc set flips.

## Why diverge

The playground is the driving consumer. A user editing rules in the playground UI wants to see their UI react. If a listener doesn't re-evaluate when rules change:

- An over-permissive rule that the user is trying to tighten will still allow reads that should now deny.
- An over-restrictive rule that the user is loosening will still deny reads that should now allow.

Either way the UI shows stale state until the user manually refreshes. That breaks the "edit rules, see the effect" feedback loop the playground exists for.

For a unit-test consumer, the divergence rarely matters. Tests typically don't reconfigure rules mid-listener. But when they do, the sandbox's behaviour is what tests usually want. "Test that this rule blocks a read that was previously allowed" works without detach-reattach gymnastics.

## When this hurts

Two situations where production parity would be nicer:

- **Reproducing a production bug** where the symptom is "a listener kept its old gating". The sandbox can't reproduce this, because every rule change re-gates everything. You'd need the emulator or live Firestore.
- **Verifying eventual consistency**. The sandbox is synchronous; rules apply immediately. Production isn't; rules take propagation time. Tests that depend on the propagation window need a different tool.

Both are edge cases. Document them, route them to the right tool, leave the default behaviour where it serves the common case.

## What dispose does differently

`dispose` (called by `reset`) doesn't re-evaluate. It drops every listener registry. Subscribers that were live against the outgoing environment are gone; the new environment starts with no listeners. This is correct because `reset` is "wipe everything". Partial state would be confusing.

The distinction:

- **`deployRules`**: rules change, data stays, listeners stay (and re-evaluate).
- **`reset`**: data, rules, listeners, subscribers, all wiped. Fresh environment.
- **`dispose`**: keep data and rules, drop listeners and subscribers. Used when you're about to discard the sandbox.

## Implementation: iterate over a copy

The re-evaluation loop walks every active listener. A callback may add or remove listeners during the loop (React StrictMode does this routinely; HMR likewise). Iterating the map directly while it mutates is a bug.

The loop snapshots the listener IDs first, then checks `snapshotListeners.has(id)` per iteration:
```ts
const records = Array.from(this.snapshotListeners.values());
for (const record of records) {
  if (!this.snapshotListeners.has(record.id)) continue;  // unsubscribed mid-loop
  // ... re-evaluate
}
```
The same pattern appears in write-driven listener notification. The mutating-during-iteration risk is the same in both cases; the fix is the same.

## The "once-per-stream" error contract

Production: a snapshot listener that errors delivers the error exactly once, then receives no further snapshots. The listener stays subscribed from the consumer's view; the stream is dead.

The sandbox honours this. A listener that flips allowed → denied fires its `onError` once (if registered) and is marked `errored`. Subsequent re-evaluations under further rule changes that keep it denied don't re-fire the error. Re-allowed listeners clear the flag and fire a fresh initial snapshot.

This matters for UI code that displays "this listener failed". Without the once-per-stream rule, the same error would re-fire on every subsequent rule change, spamming the consumer.

## Stream errors vs. one-shot denials

Both surface through `sandbox.onEvent`, on different `kind` discriminators. The targets differ, which is why the event shapes differ:

- `kind: 'request' && result: 'deny'` is "an operation the consumer issued was denied." The consumer knows which operation; the event names `method`, `path`, `auth`, `reasons`.
- `kind: 'listener_errored'` is "a listener died without anyone calling it." The consumer might not know which listener, so the event carries a `listenerId` and a `target` discriminator (`doc` path or query collection) on top of the error payload.

A host UI that wants to surface every kind of denial subscribes once to `onEvent` and dispatches on `event.kind`.
