<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

> **Climb status: this surface is climbing under CDD.**
> 12 of 13 rows conforming. 1 unverified.
> A `?` row below is a target with a derived failing test, not a guarantee.

# Firebase Functions RTDB integration compatibility

<div class="compat-stat">
<p class="compat-stat-surface"><strong>Surface:</strong> integration contract <span>(unchanged upstream source; breadth is the signed row inventory)</span></p>
<p class="compat-stat-figure">
<span class="compat-stat-pct">92.3%</span>
<span class="compat-stat-label">of tracked behaviors conform</span>
</p>
<p class="compat-stat-denom">12 of 13 tracked behaviors</p>
<div class="compat-stat-bar" role="img" aria-label="Behavior distribution: 12 conform, 0 documented divergences, 0 bugs, 0 unsupported, 1 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 12" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unverified" style="flex-grow: 1" aria-hidden="true"></span>
</div>
<ul class="compat-stat-key" aria-label="Behavior state counts">
<li class="compat-stat-item"><span class="compat-dot" data-status="ok" aria-hidden="true"></span><span><strong>12</strong> conform</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="diverged" aria-hidden="true"></span><span><strong>0</strong> documented divergences</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="bug" aria-hidden="true"></span><span><strong>0</strong> bugs</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unsupported" aria-hidden="true"></span><span><strong>0</strong> unsupported</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unverified" aria-hidden="true"></span><span><strong>1</strong> unverified</span></li>
</ul>
<p class="compat-stat-note">The signed row inventory defines this integration contract. Fidelity measures how many tracked behaviors match production.</p>
</div>
[Read how the axes differ.](../../../pyric/docs/conformance/SCORES.md)

This matrix describes unchanged production source imported from
`firebase-functions/v2/database` and run against Pyric during development.
It is an integration/runtime contract, not a `pyric-functions` package mirror.

The first slice is intentionally narrow: Node, `onValueCreated`, one RTDB
instance, exact paths and named single-segment wildcards, serialized handler
execution within the current development session without a cross-event ordering
guarantee, and Admin-capable references on the event snapshot. Every row begins
unverified and remains a gap until its
production observation is replayed through the unchanged source against Pyric.

Explicitly deferred: other trigger types and Firebase products, retries,
deployed concurrency settings, multiple database instances, durable delivery
across restarts, deployment emulation, secrets, and production lifecycle
configuration.

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — unchanged source matches production under replay |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match production but does not |
| — | **Unsupported** — explicitly outside the implemented slice |
| ? | **Unverified** — production target or local replay is incomplete |

## `onValueCreated` delivery and event contract

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| onValueCreated(ref, handler) |  | A write that changes an exact matched RTDB location from absent to present invokes the handler once with a create CloudEvent and a DataSnapshot containing the created value. | ✓ | oracle: `functions-rtdb-onvaluecreated-exact-create.json` (firebase-functions 7.2.5); production exact-create behavior. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#1`. | 1 |
| onValueCreated(ref, handler) |  | After the initial create delivery, changing or deleting that same matched value does not invoke an onValueCreated handler. | ✓ | oracle: `functions-rtdb-onvaluecreated-exact-create.json`; update/delete produced no additional delivery in the bounded production scenario. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#2`. | 2 |
| onValueCreated(ref, handler) |  | A value that already exists when the trigger is deployed does not produce a historical create delivery. | ✓ | oracle: `functions-rtdb-onvaluecreated-startup-existing.json`; pre-seeded value, zero delivery in the observation window. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#3`. | 3 |
| onValueCreated(ref, handler) |  | A named single-segment wildcard matches a created child and exposes the matched segment through event.params. | ✓ | oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; production populated caseId and itemId. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#4`. | 4 |
| onValueCreated(ref, handler) |  | Creating an ancestor object invokes the wildcard handler once for each newly-present matching descendant. | ✓ | oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; one ancestor set delivered alpha and beta. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#5`. | 5 |
| onValueCreated(ref, handler) |  | When an ancestor write creates an exact matched descendant, the event snapshot is projected to that descendant rather than the ancestor object. | ✓ | oracle: `functions-rtdb-onvaluecreated-descendant-projection.json`; leaf snapshot excluded its sibling. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#6`. | 6 |
| onValueCreated(ref, handler) |  | One multi-location update that creates multiple wildcard-matched children produces one create delivery for each child. | ✓ | oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; one update delivered delta and gamma. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#7`. | 7 |
| DatabaseEvent.data |  | The delivered DataSnapshot exposes the created value, key, existence, JSON projection, child lookup, child count, and child enumeration. | ✓ | oracle: `functions-rtdb-onvaluecreated-exact-create.json`; frozen val/key/exists/toJSON/child enumeration shape. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#8`. | 8 |
| DatabaseEvent.data.ref |  | The snapshot ref is an Admin DatabaseReference rooted at the matched path and can perform an awaited write from the handler. | ✓ | oracle: `functions-rtdb-onvaluecreated-exact-create.json`; matched Admin ref completed the awaited sibling write. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#9`. | 9 |
| DatabaseEvent.authType / authId |  | For the production Admin SDK write, the event exposes authType `unknown` and authId `null`. | ✓ | oracle: `functions-rtdb-onvaluecreated-exact-create.json`. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#10`. | 10 |
| onValueCreated(ref, async handler) |  | A Promise returned by the handler keeps the execution open through delayed asynchronous work and its awaited Admin write. | ✓ | oracle: `functions-rtdb-onvaluecreated-exact-create.json`; capture logged only after the delayed Admin write completed. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#11`. | 11 |
| onValueCreated(ref, handler) |  | A handler that throws or returns a rejected Promise is reported by the managed runtime; with retry disabled, the Eventarc request can still be acknowledged with HTTP 200. | ? | oracle: `functions-rtdb-onvaluecreated-failed-execution.json`; Pyric observes the rejected handler and marker, but has no Eventarc HTTP request seam with which to replay the captured 200 acknowledgement. | 12 |
| onValueCreated(ref, handler) |  | Sequential creates are all delivered; their observed arrival order is evidence, not an ordering guarantee. | ✓ | oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; all three arrived in observed order 2, 1, 3. Local replay: `packages/cli/test/functions-rtdb/oracle-conformance.test.ts` assertion set `functions-rtdb#13`. | 13 |

## Current gaps

### Unverified

Tracked behavior whose available evidence does not yet establish the production result.

| API | Behavior |
|---|---|
| onValueCreated(ref, handler) | A handler that throws or returns a rejected Promise is reported by the managed runtime; with retry disabled, the Eventarc request can still be acknowledged with HTTP 200. |
