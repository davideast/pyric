---
title: "How to replay a captured event stream"
navLabel: "Replay events"
group: "pyric / sandbox"
section: "How-to"
order: 13006
---
# How to replay a captured event stream

The sandbox captures every `SandboxEvent` it emits. Hand the captured stream to `replay(events, rules)` from `pyric/sandbox` and the engine re-issues every write against a fresh sandbox, classifying the differences against an optional snapshot of the original state.

## When to use this

| You want to | Reach for |
|---|---|
| Verify the same writes produce the same state on a new project | `replay(events, rules, opts, originalState)` |
| Reconstruct a sandbox at a point-in-time from a persisted log | `replay(events, rules)`; ignore divergences, use the returned sandbox |
| Find when a rule change broke a captured session | replay against the new rules; look for `real-divergence` |
| Debug "why did `serverTimestamp()` resolve differently" | check `time-drift` divergences (turn off `pinRequestTime` if you want to see the drift) |

## Capture
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';

const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
db.setRules(RULES);

// ... do work ...
await db.collection('notes').doc('a').set({ ts: FieldValue.serverTimestamp() });

// Snapshot the event stream + the resulting state.
const events = sandbox.history();
const state = sandbox.snapshot().firestore ?? {};

// Persist `events` and `state` wherever you want (file, Firebase Storage, etc).
```
`sandbox.history()` returns a defensive copy of every `SandboxEvent` the sandbox has emitted: request, write, snapshot delivery, listener lifecycle, session_boundary. The replay engine only consumes `kind: 'write'` events; the rest pass through untouched (useful if you persist the full log for diagnostic purposes).

The captured `request.resourceData` and `write.data` ship **pre-resolution**. `FieldValue.serverTimestamp()` arrives as `{ __type: 'serverTimestamp' }`, not a materialized Timestamp; `FieldValue.increment(1)` arrives as `{ __type: 'increment', value: 1 }`, etc. This is what lets the replay engine re-resolve them against a fresh sandbox (and lets `pinRequestTime` actually do something). `write.priorState` / `write.nextState` carry the **post-resolution** values, the actual stored state at that moment.

## Replay
```ts
import { replay } from 'pyric/sandbox';

const { sandbox: replayed, divergences, pathAliases } = replay(
  events,
  RULES,
  { pinRequestTime: true },   // default — matches captured serverTimestamp() values
  state,                      // optional — enables divergence classification
);
```
The function builds a fresh sandbox with the same rules, walks every captured write, re-issues it (with sentinels intact), and, if you passed `state`, diffs the replayed final state against it.

## Classify divergences

The `divergences` array is a discriminated union. Filter on `kind` and handle each case. `real-divergence` is the only kind that signals an actual bug; the others are intentional by-design differences (auto-id minting, clock drift on unpinned replay, sentinel resolution against a different prior).
```ts
const real = divergences.filter((d) => d.kind === 'real-divergence');
expect(real).toHaveLength(0);    // typical CI assertion
```
See the [`Divergence` reference](../pyric-sandbox-reference-divergences/) for the full union shape, per-kind semantics, and field-path syntax.

## `pinRequestTime`: the default that prevents flake

Every `WriteSandboxEvent` carries the exact `request.time` the rule engine evaluated against. With `pinRequestTime: true` (default), the engine re-issues that `Timestamp` to the fresh sandbox so:

- `serverTimestamp()` sentinels resolve to the same value as capture (no `time-drift`).
- Rules that branch on `request.time` (e.g., `allow write: if request.time >= timestamp.date(2024, 1, 1);`) evaluate identically.

Turn it off when you *want* to test "does the captured stream still pass under today's clock?" That catches rules that depend on a time that's now in the past.

## Auto-IDs alias to fresh mints

Writes that originated from `collection.add()` / `LocalEnvironment.createWithAutoId` carry `autoId: '<mintedSegment>'` on the event. On replay the engine calls `createWithAutoId` again, mints a fresh ID, and records the alias in `pathAliases`. Two consequences:

- The replayed sandbox holds the doc at a *different* path than the original.
- The diff classifier treats those paths as `autoid-alias`, not `real-divergence`.

Consumers that index by path (a UI showing "doc X exists") should consult `pathAliases` to map original → replayed.

## Limitations (v1)

- Pinned `requestTime` works for `execute` only. Replaying writes that were originally part of a batch or transaction currently re-creates a fresh `serverTime` for those op-groups. If your captured stream is heavy on batch/tx writes that touch `serverTimestamp()`, expect small `time-drift` entries, usually harmless because they share a single time within the group.
- `sandbox.history()` has no cap in v1. Long-running sandboxes accumulate. If memory becomes an issue, snapshot + `reset()` to roll over (the closing `session_boundary` event marks the boundary cleanly).
- The replay engine doesn't currently replay `request` events with denials, only the writes. Consumers that want to surface "this captured op was denied on replay" can correlate `events.filter(e => e.kind === 'request' && e.result === 'deny')` against the replay's `divergences` list.

## See also

- [`Divergence` reference](../pyric-sandbox-reference-divergences/): the union shape and per-kind semantics.
- [`SandboxEvent` reference](../pyric-sandbox-reference-sandbox-event/): field-by-field for each event kind.
- [Observe sandbox events](../pyric-sandbox-how-to-observe-events/): the live channel (`onEvent`) that feeds into `history()`.
