---
title: "Firebase Functions RTDB integration compatibility"
navLabel: "Functions · RTDB"
group: "Conformance"
section: ""
order: 8010
---
<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

> **Climb status: this surface is climbing under CDD.**
> 13 of 13 rows conforming.
> A `?` row below is a target with a derived failing test, not a guarantee.

# Firebase Functions RTDB integration compatibility

> **Surface coverage:** integration contract (unchanged upstream source; breadth is the signed row inventory)
>
> **Fidelity:** 100% (13 of 13 tracked claims match production)
>
> The signed row inventory defines this integration contract. Fidelity shows how many of those tracked behaviors match production — see the [scoreboard](../pyric-conformance-scores/) for what that percentage does and does not mean.

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

<div class="compat-key">
<span class="compat-key-item"><span class="compat-dot" data-status="ok"></span><strong>Conforming</strong> — unchanged source matches production under replay</span>
<span class="compat-key-item"><span class="compat-dot" data-status="diverged"></span><strong>Diverged (documented)</strong> — intentional difference with a written reason</span>
<span class="compat-key-item"><span class="compat-dot" data-status="bug"></span><strong>Bug</strong> — should match production but does not</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unsupported"></span><strong>Unsupported</strong> — explicitly outside the implemented slice</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unverified"></span><strong>Unverified</strong> — production target or local replay is incomplete</span>
</div>

## `onValueCreated` delivery and event contract

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">A write that changes an exact matched RTDB location from absent to present invokes the handler once with a create CloudEvent and a DataSnapshot containing the created value.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-exact-create.json</code> (firebase-functions 7.2.5); production exact-create behavior. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#1</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">After the initial create delivery, changing or deleting that same matched value does not invoke an onValueCreated handler.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-exact-create.json</code>; update/delete produced no additional delivery in the bounded production scenario. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#2</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">A value that already exists when the trigger is deployed does not produce a historical create delivery.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-startup-existing.json</code>; pre-seeded value, zero delivery in the observation window. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#3</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">A named single-segment wildcard matches a created child and exposes the matched segment through event.params.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-wildcard-batches.json</code>; production populated caseId and itemId. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#4</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Creating an ancestor object invokes the wildcard handler once for each newly-present matching descendant.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-wildcard-batches.json</code>; one ancestor set delivered alpha and beta. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#5</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">When an ancestor write creates an exact matched descendant, the event snapshot is projected to that descendant rather than the ancestor object.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-descendant-projection.json</code>; leaf snapshot excluded its sibling. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#6</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">One multi-location update that creates multiple wildcard-matched children produces one create delivery for each child.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-wildcard-batches.json</code>; one update delivered delta and gamma. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#7</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The delivered DataSnapshot exposes the created value, key, existence, JSON projection, child lookup, child count, and child enumeration.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-exact-create.json</code>; frozen val/key/exists/toJSON/child enumeration shape. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#8</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The snapshot ref is an Admin DatabaseReference rooted at the matched path and can perform an awaited write from the handler.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-exact-create.json</code>; matched Admin ref completed the awaited sibling write. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#9</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">For the production Admin SDK write, the event exposes authType <code>unknown</code> and authId <code>null</code>.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-exact-create.json</code>. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#10</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">A Promise returned by the handler keeps the execution open through delayed asynchronous work and its awaited Admin write.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-exact-create.json</code>; capture logged only after the delayed Admin write completed. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#11</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">A handler that throws or returns a rejected Promise is reported by the managed runtime; with retry disabled, the Eventarc request can still be acknowledged with HTTP 200.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-failed-execution.json</code>; one managed-runtime error record contained the marker and the Eventarc request status was 200. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#12</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Sequential creates are all delivered; their observed arrival order is evidence, not an ordering guarantee.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>functions-rtdb-onvaluecreated-wildcard-batches.json</code>; all three arrived in observed order 2, 1, 3. Local replay: <code>packages/cli/test/functions-rtdb/oracle-conformance.test.ts</code> assertion set <code>functions-rtdb#13</code>.</div></div>
</details>
</div>
