<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

> **Climb status: this surface is climbing under CDD.**
> 0 of 13 rows conforming. 13 unverified.
> A `?` row below is a target with a derived failing test, not a guarantee.

# Firebase Functions RTDB integration compatibility

> **Surface coverage:** integration contract (unchanged upstream source; breadth is the signed row inventory)
>
> **Fidelity:** 0% (0 of 13 tracked claims match production)
>
> The signed row inventory defines this integration contract. Fidelity shows how many of those tracked behaviors match production — see the [scoreboard](../../../pyric/docs/conformance/SCORES.md) for what that percentage does and does not mean.

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

| # | Behavior | Status | Probe |
|---|---|---|---|
| 1 | A write that changes an exact matched RTDB location from absent to present invokes the handler once with a create CloudEvent and a DataSnapshot containing the created value. | ? | oracle: `functions-rtdb-onvaluecreated-exact-create.json` (firebase-functions 7.2.5); production observed, local Pyric replay not implemented. |
| 2 | After the initial create delivery, changing or deleting that same matched value does not invoke an onValueCreated handler. | ? | oracle: `functions-rtdb-onvaluecreated-exact-create.json`; update/delete produced no additional delivery in the bounded production scenario. |
| 3 | A value that already exists when the trigger is deployed does not produce a historical create delivery. | ? | oracle: `functions-rtdb-onvaluecreated-startup-existing.json`; pre-seeded value, zero delivery in the observation window. |
| 4 | A named single-segment wildcard matches a created child and exposes the matched segment through event.params. | ? | oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; production populated caseId and itemId. |
| 5 | Creating an ancestor object invokes the wildcard handler once for each newly-present matching descendant. | ? | oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; one ancestor set delivered alpha and beta. |
| 6 | When an ancestor write creates an exact matched descendant, the event snapshot is projected to that descendant rather than the ancestor object. | ? | oracle: `functions-rtdb-onvaluecreated-descendant-projection.json`; leaf snapshot excluded its sibling. |
| 7 | One multi-location update that creates multiple wildcard-matched children produces one create delivery for each child. | ? | oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; one update delivered delta and gamma. |
| 8 | The delivered DataSnapshot exposes the created value, key, existence, JSON projection, child lookup, child count, and child enumeration. | ? | oracle: `functions-rtdb-onvaluecreated-exact-create.json`; frozen val/key/exists/toJSON/child enumeration shape. |
| 9 | The snapshot ref is an Admin DatabaseReference rooted at the matched path and can perform an awaited write from the handler. | ? | oracle: `functions-rtdb-onvaluecreated-exact-create.json`; matched Admin ref completed the awaited sibling write. |
| 10 | For the production Admin SDK write, the event exposes authType `unknown` and authId `null`. | ? | oracle: `functions-rtdb-onvaluecreated-exact-create.json`. |
| 11 | A Promise returned by the handler keeps the execution open through delayed asynchronous work and its awaited Admin write. | ? | oracle: `functions-rtdb-onvaluecreated-exact-create.json`; capture logged only after the delayed Admin write completed. |
| 12 | A handler that throws or returns a rejected Promise is reported by the managed runtime; with retry disabled, the Eventarc request can still be acknowledged with HTTP 200. | ? | oracle: `functions-rtdb-onvaluecreated-failed-execution.json`; one managed-runtime error record contained the marker and the Eventarc request status was 200. |
| 13 | Sequential creates are all delivered; their observed arrival order is evidence, not an ordering guarantee. | ? | oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; all three arrived in observed order 2, 1, 3. |
