---
title: "Divergence"
group: "pyric / sandbox"
section: "Reference"
order: 110
---
# `Divergence`

What `replay(events, rules, opts, originalState)` returns when the replayed state doesn't perfectly match the captured state. A discriminated union; filter on `kind` to handle each case.

> **API reference:** the `Divergence` type is generated from source in the
> [`pyric/sandbox` API reference](../../../_generated/pyric-sandbox-reference-api.md).
> This page documents the classifier contract each `kind` encodes.

## What is a divergence?

A divergence is a single classified difference between what the original sandbox stored and what the replayed sandbox produced after re-issuing every captured write.

When the engine sees a difference, it tries to *explain* it from captured metadata (which fields had `FieldValue.*` sentinels, which paths came from auto-id minting, which `request.time` the rule engine evaluated against). Each explanation maps to a `kind`. If no explanation fits, the kind is `real-divergence`, the only kind that signals an actual bug. The other three are intentional by-design differences.

Two design rules govern the classifier:

1. **No shape inference.** The engine never guesses based on what a value *looks* like. A timestamp-shaped object isn't classified as `time-drift` unless the captured `sentinels[]` says it came from `serverTimestamp()`. Anything not licensed by captured metadata is `real-divergence`.
2. **Leaf-precise.** The engine walks both documents recursively and reports field paths at the leaf (`profile.lastSeen`, `tags[0]`, `arr[2].nested`). A sentinel-bearing parent doesn't mask sibling changes.

## The union
```ts
type Divergence =
  | {
      kind: 'sentinel-drift';
      path: string;
      field: string;
      sentinelKind: 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete';
      before: unknown;
      after: unknown;
    }
  | { kind: 'autoid-alias'; originalPath: string; replayedPath: string }
  | { kind: 'time-drift';     path: string; field: string;  before: unknown; after: unknown }
  | { kind: 'real-divergence';path: string; field?: string; before: unknown; after: unknown };
```
## `kind: 'autoid-alias'`

A write that originated from `LocalEnvironment.createWithAutoId` minted a fresh document ID on replay: same content, different path.
```ts
{ kind: 'autoid-alias', originalPath: 'notes/Iy5CGRl0HlP1XZo4GGiI', replayedPath: 'notes/5MM3PdzWUQvqRCi3wthO' }
```
Re-using the original ID would be incorrect: auto-id semantics include "the id is unique." Two replays of the same log on different sandboxes legitimately mint different ids. The engine emits one alias entry per such write and exposes the full mapping on `ReplayResult.pathAliases` so consumers that index by path can map original → replayed.

Not a bug. Consumers comparing document presence should consult `pathAliases` before flagging "missing doc."

## `kind: 'sentinel-drift'`

A captured `FieldValue.*` sentinel (other than `serverTimestamp`, which has its own kind) sits at this exact field path, and the subtree differs between original and replayed state.
```ts
{
  kind: 'sentinel-drift',
  path: 'counters/x',
  field: 'count',
  sentinelKind: 'increment',
  before: 5,
  after: 7,
}
```
Usually means **the prior state differed**, not that the sentinel itself misbehaved. `increment`, `arrayUnion`, `arrayRemove`, and `deleteField` are deterministic given the same prior. If their result differs, the prior was different. Look for an upstream `real-divergence` that explains why.

In practice, with the same captured stream replayed onto a fresh sandbox, sentinel-drift is rare. It surfaces most often when you replay onto state that *isn't* the captured starting point (e.g., partial replays, splicing two logs).

## `kind: 'time-drift'`

A captured `serverTimestamp()` sentinel at this exact field path resolved to a different `Timestamp` on replay.
```ts
{
  kind: 'time-drift',
  path: 'notes/stamped',
  field: 'ts',
  before: { __type: 'timestamp', seconds: 1778955966, nanos: 624000000 },
  after:  { __type: 'timestamp', seconds: 1778955966, nanos: 657000000 },
}
```
Only fires when `pinRequestTime: false`. With the default `pinRequestTime: true`, the engine re-issues the captured `request.time` to the fresh sandbox so the sentinel resolves to the same value: zero `time-drift`.

Not a bug. Useful for two scenarios:

- **Rules that branch on `request.time`**. Turn pinning off and see whether a captured stream that passed yesterday still passes today. If a rule like `allow write: if request.time >= timestamp.date(2024, 1, 1)` started failing, you'd see denied writes surface as `real-divergence` rather than `time-drift` (the time-drift signals "yes, time moved" without it being a bug).
- **Debugging "why is my serverTimestamp different"**. The `before` / `after` values show exactly how far the clock drifted.

## `kind: 'real-divergence'`

Anything else. Captured metadata doesn't license this difference, so the engine flags it.
```ts
{
  kind: 'real-divergence',
  path: 'notes/x',
  field: 'profile.name',
  before: 'alice',
  after: 'NOT-alice',
}
```
The `field` may be absent. For example, when an entire document is present on one side and missing on the other, the path alone identifies the divergence:
```ts
{ kind: 'real-divergence', path: 'notes/x', before: { /* doc */ }, after: undefined }
```
This is the only kind that signals an actual bug. Common causes:

- **Rules changed between capture and replay**: a write that succeeded originally gets denied; the doc is missing in replayed state.
- **A captured write hit a sandbox feature that isn't deterministic**: the engine's contract says writes are deterministic given the same prior + rules + clock; if you see real-divergence on a clean replay, something is non-deterministic in the path you're testing.
- **Replay state seeded incorrectly**: if you persisted state separately from events and they drift apart, fields can disagree.

## Classifying in code
```ts
for (const d of divergences) {
  switch (d.kind) {
    case 'autoid-alias':
      // Intentional: map d.originalPath → d.replayedPath in your index.
      break;
    case 'sentinel-drift':
      console.warn(`${d.path}.${d.field} drifted (${d.sentinelKind}): ${d.before} → ${d.after}`);
      break;
    case 'time-drift':
      console.warn(`${d.path}.${d.field} drifted via serverTimestamp`);
      break;
    case 'real-divergence':
      console.error(`real divergence at ${d.path}${d.field ? '.' + d.field : ''}: ${d.before} → ${d.after}`);
      break;
  }
}
```
A typical CI assertion: `expect(divergences.filter(d => d.kind === 'real-divergence')).toHaveLength(0)`.

## Field-path syntax

`path` is the document path (`notes/x`). `field` is a dotted/bracket-indexed leaf path within the document:

| field | meaning |
|---|---|
| `name` | top-level key |
| `profile.lastSeen` | nested object key |
| `tags[0]` | array element |
| `history[2].at` | nested key inside an array element |

This matches the `field` shape on captured `WriteSandboxEvent.sentinels[]`, so sentinel-vs-divergence comparisons are exact-string matches without any path normalization.

## See also

- [How-to: Replay a captured event stream](../how-to/replay-events.md): capture / replay / classify workflow.
- [`SandboxEvent` reference](./sandbox-event.md): the events `sandbox.history()` returns, including `WriteSandboxEvent.sentinels`.
- [`packages/pyric/src/sandbox/replay/index.ts`](../../../src/sandbox/replay/index.ts): the classifier source; file header documents the contract.
