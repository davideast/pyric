---
title: "pyric/database compatibility matrix"
navLabel: "Realtime Database"
group: "Conformance"
section: ""
order: 8006
---
<!-- Generated from the conformance model (registry rows + surface contracts). Do not edit by hand; run bun run compat:generate. -->

# `pyric/database` compatibility matrix

<div class="compat-stat">
<p class="compat-stat-figure">
<span class="compat-stat-pct">79.5%</span>
<span class="compat-stat-label">of public runtime exports supported</span>
</p>
<p class="compat-stat-denom">35 of 44 public runtime exports <span aria-hidden="true">·</span> 8 of 15 public type exports</p>
</div>
[See public API coverage for every service.](../pyric-conformance-scores/)

> ⚠ **EXPERIMENTAL — not v1-supported.** The v1-supported, conformance-held surface is **auth + firestore + rules**. The modular `firebase/database` mirror rows below are verified sandbox-side by unit probes, but most are not yet captured against a live production project. Do not depend on RTDB parity for a production swap yet.

`pyric/database` is the sandbox-only modular mirror. Package resolution selects it during Pyric development; production code continues to import the unchanged `firebase/database` package. The mirror never dispatches to production at runtime.

The pure RTDB rules engine remains on the unstable `pyric/rules/internal/rtdb` seam for simulator, replay, grammar, and constraints consumers. Its compiled rules tree carries no service or database environment metadata. Production data access and deployment are intentionally absent.

## Status legend

<div class="compat-key">
<span class="compat-key-item"><span class="compat-dot" data-status="ok"></span><strong>Conforming</strong> — observable behavior matches Firebase, locked by a passing probe</span>
<span class="compat-key-item"><span class="compat-dot" data-status="diverged"></span><strong>Diverged (documented)</strong> — intentional difference with a written reason</span>
<span class="compat-key-item"><span class="compat-dot" data-status="bug"></span><strong>Bug</strong> — should match Firebase but does not</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unsupported"></span><strong>Unsupported</strong> — not implemented or intentionally outside the mirror</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unverified"></span><strong>Unverified</strong> — not yet backed by sufficient evidence</span>
</div>

Probe references: `unit:<file>` means a Bun test under `packages/pyric/test/database/`; `oracle:<name>` cites a recorded observation under `packages/conformance/observations/`.

---

## Archived production-toolkit observations

These unsupported tombstones preserve immutable oracle `rowIds` for the removed host, REST, data, crawl, generation, and deployment toolkit. They are historical evidence, not current API claims.

<div class="compat-list">
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed REST host</code><span class="compat-sub"><span class="compat-behavior">Historical <code>.json</code> REST transport contract for the removed production host.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical admin read and set/get behavior for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observations; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical user read return shape for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical rules-denial normalization for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observations; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical rules-denied read behavior for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical set/get round trip for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical set-null removal behavior for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical rules-denied write behavior for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical multi-path update behavior for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical push key behavior for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical push auto-ID format for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical remove-versus-set-null behavior for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub"><span class="compat-behavior">Historical idempotent removal behavior for the removed production data handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed rules fetch handler</code><span class="compat-sub"><span class="compat-behavior">Historical deployed-rules JSON round trip for the removed production fetch handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed rules deployment handler</code><span class="compat-sub"><span class="compat-behavior">Historical rules deployment propagation timing for the removed production deploy handler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">Removed REST crawler</code><span class="compat-sub"><span class="compat-behavior">Historical shallow REST response shape for the removed production crawler.</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Archived oracle observation; implementation removed.</div></div>
</details>
</div>

## `simulateRtdbRules(compiled, input)` — in-process rule evaluator

<div class="compat-list">
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior">The removed stateful simulator returned a generate-before-simulate error when no IR had been generated</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">The stateless <code>simulateRtdbRules(compiled, input)</code> API requires a compiled rules tree and has no generate-before-simulate lifecycle.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior">Returns <code>{ success: false, error: { code: 'INVALID_INPUT' } }</code> when input doesn't parse against <code>SimulationInputSchema</code> (e.g. path missing leading slash, operation not in read / write / validate)</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior">Walks ancestors from root → target; the first ancestor whose rule expression evaluates to <code>true</code> grants access — matches RTDB's documented "rules cascade from root, true at any ancestor grants" semantics</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior">Path variables (<code>$userId</code>) are bound from the URL path and exposed in <code>pathVariableBindings</code> (also without the <code>$</code> prefix for ergonomic access in expressions)</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior"><code>auth</code> context: when <code>null</code>, <code>auth</code> is null inside expressions; when present, <code>auth.uid</code> and <code>auth.token.*</code> are bound</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:simulation/handler.test.ts</code>, <code>unit:grammar/simulator.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior"><code>mockData</code> becomes the value of <code>data</code> at every path during evaluation; <code>newData</code> is the proposed value for write/validate</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior"><code>data.child("…")</code>, <code>data.parent()</code>, <code>data.exists()</code>, <code>data.val()</code> evaluate against the in-process snapshot — matches the documented <code>DataSnapshot</code> rule-context surface</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:grammar/simulator.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior">Cross-path <code>root.child(…).val()</code> reads return <code>null</code> for paths NOT present in <code>mockData</code> — divergence from real prod rules where the engine reads the live database</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: the simulator uses ONLY what's in <code>mockData</code>. Real rules engine reads from the live RTDB. Documented in <code>validated.ts</code> ("simulation uses empty mockData, so cross-path rule lookups … will evaluate as false")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior">An expression that fails to parse (<code>parsed.valid === false</code>) produces an unsupported result rather than silently granting or fabricating a deny</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior">When no ancestor rule allows, the result is <code>{ allowed: false }</code> with <code>matchedPath</code> set to the deepest matched node</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior">When NO ancestor has a rule for the operation at all, returns <code>{ success: false, error: { code: 'NO_MATCHING_RULE' } }</code></span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior">Evaluation errors (grammar mismatch, unknown identifier) surface as <code>EVALUATION_ERROR</code></span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub"><span class="compat-behavior">Simulator's allow/deny decision matches the real RTDB rules engine for the same <code>{ rules, mockData, auth, operation, path, newData }</code> tuple, modulo the documented cross-path divergence on row #66</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-simulator-vs-prod-agreement.json</code> — 8 test rules × 29 (rule, op) tuples; 28 agreements, 1 disagreement at capture time (<code>r4-validate-structure</code>: the simulator did not evaluate <code>.validate</code> on writes). The <code>.validate</code> walk is now implemented (<code>src/rules/rtdb/simulation/handler.ts</code>, reached from all backend write sites; grammar array-literals + <code>hasChildren(keys)</code> fixed alongside), closing the recorded disagreement — replayed as prod-conforming denial in <code>oracle-conformance.test.ts</code>. The frozen capture documents the historical divergence</div></div>
</details>
</div>

## Constraint authoring surface (`atoms` / `policies` / `compose` / `ruleset`)

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>atoms</code> exports the documented set of primitive predicates (<code>authenticated</code>, <code>ownPath</code>, <code>ownField</code>, <code>isNew</code>, <code>hasChildren</code>, <code>hasChild</code>, <code>fieldIsString/Number/Boolean</code>, <code>fieldEnum</code>, <code>immutable</code>, <code>immutableSelf</code>, <code>rootExists</code>, <code>rootEquals</code>) — each returns an <code>Expr</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:constraints/atoms.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>policies</code> exports composite predicates that compose atoms: <code>pathOwnerOnly</code>, <code>fieldOwnerOnly</code>, <code>ownerOrNew</code>, <code>hasRole</code>, <code>isMember</code>, <code>required</code>, <code>transition</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:constraints/policies.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>compose</code> exports the boolean combinators <code>all</code>, <code>any</code>, <code>not</code>, <code>deny</code>, <code>always</code>, plus the raw <code>expr</code> constructor</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:constraints/compose.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>ruleset(...)</code> builds an environment-independent compiled RTDB rules tree from path definitions + expression objects</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:constraints/ruleset.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Game-domain helpers (<code>turnGuard</code>, <code>flip</code>, <code>winCheckHelper</code>) compose into legal rule expressions</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:constraints/game.test.ts</code></div></div>
</details>
</div>

## Compiled RTDB rules tree ↔ rules JSON

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">compileRtdbRules</code><span class="compat-sub"><span class="compat-behavior"><code>compileRtdbRules(rulesJson)</code> produces an environment-independent tree where each node carries its path, parsed expressions, and child nodes</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:compiled-rules.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">serializeRtdbRules</code><span class="compat-sub"><span class="compat-behavior"><code>serializeRtdbRules(compiled)</code> produces the Firebase rules-JSON payload for the compiled tree</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:compiled-rules.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">compileRtdbRules / serializeRtdbRules</code><span class="compat-sub"><span class="compat-behavior">Round-trip <code>compileRtdbRules(serializeRtdbRules(compiled))</code> produces an equivalent rules tree (locked path/expression-text equality, not object identity)</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:compiled-rules.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">compileRtdbRules / serializeRtdbRules</code><span class="compat-sub"><span class="compat-behavior">Path-variable segments (<code>$userId</code>, <code>$gameId</code>) preserved across the round-trip</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:compiled-rules.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">compileRtdbRules / serializeRtdbRules</code><span class="compat-sub"><span class="compat-behavior"><code>.indexOn</code> arrays preserved across the round-trip</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:compiled-rules.test.ts</code></div></div>
</details>
</div>

---

## Modular SDK surface

`pyric/database` is the sandbox-only mirror of `firebase/database`'s
tree-shakable free-function shape (`getDatabase`, `ref`, `child`, `get`,
`set`, `update`, `remove`, `push`, listeners, queries, transactions, and
sentinels). Package resolution selects production or sandbox before either
module loads; this mirror has no production target or runtime dependency on
`firebase/database`.

Two sandbox identity modes are selected by the value passed to
`getDatabase`:

- **Sandbox** — `getDatabase(ctx: SandboxContext)`. Frozen identity baked into
  the handle at construction.
- **Sandbox-live** — `getDatabase(sandbox: Sandbox)`. Identity read per
  operation from `sandbox.currentUser`.

The implementation lives in `packages/pyric/src/database/modular.ts`; the
in-process backend lives in `packages/pyric/src/database/sandbox/`. Rows below
are scoped to the modular mirror. The pure rules-engine rows above are internal
tooling coverage and are not exports of `pyric/database`.

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>getDatabase(ctx)</code> builds a sandbox-target <code>Database</code>; frozen <code>ctx.auth</code> baked in</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("getDatabase(ctx) returns a tagged Database handle")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>getDatabase(sandbox)</code> builds a sandbox-live target; reads <code>sandbox.currentUser</code> per op</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("reads sandbox.currentUser at op time, not at getDatabase time")</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior">An in-module production target is intentionally absent; direct calls with a real <code>FirebaseApp</code> reject with package-resolution guidance</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular.test.ts</code>; production remains the responsibility of the unchanged <code>firebase/database</code> package</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>ref(db, path?)</code> returns a path-tagged <code>DatabaseReference</code>; default is root</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("ref(db) returns a root ref" + "ref(db, ...) returns a path ref")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>child(ref, 'sub/path')</code> composes paths; result inherits the parent's target</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("child(ref, 'sub') composes paths")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>ref.parent</code> returns the parent ref; <code>root.parent === null</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("ref.parent returns the parent ref; root.parent is null")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>ref.root</code> returns the root ref of the same target</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("ref.root returns the root ref")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>get(ref)</code> returns a <code>DataSnapshot</code>-shaped object with <code>val()</code>, <code>exists()</code>, <code>key</code>, <code>child()</code>, <code>hasChildren()</code>, <code>numChildren()</code>, <code>toJSON()</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> (snapshot shape tests)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>get</code> on an absent path resolves to <code>{ val: null, exists: false }</code> (matches <code>DataSnapshot.val()</code> contract)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("reads return null for an absent path")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>set(ref, value)</code> replaces the value at the path</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("round-trips a primitive value" + "round-trips nested objects"); matches oracle observation <code>packages/conformance/observations/rtdb/rtdb-set-then-get-roundtrip.json</code> (prod observation blocked on rules; sandbox locks the contract directly)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>set(ref, null)</code> deletes the subtree at the path</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("set(ref, null) deletes the path"); matches oracle observation <code>packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>remove(ref)</code> is equivalent to <code>set(ref, null)</code> (same end state)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("remove and set(null) produce identical end-state"); matches oracle observation <code>packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>update(ref, patch)</code> shallow-merges top-level keys at the ref's path</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("shallow-merges top-level keys")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>null</code> value in a shallow update deletes that key</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("null values in a shallow update delete the key")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>update(rootRef, { '/a/x': v1, '/b/y': v2 })</code> is a multi-path atomic write — all paths land or none do</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:upstream-rtdb-probes.test.ts</code> ("one update nulls, mutates, and displaces within a limitToFirst window") + <code>unit:modular/sandbox-target.test.ts</code> (atomic multipath + rules denial); matches the matrix #23 prod contract</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Overlapping multi-path updates (one path is a descendant of another) reject before any path is written</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("rejects overlapping paths")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>push(ref)</code> mints a 20-char auto-id key starting with <code>-</code>, lexicographically sortable</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("mints 20-char keys starting with \"-\"" + "sequential push keys are lex-sortable"); matches oracle observation <code>packages/conformance/observations/rtdb/rtdb-push-autoid-format.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>push(ref, value)</code> writes <code>value</code> at the new child path</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("push(ref, value) writes the value at the new child path")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>pushKey()</code> mints a fresh push-shaped key without writing — used by callers building multi-path updates that need the key first</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("pushKey() mints a fresh key without writing")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>serverTimestamp()</code> returns the <code>{ ".sv": "timestamp" }</code> sentinel marker the wire encoder recognises</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("serverTimestamp() returns the documented shape"); matches the prod wire contract</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>serverTimestamp()</code> resolves to a number (epoch ms) on read-back</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("resolves to a number on read-back"); matches oracle observation <code>packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json</code> (prod observation blocked on rules; sandbox locks the contract directly)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>serverTimestamp()</code> sentinels resolve when nested inside multi-path update payloads</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("resolves sentinels nested deep inside an update payload")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Rules-denied write throws a plain <code>Error</code> (NOT a <code>FirebaseError</code>) with <code>.code === 'PERMISSION_DENIED'</code> (uppercase snake-case) and <code>.message === 'PERMISSION_DENIED: Permission denied'</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("rules-denied set throws a plain Error with PERMISSION_DENIED code"); matches oracle observation <code>packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json</code> (against blockingfun, fb-js-sdk 12.13.0)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Rules-denied read throws the same plain-<code>Error</code> <code>PERMISSION_DENIED</code> shape as a denied write</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("rules-denied get throws the same plain Error shape"); matches oracle observation <code>packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Rules-denied remove throws the same plain-<code>Error</code> <code>PERMISSION_DENIED</code> shape</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("rules-denied remove throws the same plain Error shape")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onValue(ref, cb)</code> fires immediately on subscribe with the current value at the path</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("fires on subscribe with the current value")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onValue</code> fires again after every write that CHANGES the value at the watched path; a write that leaves the watched subtree byte-identical (a no-change re-write, or an ancestor/descendant write that doesn't alter this path) is suppressed (DB-B8)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("fires after every write that touches the watched path") + <code>unit:modular/no-change-suppression.test.ts</code> ("re-writing the same value does NOT re-fire" + "ancestor write leaving the subtree unchanged does NOT fire")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onValue</code> fires after a descendant write (the listener sees subtree changes)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("fires on a descendant write")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onValue</code> initial-fire for an absent path delivers <code>val=null, exists=false</code> (matches matrix expectation locked by oracle for sentinel/listener shape)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("absent path: initial fire delivers val=null, exists=false")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The <code>onValue</code> return value is an unsubscribe function; calling it stops further fires</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("fires after every write that touches the watched path" — checks unsubscribed listener doesn't fire on subsequent write)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onChildAdded</code> / <code>onChildChanged</code> / <code>onChildRemoved</code> / <code>onChildMoved</code> — plain-ref subscription surface</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Tier 2: sandbox aligned with oracle observations under <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onchild*.json</code>. See M41–M48 for the per-event behavioral claims.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onChildAdded</code> replays each existing direct child of the parent ref on subscribe (one fire per existing key)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("replays existing direct children on subscribe — one fire per key"); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-initial-replay.json</code> (seeded <code>{k1,k2,k3}</code>, observed <code>firedKeys: ['k1','k2','k3']</code>).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">After subscribe, <code>onChildAdded</code> fires exactly once per new direct child write; snapshot carries <code>{key, val}</code> of the new child</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("fires exactly once per NEW direct child after subscribe"); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-post-subscribe.json</code> (<code>postSubscribeFires: 1</code>, <code>lastFire: {key:'k3', val:{v:3}}</code>).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onChildChanged</code> has NO initial replay; fires once when an existing direct child's value transitions; snapshot carries the NEW value</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("does NOT fire on subscribe (no initial replay)" + "fires once when an existing child transitions to a new value; snapshot carries NEW val"); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onchildchanged-fires-on-update.json</code> (<code>firedOnInitial: 0, firedOnUpdate: 1, lastFire: {key:'k1', val:{v:2}}</code>).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onChildChanged</code> does NOT fire for added or removed children — those go to the other event listeners</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("does NOT fire when a child is added" + "does NOT fire when a child is removed").</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onChildRemoved</code> has NO initial replay; fires once when a direct child is deleted (via <code>remove(child)</code> or <code>set(child, null)</code>); snapshot carries the PRIOR (now-removed) value</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:upstream-rtdb-probes.test.ts</code> (parent wipe fan-out via remove(parent) / set(parent, scalar)) + <code>unit:modular/sandbox-child-events.test.ts</code> (single-child delete carries PRIOR val); matches oracle <code>rtdb-modular-onchildremoved-fires-on-delete.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onChildMoved</code> on a plain ref (no <code>query(_, orderBy*)</code>) NEVER fires — per RTDB docs, child_moved emits only under ordered queries</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("does NOT fire on a plain ref (no ordering)"); matches the upstream contract observed under ordered-query in <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onchildmoved-with-orderby.json</code> (where ordered-query did fire — Tier 3 will wire that path; Tier 2 locks the plain-ref no-fire case).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>off(ref)</code> (no event type) removes ALL listeners at that ref — value + every child event variety</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("off(ref) removes ALL listeners at the ref" + "off(ref) also removes value listeners at the same path"); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-off-stops-child-fires.json</code> (<code>postOffFires: 0</code>).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>off(ref, eventType?, callback?)</code> variants: <code>off(ref, 'value')</code> / <code>off(ref, 'child_added')</code> / <code>off(ref, eventType, cb)</code> remove the targeted subset; returned-unsubscribe from <code>onChild*</code> is equivalent to <code>off(ref, eventType, cb)</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("off(ref, \"child_added\") removes only that event variety" + "off(ref, \"value\") removes only value listeners" + "off(ref, eventType, cb) removes only the matching callback" + "returned-unsubscribe from onChildAdded is functionally equivalent to off()").</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>connectDatabaseEmulator(db, host, port)</code> is a no-op on sandbox targets (the sandbox IS a local emulator)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("is a no-op on sandbox handles")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>sandbox.setRules(db, rulesJson)</code> deploys rules to the in-process simulator; <code>setRules(db, null)</code> clears rules (default-allow)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("sandbox.setRules(db, null) clears rules")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>sandbox.setData(db, { '/path': value })</code> bulk-loads data, bypassing rules</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("sandbox.setData seeds the tree (rule-bypass)")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>sandbox.snapshotState(db)</code> dumps the full tree as a plain JSON object</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("sandbox.snapshotState dumps the full tree")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>query(ref, ...constraints)</code> + ordering/range constraints</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:upstream-rtdb-probes.test.ts</code> ("orderByChild('a/b') + limitToFirst orders by the nested path") + <code>unit:modular/queries.test.ts</code> + oracle observations under <code>packages/conformance/observations/rtdb-modular/</code>; see M49–M64 for the per-claim breakdown.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>runTransaction(ref, fn, options?)</code> resolves to <code>{ committed: boolean, snapshot: DataSnapshot }</code> for the happy path — the update fn return value is written, committed is <code>true</code>, and <code>snapshot.val()</code> reflects the committed value</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/transaction.test.ts</code> ("resolves to { committed: boolean, snapshot } with the committed value"); matches oracle observations <code>packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json</code> + <code>rtdb-modular-runtransaction-returns-committed-snapshot.json</code> (against blockingfun, fb-js-sdk 12.13.0)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returning <code>undefined</code> from the update fn ABORTS the transaction — resolves <code>{ committed: false, snapshot }</code>; no write performed, no listener fan-out</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/transaction.test.ts</code> ("returning undefined aborts — committed: false, no write" + "aborted transaction does NOT fan out to listeners"); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-abort-undefined.json</code> — known divergence: prod's <code>result.snapshot.val()</code> reflects the CLIENT's pre-fetch (often <code>null</code> even when the server has a value because the speculative invocation runs before the server snap arrives); the sandbox returns the actual pre-transaction value at the path (more useful in single-client harness). The agreed-upon contract callers should rely on is <code>committed === false</code> and unchanged server-side data, NOT the snapshot's <code>.val()</code> on the abort path.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The update fn receives the CURRENT value at the ref's path; for an absent path the argument is <code>null</code> (NOT <code>undefined</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/transaction.test.ts</code> ("update fn receives null for an absent path" + "update fn receives the existing value for a seeded path"); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-current-value-arg.json</code> (prod observation showed <code>missingArgs[0].isNull === true</code>) — note divergence: prod ALSO speculatively calls the fn with <code>null</code> for a seeded path before the server-snap arrives, the sandbox skips that speculative call (single invocation with the real current value)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The update fn arg is a defensive deep clone — mutating it does NOT corrupt the stored tree (matters for code that does <code>current.count++; return undefined</code> and expects abort to preserve state)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/transaction.test.ts</code> ("mutating the update-fn arg does NOT corrupt the stored tree") — no separate oracle row (defensive contract; prod behavior is identical because the SDK clones on the wire boundary)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>options.applyLocally</code> controls whether the in-flight optimistic value fans out to <code>onValue</code> listeners — default <code>true</code> (apply locally before commit); <code>false</code> suppresses intermediate fires so listeners see only the committed value</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/transaction.test.ts</code> ("applyLocally: true (default) — listener sees initial + committed value" + "applyLocally: false — listener sees only the committed value"); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-options-applylocally.json</code> (single-client harness: both branches produce 2 fires (initial + commit) — divergence vs prod's documented multi-client suppression would surface under contention, which the sandbox doesn't model)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Rules-denied transaction rejects with a plain <code>Error</code> whose <code>message === 'permission_denied'</code> (lowercase) and NO <code>.code</code> field — DIFFERENT from <code>set</code>/<code>get</code>'s <code>'PERMISSION_DENIED: Permission denied'</code> shape with uppercase <code>.code</code>.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/transaction.test.ts</code> ("rejects with a plain Error whose message is \"permission_denied\""); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-on-rules-denied-path.json</code> (against blockingfun: <code>message: 'permission_denied', code: null, constructorName: 'Error'</code>).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Rules-denied transaction does NOT write — pre-transaction value at the path is preserved through the rejection</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/transaction.test.ts</code> ("does not write to the path when rules deny") — locked alongside the M37e shape claim</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Committed transaction fans out to <code>onValue</code> listeners on the watched path with the new value (default applyLocally behavior)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/transaction.test.ts</code> ("committed write fans out to onValue listeners")</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior">Concurrent contention / retry-on-conflict — single-client sandbox doesn't model real concurrency; the documented "up to 25 retries" contract is degenerate (the fn is invoked once)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">matrix #161 documents the same gap on the spec side; oracle observation hard to obtain from a single client (oracle row stays <code>?</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Identity-aware sandbox-live op routing — sign-in/sign-out via <code>pyric/auth</code> is observed by the next RTDB op without re-binding</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("reads sandbox.currentUser at op time, not at getDatabase time")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Backend identity is per-<code>Sandbox</code> — two <code>getDatabase(sandbox)</code> calls on the same sandbox share data, two on different sandboxes don't</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">implicit via the WeakMap binding; tested transitively by <code>sandbox.setData</code> + <code>get</code> round-trips in the same test suite</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Sandbox refs carry a stable <code>key</code> (last path segment) and <code>toString()</code> returning <code>sandbox://rtdb/&lt;path&gt;</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">covered by the <code>ref</code> / <code>child</code> / <code>parent</code> tests</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>query(ref, orderByChild(p), startAt(v), endAt(w))</code> window is BOTH-INCLUSIVE — children whose ordered field === <code>v</code> or === <code>w</code> are included</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:upstream-rtdb-probes.test.ts</code> (deep orderByChild nested path) + <code>unit:modular/queries.test.ts</code> ("returns children whose ordered child is within [startAt, endAt] inclusive"); matches oracle <code>rtdb-modular-orderbychild-window.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>orderByKey()</code> orders children by RTDB <code>nameCompare</code> — integer-looking keys sort numerically FIRST (so <code>['1','2','10']</code>, not the lexicographic <code>['1','10','2']</code>), then non-integer keys lexicographically; <code>startAt</code>/<code>endAt</code> cursors + the optional <code>key</code> tie-breaker use the same order (DB-B4)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:upstream-rtdb-probes.test.ts</code> (INT32 overflow/underflow cursors) + <code>unit:modular/queries.test.ts</code> + <code>unit:modular/name-compare.test.ts</code>; matches oracle <code>rtdb-modular-orderbykey-window.json</code> and upstream <code>core/util/util.ts:253-276</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>orderByValue()</code> orders primitive children by their value; <code>limitToFirst(N)</code> returns the N smallest, ascending</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("returns the limitToFirst(N) smallest values, ascending"). Oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-orderbyvalue-numeric.json</code> shows prod threw <code>Index not defined</code> against blockingfun — the sandbox does NOT enforce <code>.indexOn</code> (rules-engine integration for query indexes is deferred); the semantic claim (ordering by value) is locked here.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>orderByChild(p) + equalTo(v)</code> returns ALL children whose field at <code>p</code> === <code>v</code> — no uniqueness enforced</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("returns ALL children whose ordered field === the supplied value"); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-equalTo-filter.json</code> (both 'b'-grouped children returned).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>equalTo</code> with no matches returns an empty snapshot (<code>exists() === false</code>, <code>numChildren() === 0</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("returns an empty snapshot when nothing matches")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>limitToFirst(N)</code> keeps the lowest-ranked N children (post-ordering, pre-filter)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("limitToFirst takes the lowest-ranked window"); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json</code> (firstPositions <code>[1,2]</code>).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>limitToLast(N)</code> keeps the highest-ranked N children</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("limitToLast takes the highest-ranked window"); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json</code> (lastPositions <code>[4,5]</code>).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>limitToFirst(N)</code> larger than the result returns the full window (no padding, no throw)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("limitToFirst(N) larger than the result returns the full window")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>startAfter(v)</code> and <code>endBefore(v)</code> are EXCLUSIVE — the boundary value is dropped from the result</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("startAfter + endBefore drop the boundary values"); matches oracle observation <code>packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json</code> (positions <code>[3,4]</code>, cursors 2 + 5 dropped).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onValue(query, cb)</code> only fires when the windowed result changes — writes OUTSIDE the window don't re-fire the listener; writes that displace a member DO</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:upstream-rtdb-probes.test.ts</code> ("one update nulls, mutates, and displaces within a limitToFirst window") + <code>unit:modular/queries.test.ts</code> ("fires only when the windowed result changes"); matches oracle <code>rtdb-modular-onvalue-with-query.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onValue(query)</code> initial fire delivers an empty window (<code>numChildren() === 0</code>) when the path is absent</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("initial fire on an empty path delivers an empty window")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>query(query(ref, c1), c2)</code> composes constraints — chaining folds both into one spec</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("query(query(ref, c1), c2) composes constraints")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Snapshot from a query exposes children via <code>snap.forEach</code> in the executor-computed order — NOT necessarily the order <code>Object.entries(val)</code> would yield</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("forEach visits children in ascending order of the child key")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>startAt(value, key)</code> uses <code>key</code> as the tie-breaker when multiple children share the same ordered value — children before <code>key</code> are dropped, the row at <code>key</code> is included (inclusive cursor)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("startAt with key tie-breaker drops earlier same-value children")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>orderByChild('p')</code> on children missing the field treats their value as <code>null</code> (sorts FIRST per RTDB's type ordering)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("orderByChild on a missing child path treats those children as null")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>query</code> on a path holding a primitive (or absent path) returns an empty snapshot — no rows to iterate</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("query on a path with primitive value returns no rows")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Write-boundary normalization (<code>nodeFromJSON</code>-equivalent): a value written as an array is stored as an integer-keyed object — <code>child(ref, '1')</code> returns the element, <code>forEach</code> iterates <code>0,1,2…</code> (DB-B2)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/normalization.test.ts</code> ("array write is addressable by integer-string child key" + "forEach over an array iterates its elements"); upstream <code>core/snap/nodeFromJSON.ts:118-128</code>, <code>core/snap/ChildrenNode.ts:194-230</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Read-side array coercion: a dense integer-keyed object renders back as an array on <code>snap.val()</code> (<code>allIntegerKeys &amp;&amp; maxKey &lt; 2 * numKeys</code>) (DB-B2)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/normalization.test.ts</code> ("a dense integer-keyed object reads back as an array"); upstream <code>core/snap/ChildrenNode.ts:196-230</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>null</code> children and empty objects are pruned at the write boundary — <code>set(ref, {})</code> is equivalent to <code>remove(ref)</code>; nested <code>null</code> collapses empty ancestors ("empty nodes don't exist") (DB-B3)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/normalization.test.ts</code> ("set(ref, {}) is equivalent to remove" + "null children are pruned"); upstream <code>core/snap/nodeFromJSON.ts:78-88,122-126</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Write validation: an <code>undefined</code> payload, a non-finite number (<code>NaN</code>/<code>±Infinity</code>), or a key containing a forbidden char (<code>.</code>, <code>#</code>, <code>$</code>, <code>/</code>, <code>[</code>, <code>]</code>, control chars) is rejected with a plain <code>Error</code> (DB-B1)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/normalization.test.ts</code> ("rejects an undefined payload" + "rejects an invalid key" + "rejects a non-finite number"); upstream <code>core/util/validation.ts:45,58,112-199</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Conflicting query constraints throw synchronously at <code>query(...)</code> construction (NOT silent last-win): multiple <code>orderBy*</code>, a second <code>limitToFirst</code>/<code>limitToLast</code>, a second start (<code>startAt</code>/<code>startAfter</code>/<code>equalTo</code>) or end (<code>endAt</code>/<code>endBefore</code>/<code>equalTo</code>) (DB-B5)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/constraint-conflicts.test.ts</code> (5 cases); upstream <code>api/Reference_impl.ts:160-165,1824-1841,1888-1905,1945-1951,2193-2206</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>push(ref, value?)</code> returns a <code>ThenableReference</code> (a <code>DatabaseReference</code> with <code>.then</code>/<code>.catch</code>). The key + ref are minted CLIENT-SIDE and available synchronously even when the optional value write is rules-denied; the write is deferred onto the promise, so a denial REJECTS the awaited push rather than throwing synchronously and discarding the key (DB-B7)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/push-thenable.test.ts</code> (4 cases); matches oracle <code>packages/conformance/observations/rtdb/rtdb-push-autoid-format.json</code> ("available immediately even when the subsequent server write is denied by rules") + upstream <code>api/Reference_impl.ts:599-630</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>DataSnapshot</code> shape: <code>size</code> (getter), <code>priority</code> (currently always <code>null</code>), <code>exportVal()</code>, <code>key</code>, <code>ref</code>, <code>val()</code>, <code>exists()</code>, <code>child()</code>, <code>hasChild()</code>, <code>hasChildren()</code>, <code>forEach()</code>, <code>toJSON()</code>. It does NOT ship the legacy namespaced <code>numChildren()</code> method (DB-B10)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/snapshot-shape.test.ts</code> ("exposes size/priority/exportVal; NOT numChildren()"); matches oracle <code>packages/conformance/observations/rtdb-modular/rtdb-modular-get-snapshot-shape.json</code> (<code>hasSize: true, hasNumChildren: false</code>) + upstream <code>api/Reference_impl.ts:288-447</code>. <strong>Flipped masking tests</strong>: <code>modular/queries.test.ts</code> + <code>modular/sandbox-target.test.ts</code> asserted <code>snap.numChildren()</code> — updated to <code>snap.size</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Object-valued children are ORDER-EQUAL — the sort/range tie is broken by key (<code>nameCompare</code>), NOT by an invented <code>JSON.stringify</code> ordering; a query re-write that only reorders object keys is "no change" and doesn't re-fire (DB-B11)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/object-order-equality.test.ts</code>; upstream <code>core/snap/ChildrenNode.ts:386-400</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">A primitive at the ROOT is legal (<code>set(ref(db), 'hello')</code>); a subsequent child write replaces the primitive root ("writes win") (DB-B13)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/root-primitive.test.ts</code> (2 cases)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onValue(ref, cb, { onlyOnce: true })</code> fires once then auto-unsubscribes (DB-B12)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/onvalue-onlyonce.test.ts</code>; upstream <code>api/Reference_impl.ts:975-980</code></div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior"><strong>Divergence (DB-B12, honest doc):</strong> the onChild<em> callbacks do NOT receive the <code>previousChildName</code> second argument; <code>onValue</code>/<code>onChild</em></code> do NOT accept a <code>cancelCallback</code>; <code>onChildAdded</code>/<code>Changed</code>/<code>Removed</code>/<code>Moved</code> accept only plain refs (not <code>Query</code>); <code>child_moved</code> never fires (ordered-query move detection unmodeled). These listener-surface holes are out of scope for the current phase — consumers needing them use <code>firebase/database</code> directly.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence documented; partial coverage: <code>{ onlyOnce }</code> IS implemented (M74).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>.validate</code> rules are enforced on modular sandbox writes through <code>set</code>, atomic <code>update</code>, and <code>runTransaction</code>; a descendant validation failure rejects the operation without changing state.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> executes all three write paths against a required-child <code>.validate</code> rule and proves each rejects without committing state. The shared <code>SimulateHandler</code> behavior is production-locked by RTDB rules corpus rows #4 and #15.</div></div>
</details>
</div>

### Deferred mirror behaviors

- Ordered-query `onChildMoved` is accepted but does not yet fire on reorder.

Public runtime deferrals are rendered from the machine-readable surface contract below, not authored here.

The playground and `pyric dev` map canonical `firebase/database` imports to `pyric/database` before the mirror loads. A bare preview `getDatabase()` call is wrapped to receive the active sandbox. Production bundling leaves `firebase/database` unchanged.

Simulation and structure crawling are sandbox/CLI operations; rules authoring and analysis remain on the internal RTDB rules-engine seam until their later package relocation.

---

### `getDatabase(target)` — initializer

<div class="compat-list">
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior"><code>getDatabase(ctx)</code> returns a tagged sandbox-target handle (frozen identity)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Phase 3</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior"><code>getDatabase(sandbox)</code> returns a tagged sandbox-live handle (per-op identity)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Phase 3</div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior">Inactive canonical <code>firebase/database</code> imports remain the upstream package; the mirror does not create tagged production targets</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">package-resolution boundary; inactive RTDB canonical-import isolation is not yet claimed by this row</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>getDatabase()</code> (no argument) — wrapped in the playground preview to supply the sandbox; a raw mirror call rejects with package-resolution guidance</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Phase 3 Tier 5: virtualized in the playground preview scope. Wired at <code>packages/playground/src/components/AppPreview.tsx</code> (slot install with bare-call wrap), <code>packages/playground/src/lib/preview/virtual-imports-plugin.ts</code> (alias map), and <code>packages/playground/src/lib/preview/preview-scope.ts</code> (type-level slot). Mirrors the <code>getAuth</code> / <code>getFirestore</code> wrap pattern. Demo fixture: <code>packages/playground/scripts/fixtures/rtdb-set-get-roundtrip.tsx</code> (bare <code>getDatabase()</code> + <code>set</code>/<code>get</code>/<code>remove</code> round-trip with anonymous sign-in) passes end-to-end through the <code>bun run debug:fixtures</code> Playwright suite.</div>
<div class="compat-note">(wrap, fixture passing)</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior">Two <code>getDatabase(sandbox)</code> calls share state (same underlying <code>LocalEnvironment</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Phase 3</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior">Handle dispatch by <code>TARGET_SYMBOL</code> brand — refs route to their owning target via a <code>refToTarget</code> WeakMap (mirror of firestore's pattern)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Phase 3</div></div>
</details>
</div>

### `ref(db, path)` / `child` / `parent` / `root`

<div class="compat-list">
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior"><code>ref(db, path)</code> returns a tagged <code>DatabaseReference</code> carrying <code>key</code>, <code>parent</code>, <code>root</code>, <code>toString()</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">upstream <code>firebase/database</code> contract</div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior"><code>ref(db)</code> with no path returns the root ref (<code>key === null</code>, <code>parent === null</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">upstream contract</div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior"><code>child(ref, 'a/b')</code> joins a relative path, including embedded slashes</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">upstream contract</div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior"><code>ref.parent</code> is <code>null</code> at root, otherwise the parent ref</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">upstream contract</div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior"><code>ref.key</code> is the final path segment, <code>null</code> for root</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">upstream contract</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior">Unknown ref (not produced by this package) → <code>TypeError</code> in shim ops</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Phase 3</div></div>
</details>
</div>

### `get(ref)` — single read

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returns a <code>DataSnapshot</code> carrying <code>.val()</code>, <code>.exists()</code>, <code>.key</code>, <code>.ref</code>, <code>.size</code> (getter, returns child count), <code>.hasChildren()</code>, <code>.hasChild(path)</code>, <code>.forEach(cb)</code>. The legacy namespaced-SDK method <code>.numChildren()</code> is <strong>NOT</strong> on the modular DataSnapshot — use <code>.size</code> instead. Observed: <code>hasNumChildren: false</code>, <code>size: 3</code> for a <code>{a,b,c}</code> object, <code>forEachKeys: ['a','b','c']</code> against blockingfun, fb-js-sdk 12.13.0.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-get-snapshot-shape.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>snap.val()</code> returns <code>null</code> for a missing path (NOT a thrown error — RTDB diverges from Firestore here; <code>getDoc</code> returns <code>exists()===false</code> but <code>get</code> on RTDB just returns a <code>null</code>-val snapshot)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-get-missing-path.json</code> — observed <code>threw: false, val: null, exists: false</code> on a never-written path against blockingfun.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>snap.exists()</code> is <code>false</code> when <code>val() === null</code>, <code>true</code> otherwise</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-get-missing-path.json</code> — observed <code>exists: false</code> for <code>val: null</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Round-trip: <code>set(ref, payload)</code> then <code>get(ref)</code> returns the payload (lock the basic write→read invariant)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-set-then-get-roundtrip.json</code> — the payload round-trips structurally on both sides (this row's claim holds). NOTE — adjacent divergence pinned in <code>oracle-conformance.test.ts</code>: prod returns object children in LEXICOGRAPHIC key order (the capture's <code>roundTripEqual: false</code> — a <code>JSON.stringify</code> round-trip against a non-sorted payload fails), while the sandbox preserves insertion order (stringify round-trip succeeds). Key-order-sensitive consumers behave differently.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Rules-denied read throws a plain <code>Error</code> (NOT a <code>FirebaseError</code>) with <code>code: 'PERMISSION_DENIED'</code> (uppercase snake-case) — matches the agent-tool rows #15/#20</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json</code></div></div>
</details>
</div>

### `set(ref, value)` — full write

<div class="compat-list">
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior">Replaces the value at the path entirely; resolves to <code>undefined</code> (unlike <code>setDoc</code> which resolves to <code>void</code>, RTDB's <code>set</code> is documented as <code>Promise&lt;void&gt;</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">upstream contract</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>set(ref, null)</code> removes the path entirely — equivalent to <code>remove(ref)</code>, subsequent <code>get</code> returns <code>null</code>-val snapshot</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-set-null-equals-remove.json</code> — observed <code>beforeExists: true → afterExists: false, afterVal: null</code> after <code>set(ref, null)</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Nested objects overwrite — <code>set(ref, {a: 1})</code> after <code>set(ref, {a: 1, b: 2})</code> leaves <code>{a: 1}</code> only, NOT a merge (RTDB <code>set</code> is replacement, not merge)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-set-replaces-not-merges.json</code> — observed <code>final: {a: 1}</code> with <code>b</code> absent after the second set.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Primitive round-trip — numbers, strings, booleans, arrays all survive a set→get cycle</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-set-then-get-roundtrip.json</code> — the payload round-trips structurally on both sides (this row's claim holds). NOTE — adjacent divergence pinned in <code>oracle-conformance.test.ts</code>: prod returns object children in LEXICOGRAPHIC key order (the capture's <code>roundTripEqual: false</code> — a <code>JSON.stringify</code> round-trip against a non-sorted payload fails), while the sandbox preserves insertion order (stringify round-trip succeeds). Key-order-sensitive consumers behave differently.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Rules-denied write throws plain <code>Error</code> with <code>code: 'PERMISSION_DENIED'</code> (same shape as #110)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json</code></div></div>
</details>
</div>

### `update(ref, values)` — partial / multi-path update

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>update(ref, {a: 1, b: 2})</code> merges top-level keys at the ref; unspecified keys preserved (in contrast to <code>set</code>'s replacement)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-update-merges-keys.json</code> — after <code>set({a:1,b:2})</code> then <code>update({a:10})</code>, observed <code>final: {a:10, b:2}</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Multi-path update — <code>update(parentRef, { 'a/x': 1, 'b/y': 2 })</code> lands BOTH writes atomically at distinct subtrees (RTDB's most distinctive feature; this is the "fan-out" pattern)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-update-multipath-atomic.json</code> — observed <code>aX: 1, bY: 2</code> both readable after a single update call.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Multi-path update is atomic: if any path is denied by rules, the entire update rejects and no path is written</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-update-multipath-rules-denial.json</code> — observed <code>threw: true, code: 'PERMISSION_DENIED'</code> AND <code>okPathWrittenDespiteDenial: false</code> (the otherwise-permitted path also rolled back).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Setting a key to <code>null</code> inside <code>update</code> removes that key — same equivalence as <code>set(ref, null)</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-update-null-removes-key.json</code> — after <code>set({a:1,b:2})</code> then <code>update({a:null})</code>, observed <code>final: {b:2}</code> with <code>a</code> absent.</div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior">Update path validation — overlapping paths (e.g. <code>'/a'</code> and <code>'/a/x'</code> in the same call) throws synchronously before any write</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">upstream contract — needs targeted probe</div></div>
</details>
</div>

### `remove(ref)` — delete

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Removes the value AND all children; subsequent <code>get</code> returns <code>null</code>-val snapshot</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Idempotent — <code>remove</code> on a path that's already absent resolves successfully (no-throw)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-remove-idempotent.json</code> — <code>remove</code> on a never-written path observed <code>threw: false, afterExists: false</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>remove(ref)</code> and <code>set(ref, null)</code> produce the same end state — locks the documented RTDB invariant</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json</code></div></div>
</details>
</div>

### `push(ref, value?)` — auto-id append

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>push(ref).key</code> is a 20-char string starting with <code>-</code>, available <strong>synchronously</strong> (client-side mint, no server round-trip required)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-push-autoid-format.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Sequential <code>push</code> calls produce monotonically-sortable keys (timestamp-prefixed for chronological ordering via <code>orderByKey</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-push-autoid-format.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>push(ref, value)</code> writes the value AND returns the new child ref (both behaviors in one call); <code>push(ref)</code> mints the ref without writing</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-push-with-value.json</code> — <code>await push(parent, {hello:'world'})</code> returned a ref with a 20-char key; subsequent <code>get(r)</code> returned <code>{hello:'world'}</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The returned ref <code>r = push(parent, value)</code> is usable in follow-up ops: <code>get(r)</code>, <code>set(r, …)</code>, <code>remove(r)</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-push-with-value.json</code> — observed all 4 follow-up ops succeed through the returned ref (<code>refIsUsableForFollowupOps: true</code>).</div></div>
</details>
</div>

### `onValue(ref, cb)` — value-level listener

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Subscribing to a path with <strong>existing data</strong> fires the listener once with the current snapshot (the "initial fire")</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-initial-with-data.json</code> — observed exactly 1 initial fire within ~46ms of subscribe, snapshot.val() === the seeded payload.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Subscribing to a <strong>nonexistent path</strong> still fires the listener once — with a <code>null</code>-val snapshot AND <code>exists() === false</code>. Matches Firestore's <code>onSnapshot</code>-on-missing-doc semantics: prod RTDB does NOT silently skip the initial fire for empty paths.</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-initial-no-data.json</code> — observed 1 initial fire on a never-written path with <code>firstFire.val: null, firstFire.exists: false</code> (~55ms after subscribe).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Subsequent <code>set(ref, …)</code> fires the listener with the new value</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-onvalue-fires-on-set.json</code> — observed 1 fire per <code>set()</code> (1+1+1 = 3 total: initial-null, after-first-set, after-second-set).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Unsubscribe — the returned unsubscribe function stops further fires; subsequent writes produce 0 additional fires after <code>unsub()</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-unsubscribe.json</code> — observed <code>preUnsubFires: 2, postUnsubFires: 2</code> (a write performed after <code>unsub()</code> produced 0 additional fires within a 500ms settle window).</div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior">The returned value from <code>onValue(ref, cb)</code> is the unsubscribe function (NOT an object); calling it removes the listener</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">upstream contract — locked indirectly by #131</div></div>
</details>
</div>

### `onChildAdded` / `onChildChanged` / `onChildRemoved` / `onChildMoved`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onChildAdded</code> replays the existing children on subscribe — one fire per existing child key, in <code>orderByKey</code> order by default (unlike <code>onValue</code> which fires once with the parent snapshot)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-initial-replay.json</code> — seeded <code>{k1, k2, k3}</code>, observed 3 initial fires with <code>firedKeys: ['k1', 'k2', 'k3']</code> in insertion order against blockingfun.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">After subscribe, adding a child via <code>push</code> or <code>set(child, …)</code> fires <code>onChildAdded</code> exactly once for that key</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-post-subscribe.json</code> — seeded <code>{k1,k2}</code>, observed <code>postSubscribeFires: 1, lastFire: {key:'k3', val:{v:3}}</code> after writing the new child.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onChildChanged</code> fires when an existing child's value changes; does NOT fire for added or removed children</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onchildchanged-fires-on-update.json</code> — observed <code>firedOnInitial: 0, firedOnUpdate: 1, lastFire: {key:'k1', val:{v:2}}</code> (the NEW value, not the prior).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onChildRemoved</code> fires when a child is deleted (via <code>remove(child)</code> or <code>set(child, null)</code>); snapshot carries the PRIOR value</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onchildremoved-fires-on-delete.json</code> — observed <code>firedOnDelete: 1, removedSnapCarriesPriorValue: true</code> (snapshot.val() was the pre-delete value).</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior"><code>onChildMoved</code> under an ordered query. Prod: fires when a child's <code>orderByChild</code>/<code>orderByValue</code> priority changes — emitted only on ordered queries. Sandbox: <strong>never fires on reorder</strong> — <code>onChildMoved</code> supports the plain-ref (no-fire) case only; the ordered-query overload is unimplemented</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence, oracle-locked by <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onchildmoved-with-orderby.json</code>: prod observed <code>firedOnMove: 1</code> under <code>query(ref, orderByChild('priority'))</code> after bumping a child's priority to a new sort position; the sandbox fires 0 on reorder. Partial alignment landed: all <code>onChild*</code> now ACCEPT a <code>Query</code> (previously threw a misleading <code>unrecognized reference</code> TypeError) with window-aware <code>child_added</code>/<code>child_changed</code>/<code>child_removed</code> diffs (<code>src/database/sandbox/backend.ts</code>); the two hold-lifting captures now exist: <code>rtdb-modular-onchildmoved-previouschildname-sequencing</code> pins prev-name sequencing (end/middle/front reorders yield prev k3/k2/null, no initial replay) and <code>rtdb-modular-childchanged-cofire-with-childmoved</code> pins co-fire semantics (a reorder fires BOTH <code>child_changed</code> and <code>child_moved</code>; a non-ordered-field change fires neither moved; prod fires <code>child_moved</code> on an ordered-field value change EVEN WHEN RANK IS UNCHANGED). Implementation of ordered <code>child_moved</code> is unblocked. Both sides pinned in <code>modular/oracle-conformance.test.ts</code> and <code>modular/sandbox-child-events.test.ts</code>. Sandbox Tier 2 locks the plain-ref no-fire case (M46).</div></div>
</details>
</div>

### `off(ref, eventType?, callback?)` — unsubscribe variants

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>off(ref)</code> removes ALL listeners at that ref (any event type, any callback)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-off-stops-child-fires.json</code> — after <code>off(ref)</code> with no eventType, a subsequent write produced <code>postOffFires: 0</code> against an <code>onChildAdded</code> registration.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>off(ref, 'value')</code> removes only <code>value</code> listeners at that ref</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned (M48); oracle: <code>packages/conformance/observations/rtdb/rtdb-off-eventtype-precision.json</code> — registered TWO <code>value</code> listeners + one <code>child_added</code> at the same ref; after <code>off(ref, 'value')</code> (no callback), <code>valueListenersStopped: true</code> (neither value cb fired on subsequent writes) AND <code>childListenerStillFiringAfterOffValue: true</code> (the child listener kept firing). <code>offValueClearsAllValueListeners: true</code> confirms the no-callback variant removes ALL value listeners at the ref.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>off(ref, 'value', cb)</code> removes only the specific callback</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned (M48); adjacent to #141 — the upstream <code>off</code> with the cb argument removes only the matching callback. Same probe (<code>rtdb-onvalue-unsub-equivalence.json</code> Case 2) confirms <code>off(ref, 'value', cb)</code> stops only that callback.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The returned unsubscribe function from <code>onValue(ref, cb)</code> is equivalent to <code>off(ref, 'value', cb)</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned (M48); oracle: <code>packages/conformance/observations/rtdb/rtdb-onvalue-unsub-equivalence.json</code> — <code>unsubReturnType: 'function'</code>, <code>unsubReturnedFnStopsListener: true</code> (the captured return value halted fires on write), <code>offRefValueCbStopsListener: true</code> (the same effect via <code>off(ref, 'value', cb)</code>), <code>bothFormsEquivalent: true</code>.</div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><code class="compat-api">off(ref, eventType, callback)</code><span class="compat-sub"><span class="compat-behavior">When the same callback is registered more than once, each <code>off(ref, eventType, callback)</code> removes one registration without orphaning the others</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Pyric behavior is locked by <code>packages/pyric/test/app/multi-app-listener-auth.test.ts</code>; a production duplicate-registration oracle capture is still needed</div></div>
</details>
</div>

### `query(ref, ...constraints)` + ordering / bounds / limits

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>query(ref, orderByChild('field'), limitToFirst(N))</code> returns a <code>Query</code> whose <code>get()</code> resolves a snapshot containing N children ordered by <code>field</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-query-orderbychild-limit.json</code> — seeded 4 children with positions <code>[3,1,4,2]</code>, observed <code>orderedKeys: [{key:'a',pos:1}, {key:'b',pos:2}]</code> (first 2 in ascending order). Requires <code>.indexOn</code> declared in rules.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>orderByKey()</code> orders by the auto-id / numeric key</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-orderbykey-window.json</code> — seeded <code>{a,b,c,d,e}</code> in shuffled insertion order, observed <code>matchedKeys: ['b','c','d']</code> for <code>orderByKey() + startAt('b') + endAt('d')</code> (in key order).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>orderByValue()</code> orders by the primitive value of each child (for collections of primitives)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-orderbyvalue-numeric.json</code> — seeded <code>{alice:30, bob:10, carol:50, dave:20, eve:40}</code>, the prod call threw <code>Index not defined, add ".indexOn": ".value"</code> (so prod enforces an index requirement on <code>orderByValue()</code>); semantic ordering claim still holds, sandbox does not enforce indexes.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>equalTo(v)</code> filters children whose ordered field === v (returns 0, 1, or multiple matches — RTDB does NOT enforce uniqueness)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-query-equalto.json</code> — seeded <code>{red, blue, blue, green}</code>, observed <code>matchedKeys: ['k2', 'k3']</code> for <code>equalTo('blue')</code> (both blue children, none of the others). Additional probe: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-equalTo-filter.json</code> (a..b..c groups) confirms <code>equalTo('b')</code> returns the two <code>b</code> children.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>startAt(v)</code> is <strong>inclusive</strong> (the child whose ordered value === v is included)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-query-startat-inclusive.json</code> — seeded positions <code>[1,2,3,4]</code>, observed <code>matched: [2,3,4]</code> for <code>startAt(2)</code> (cursor doc included).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>endAt(v)</code> is <strong>inclusive</strong></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-orderbychild-window.json</code> — <code>startAt(2) + endAt(4)</code> matched positions <code>[2,3,4]</code> (endAt(4) included its boundary value).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>startAfter(v)</code> is <strong>exclusive</strong></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json</code> — <code>startAfter(2) + endBefore(5)</code> matched positions <code>[3,4]</code> (cursor <code>2</code> dropped).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>endBefore(v)</code> is <strong>exclusive</strong></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json</code> — same probe; cursor <code>5</code> dropped.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>limitToFirst(N)</code> caps the result count from the start of the ordered range</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-query-orderbychild-limit.json</code> plus <code>packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json</code> (firstPositions <code>[1,2]</code>).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>limitToLast(N)</code> caps from the end</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json</code> — observed <code>lastKeys: ['d','e'], lastPositions: [4,5]</code> for <code>limitToLast(2)</code> on a 5-child collection ordered by <code>pos</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Listeners on a <code>Query</code> (<code>onValue(q, …)</code>) emit only the windowed snapshot — NOT the parent ref's full data</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-with-query.json</code> — seeded 3 children, watched first 2 by <code>pos</code>; observed 3 fires total: (1) initial <code>[a,b]</code>, (2) OUTSIDE-window write to <code>c/extra</code> did NOT fire, (3) INSIDE-window mutation of <code>a</code> re-fired, (4) new child <code>z</code> displaced <code>b</code> and re-fired. Outside-window writes are silent.</div></div>
</details>
</div>

### Sentinels — `serverTimestamp()` / `increment(n)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>serverTimestamp()</code> resolves server-side to a <strong>number</strong> (epoch milliseconds) — diverges from Firestore's <code>Timestamp</code> instance</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json</code> — observed <code>createdAtType: 'number', createdAt: 1779075391118</code> (i.e. a plain JS number, NOT a <code>Timestamp</code> object).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>serverTimestamp()</code> as a field value in <code>set</code> or <code>update</code> writes the <code>{".sv": "timestamp"}</code> sentinel; the read-back value is the resolved number</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json</code> — read-back showed <code>createdAtSentinelShape: false</code> (sentinel resolved server-side; client sees the number, not the <code>.sv</code> placeholder).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>increment(n)</code> against a <strong>missing</strong> field starts at 0 (so <code>increment(5)</code> lands as <code>5</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned (modular <code>increment</code> export now present): <code>unit:modular/increment.test.ts</code> ("increment against a missing field starts from 0"); matches oracle <code>packages/conformance/observations/rtdb-modular/rtdb-modular-increment-from-missing.json</code> — observed <code>afterFirst: 5</code> from <code>increment(5)</code> against an absent <code>count</code> field.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>increment(n)</code> against an existing numeric field adds atomically; negative deltas subtract</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Sandbox aligned: <code>unit:modular/increment.test.ts</code> ("subsequent increments accumulate (positive then negative)" + "nested inside an update patch resolves per-field"); matches oracle <code>packages/conformance/observations/rtdb-modular/rtdb-modular-increment-from-missing.json</code> — observed <code>afterSecond: 8</code> (5+3) then <code>afterNegative: 6</code> (8-2).</div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior">Two concurrent <code>increment</code> calls interleave correctly (last-write-wins is NOT the contract — both deltas accumulate)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">hard to observe deterministically from a single client; documented contract</div></div>
</details>
</div>

### `runTransaction(ref, transactionUpdate, options?)` — optimistic concurrency

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Basic success — <code>runTransaction(ref, current =&gt; (current ?? 0) + 1)</code> resolves <code>{ committed: true, snapshot }</code> where <code>snapshot.val()</code> is the new value</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json</code> — observed <code>committed: true, snapVal: 1</code> after running <code>current =&gt; (current ?? 0) + 1</code> against an empty ref.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Returning <code>undefined</code> from the update fn <strong>aborts</strong> the transaction — resolves <code>{ committed: false }</code>, no write performed (RTDB-specific; distinct from Firestore where the only abort path is throwing)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-abort-undefined.json</code> — seeded <code>100</code> then transaction returned <code>undefined</code>; observed <code>committed: false, snapVal: null, afterValOnServer: 100</code> (existing value preserved).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">The update fn is called with the CURRENT server value (may be <code>null</code> if the ref is empty); the fn's return value is the proposed new value</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json</code> — observed <code>seenCurrentValues: [null]</code> on first invocation against an empty ref (a single call, no speculative re-runs against <code>undefined</code>). NOTE — adjacent divergence pinned in <code>modular/oracle-conformance.test.ts</code>: for a SEEDED path, prod speculatively invokes the update fn twice (first with <code>null</code>, then the real value; <code>rtdb-modular-runtransaction-current-value-arg.json</code> <code>seededArgs.length: 2</code>) while the sandbox invokes once with the actual value. The argument-semantics claim of this row holds for the effective invocation on both sides. WARNING for update-fn authors: prod may invoke your fn first with <code>null</code> even when data exists — the pattern <code>if (current === null) return;</code> (abort-on-empty) silently loses writes on prod while working on the sandbox, and side effects inside the fn can run twice on prod. RESOLVED by the warm-client capture <code>rtdb-modular-runtransaction-warm-client-speculation</code>: a warm prod client (active listener + prior get) receives a SINGLE invocation with the cached value, exactly matching the sandbox. The cold-cache speculative double-call is an artifact of an empty client cache, which the always-warm in-process sandbox structurally never has; the sandbox behavior IS the warm-client contract.</div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior">Concurrent contention — if another client writes between the read and write, the update fn is retried with the new current value (typically up to 25 retries by default)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">hard to observe deterministically from a single client</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Result snapshot's <code>.val()</code> reflects the committed value (or the existing value if aborted)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json</code> — observed <code>snapVal: 1</code> matching the committed value.</div></div>
</details>
</div>

### `goOnline` / `goOffline` — connection control

<div class="compat-list">
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior"><code>goOffline(db)</code> — accepted no-op: there is no network connection in the local sandbox to toggle, so nothing is disconnected (we deliberately do NOT simulate a disconnect — pending writes, listeners, and <code>get()</code> keep working)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/fruit-aliases.test.ts</code></div>
<div class="compat-note">no network connection in the local sandbox to toggle</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior"><code>goOnline(db)</code> — accepted no-op: there is no connection to reopen (see <code>goOffline</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/fruit-aliases.test.ts</code></div>
<div class="compat-note">no network connection in the local sandbox to toggle</div></div>
</details>
</div>

### `connectDatabaseEmulator` — emulator hook

<div class="compat-list">
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior">No-op on sandbox-target handles (the sandbox IS the local emulator)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Phase 3</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior">A production target is intentionally absent; production code continues to use <code>connectDatabaseEmulator</code> from the unchanged <code>firebase/database</code> package</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">Phase 3</div></div>
</details>
</div>

### Transport, logging, and URL-reference exports

<div class="compat-list">
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior"><code>forceLongPolling()</code> — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (it never opens a real socket). Accepted so init code that calls it compiles + runs</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/fruit-aliases.test.ts</code></div>
<div class="compat-note">transport selection not applicable to the in-process/worker sandbox</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior"><code>forceWebSockets()</code> — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (see <code>forceLongPolling</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/fruit-aliases.test.ts</code></div>
<div class="compat-note">transport selection not applicable to the in-process/worker sandbox</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior"><code>enableLogging(logger?, persistent?)</code> — accepted no-op: the sandbox has no modular-SDK-style logger to wire a level/sink into (it uses host-level <code>console</code> logging directly, matching <code>pyric/firestore</code>'s <code>setLogLevel</code>). Accepted so init code that calls it compiles + runs</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/fruit-aliases.test.ts</code></div>
<div class="compat-note">accepted no-op; no sandbox logger to wire into</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior"><code>refFromURL(db, url)</code> — real alias: parses the path out of the absolute database URL and delegates to <code>ref(db, path)</code>, so the returned ref resolves + reads exactly like <code>ref(db, path)</code>. Divergence: the sandbox is single-database with no host/namespace, so the URL's HOST is NOT validated against the handle (the real SDK throws if the host doesn't match the db's namespace); only the path is honored</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:modular/fruit-aliases.test.ts</code></div>
<div class="compat-note">path resolves like <code>ref</code>; URL host/namespace not validated (single-database sandbox)</div></div>
</details>
</div>


---



### Modular SDK surface — rows still marked **?** (need explicit probes)

Rows **locked by the empirical oracle harness** (committed observations under `packages/conformance/observations/`, captured against the `blockingfun` project):

- #96–#105 — most of the `getDatabase` + `ref` rows are still **?**. These are upstream `firebase/database` shape claims that hold by definition; they'll lift to **✓** when the Phase 3 shim's unit tests cover them.
- #111 `set()` return shape (`Promise<void>`) — trivial; first sandbox unit test will lock.
- #120 `update()` path-validation errors — same as agent-tool #24.
- #132 the unsubscribe return-value shape — locked indirectly by #131 (`unsubStopsFires: true`); a stronger one-claim probe would assert `typeof returnedValue === 'function'`.
- #134–#137 `onChildAdded` post-subscribe / `onChildChanged` / `onChildRemoved` / `onChildMoved` — fire-count claims; each needs a probe that mutates the parent after subscribe.
- #138–#141 `off(ref, ...)` variants — needs probes that register multiple listeners and verify the correct subset gets removed.
- ~~#143 `orderByKey()`, #144 `orderByValue()`, #147 `endAt`, #148 `startAfter`, #149 `endBefore`, #151 `limitToLast`, #152 query-listener windowing~~ — all locked in Phase 3 Tier 3 by 7 new oracle probes (see "Modular SDK surface — Phase 3 Tier 3" below).
- #157 concurrent `increment` interleaving — hard to observe from a single client; punt to a 2-client harness if it ever becomes load-bearing.
- #161 transaction conflict-retry — same problem; documented contract.

### Modular SDK surface — rows locked by the empirical oracle harness (Phase 1 output)

36 oracle observations under `packages/conformance/observations/rtdb-modular/rtdb-modular-*.json` lock the following modular-SDK rows against `blockingfun`, fb-js-sdk 12.13.0 (20 from Phase 1 + 4 transaction probes from Tier 4 + 5 child-event probes from Tier 2 + 7 query probes from Tier 3):

- #106 `DataSnapshot` shape — `size` is a getter, `numChildren()` is NOT on the modular SDK (was the legacy namespaced API).
- #107/#108 `get()` on missing path → `{ val: null, exists: false }`, no throw.
- #112 `set(ref, null)` removes the path (subsequent `get` returns `null`).
- #113 `set` replaces (NOT merges) at the parent ref.
- #116 `update` merges top-level keys; unspecified keys preserved.
- #117 multi-path update — `update(parentRef, { 'a/x': 1, 'b/y': 2 })` lands both writes.
- #118 multi-path update atomicity — one path denied → entire update rejects, no partial application.
- #119 `update` with `null` value removes a key.
- #122 `remove` on absent path is idempotent (no-throw).
- #126/#127 `push(ref, value)` writes the value AND returns a ref usable for follow-up ops.
- #128 `onValue` initial fire with existing data — exactly 1 fire.
- #129 `onValue` initial fire on a nonexistent path — fires once with `val: null, exists: false` (matches Firestore semantics; RTDB does NOT silently skip the empty-path initial fire).
- #130 `onValue` fires on subsequent `set`.
- #131 unsubscribe stops further fires (`postUnsubFires === preUnsubFires`).
- #133 `onChildAdded` replays existing children on subscribe — one fire per existing key.
- #134 `onChildAdded` post-subscribe — exactly one fire per new direct child write.
- #135 `onChildChanged` — no initial replay, fires once when an existing child transitions, snapshot carries the NEW value.
- #136 `onChildRemoved` — no initial replay, fires once on delete, snapshot carries the PRIOR (now-removed) value.
- #137 `onChildMoved` — fires under ordered queries (`query(ref, orderByChild(...))`) when a child's ordering value moves it to a new sort position; the Tier 2 sandbox locks the plain-ref no-fire case, Tier 3 wires the ordered-query path.
- #138/#139 `off(ref)` (no event type) stops further fires — locked against an `onChildAdded` registration; covers the off() variants by extension.
- #142/#150 `query(ref, orderByChild('pos'), limitToFirst(2))` returns the first 2 ordered children.
- #145 `equalTo(v)` filters to exactly the matching children.
- #146 `startAt(v)` is inclusive.
- #153/#154 `serverTimestamp()` resolves to a JS `number` (epoch ms), NOT a `Timestamp` instance.
- #155/#156 `increment(n)` starts at 0 on missing fields and accumulates (incl. negative deltas).
- #158/#160/#162 `runTransaction` happy path — committed: true, snapshot.val() is the new value, update fn sees `null` for empty refs.
- #159 `runTransaction` abort by returning `undefined` — committed: false, existing server value preserved.
- #160 (extended) `runTransaction` current-value arg shape — `null` for absent paths (`isNull: true`); prod speculatively invokes the fn once with `null` for a seeded path before the server-snap arrives (sandbox skips that speculative call — single invocation with the real current value).
- #162 (extended) `runTransaction` result shape — `{ committed: boolean, snapshot: DataSnapshot }`; snapshot responds to `.val()`, `.exists()`, `.key`.
- M37d `runTransaction` `options.applyLocally` — both branches commit; single-client harness produces 2 fires (initial + commit) on both, confirming the option doesn't break the contract (the suppression difference would only surface under contention).
- M37e `runTransaction` rules-denied error shape — plain `Error`, `message: 'permission_denied'` (lowercase), NO `.code` field — **distinct from `set`/`get`'s `'PERMISSION_DENIED: Permission denied'` shape with uppercase `.code`**.

### Modular SDK surface — Phase 3 Tier 3 (query semantics) oracle observations

7 new oracle probes locked the full query-pipeline behavior against `blockingfun`, fb-js-sdk 12.13.0:

- #142/#146/#147 `rtdb-modular-orderbychild-window.json` — `orderByChild('pos') + startAt(2) + endAt(4)` matched positions `[2,3,4]` (both-inclusive window).
- #143/#146/#147 `rtdb-modular-orderbykey-window.json` — `orderByKey() + startAt('b') + endAt('d')` matched keys `[b,c,d]` in key order.
- #144/#150 `rtdb-modular-orderbyvalue-numeric.json` — `orderByValue() + limitToFirst(3)` threw `Index not defined, add ".indexOn": ".value"` against blockingfun — prod enforces a value-index requirement. (Sandbox does not enforce indexes; the semantic ordering claim is locked by unit test in `unit:modular/queries.test.ts`.)
- #145 `rtdb-modular-equalTo-filter.json` — `orderByChild('group') + equalTo('b')` returned `[k2,k4]` (both 'b'-grouped children); no uniqueness enforced.
- #150/#151 `rtdb-modular-limittofirst-vs-limittolast.json` — `limitToFirst(2)` returned `[a,b]` (positions `[1,2]`); `limitToLast(2)` returned `[d,e]` (positions `[4,5]`) on the same 5-child ordered query.
- #148/#149 `rtdb-modular-startafter-endbefore-exclusive.json` — `startAfter(2) + endBefore(5)` returned positions `[3,4]` (cursors `2` and `5` dropped — both bounds are EXCLUSIVE).
- #152 `rtdb-modular-onvalue-with-query.json` — listener on `query(ref, orderByChild('pos'), limitToFirst(2))` fired 3 times: initial `[a,b]`, then on an INSIDE-window mutation (`a` value change), then when a new child `z` displaced `b`. The OUTSIDE-window write to `c/extra` did NOT fire the listener.

### Modular SDK surface — implementation status

The sandbox implementation has landed (`packages/pyric/src/database/modular.ts` + `sandbox/`); rows locked by sandbox unit tests or oracle observations sit at `✓`, and rows still pending implementation sit at `—` (see the per-row tables above for the current status of each). The oracle observations are the spec the sandbox conforms to.

## Probe coverage summary

- **Pure rules engine:** compiler, simulator, grammar, and constraints tests under `packages/pyric/test/rules/rtdb/`.
- **Modular mirror:** focused tests under `packages/pyric/test/database/modular/` plus frozen `rtdb-modular-*` production observations.
- **Archived observations:** legacy `rtdb-*` captures remain immutable historical evidence but no longer contribute rows for the removed production toolkit.

### Harness extension: `ensureOracleRtdbRules`

`packages/conformance/src/run.ts` now deploys an RTDB rules namespace
analogous to `ensureOracleRules` / `ensureOracleStorageRules`. The
JSON shape:
```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "pyric_oracle": {
      ".read": "auth != null",
      ".write": "auth != null",
      "$run": { "$probe": { "list": { ".indexOn": ["pos", "group"] } } }
    }
  }
}
```
The harness mints a separate OAuth token scoped to
`https://www.googleapis.com/auth/firebase.database` (the broader
`firebase` scope used by Firestore + Storage + Management APIs is
NOT accepted by the per-database rules endpoint) and `PUT`s to
`<databaseUrl>/.settings/rules.json?print=silent` with marker-based
idempotency: if `pyric_oracle` is already a top-level key AND the
shape matches `ORACLE_RTDB_RULES_BODY`, the deploy is a no-op;
otherwise the namespace is merged (preserving any other top-level
keys) and a 5s propagation wait runs before the probes start. The
`.indexOn` inside `$run/$probe/list` is what lets the
`orderByChild`/`equalTo`/`startAt` probes run without per-probe
rule modifications.

## Historical simulator-vs-production capture

The frozen `rtdb-simulator-vs-prod-agreement.json` observation recorded 28 agreements and one historical `.validate` disagreement. The current in-process RTDB rules engine evaluates descendant validation rules on writes; row #71 and the simulator tests cover the repaired behavior without editing the frozen observation.



## Current gaps

### Documented divergences

Known differences between Pyric and production Firebase. Each remains tracked as a non-conforming row.

<div class="compat-list compat-list--plain">
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub">Cross-path <code>root.child(…).val()</code> reads return <code>null</code> for paths NOT present in <code>mockData</code> — divergence from real prod rules where the engine reads the live database</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><strong>Divergence (DB-B12, honest doc):</strong> the onChild<em> callbacks do NOT receive the <code>previousChildName</code> second argument; <code>onValue</code>/<code>onChild</em></code> do NOT accept a <code>cancelCallback</code>; <code>onChildAdded</code>/<code>Changed</code>/<code>Removed</code>/<code>Moved</code> accept only plain refs (not <code>Query</code>); <code>child_moved</code> never fires (ordered-query move detection unmodeled). These listener-surface holes are out of scope for the current phase — consumers needing them use <code>firebase/database</code> directly.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>onChildMoved</code> under an ordered query. Prod: fires when a child's <code>orderByChild</code>/<code>orderByValue</code> priority changes — emitted only on ordered queries. Sandbox: <strong>never fires on reorder</strong> — <code>onChildMoved</code> supports the plain-ref (no-fire) case only; the ordered-query overload is unimplemented</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>goOffline(db)</code> — accepted no-op: there is no network connection in the local sandbox to toggle, so nothing is disconnected (we deliberately do NOT simulate a disconnect — pending writes, listeners, and <code>get()</code> keep working)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>goOnline(db)</code> — accepted no-op: there is no connection to reopen (see <code>goOffline</code>)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>forceLongPolling()</code> — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (it never opens a real socket). Accepted so init code that calls it compiles + runs</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>forceWebSockets()</code> — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (see <code>forceLongPolling</code>)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>enableLogging(logger?, persistent?)</code> — accepted no-op: the sandbox has no modular-SDK-style logger to wire a level/sink into (it uses host-level <code>console</code> logging directly, matching <code>pyric/firestore</code>'s <code>setLogLevel</code>). Accepted so init code that calls it compiles + runs</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>refFromURL(db, url)</code> — real alias: parses the path out of the absolute database URL and delegates to <code>ref(db, path)</code>, so the returned ref resolves + reads exactly like <code>ref(db, path)</code>. Divergence: the sandbox is single-database with no host/namespace, so the URL's HOST is NOT validated against the handle (the real SDK throws if the host doesn't match the db's namespace); only the path is honored</span></span></div>
</div>
</div>

### Unsupported

Tracked behavior that is not implemented in the current contract.

<div class="compat-list compat-list--plain">
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed REST host</code><span class="compat-sub">Historical <code>.json</code> REST transport contract for the removed production host.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical admin read and set/get behavior for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical user read return shape for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical rules-denial normalization for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical rules-denied read behavior for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical set/get round trip for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical set-null removal behavior for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical rules-denied write behavior for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical multi-path update behavior for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical push key behavior for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical push auto-ID format for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical remove-versus-set-null behavior for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed data handler</code><span class="compat-sub">Historical idempotent removal behavior for the removed production data handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed rules fetch handler</code><span class="compat-sub">Historical deployed-rules JSON round trip for the removed production fetch handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed rules deployment handler</code><span class="compat-sub">Historical rules deployment propagation timing for the removed production deploy handler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">Removed REST crawler</code><span class="compat-sub">Historical shallow REST response shape for the removed production crawler.</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">simulateRtdbRules(compiled, input)</code><span class="compat-sub">The removed stateful simulator returned a generate-before-simulate error when no IR had been generated</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">An in-module production target is intentionally absent; direct calls with a real <code>FirebaseApp</code> reject with package-resolution guidance</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">Concurrent contention / retry-on-conflict — single-client sandbox doesn't model real concurrency; the documented "up to 25 retries" contract is degenerate (the fn is invoked once)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>getDatabase(ctx)</code> returns a tagged sandbox-target handle (frozen identity)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>getDatabase(sandbox)</code> returns a tagged sandbox-live handle (per-op identity)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">Two <code>getDatabase(sandbox)</code> calls share state (same underlying <code>LocalEnvironment</code>)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">Handle dispatch by <code>TARGET_SYMBOL</code> brand — refs route to their owning target via a <code>refToTarget</code> WeakMap (mirror of firestore's pattern)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">Unknown ref (not produced by this package) → <code>TypeError</code> in shim ops</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">No-op on sandbox-target handles (the sandbox IS the local emulator)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">A production target is intentionally absent; production code continues to use <code>connectDatabaseEmulator</code> from the unchanged <code>firebase/database</code> package</span></span></div>
</div>
</div>

### Unverified

Tracked behavior whose available evidence does not yet establish the production result.

<div class="compat-list compat-list--plain">
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">Inactive canonical <code>firebase/database</code> imports remain the upstream package; the mirror does not create tagged production targets</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>ref(db, path)</code> returns a tagged <code>DatabaseReference</code> carrying <code>key</code>, <code>parent</code>, <code>root</code>, <code>toString()</code></span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>ref(db)</code> with no path returns the root ref (<code>key === null</code>, <code>parent === null</code>)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>child(ref, 'a/b')</code> joins a relative path, including embedded slashes</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>ref.parent</code> is <code>null</code> at root, otherwise the parent ref</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior"><code>ref.key</code> is the final path segment, <code>null</code> for root</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">Replaces the value at the path entirely; resolves to <code>undefined</code> (unlike <code>setDoc</code> which resolves to <code>void</code>, RTDB's <code>set</code> is documented as <code>Promise&lt;void&gt;</code>)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">Update path validation — overlapping paths (e.g. <code>'/a'</code> and <code>'/a/x'</code> in the same call) throws synchronously before any write</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">The returned value from <code>onValue(ref, cb)</code> is the unsubscribe function (NOT an object); calling it removes the listener</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">off(ref, eventType, callback)</code><span class="compat-sub">When the same callback is registered more than once, each <code>off(ref, eventType, callback)</code> removes one registration without orphaning the others</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">Two concurrent <code>increment</code> calls interleave correctly (last-write-wins is NOT the contract — both deltas accumulate)</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><span class="compat-behavior">Concurrent contention — if another client writes between the read and write, the update fn is retried with the new current value (typically up to 25 retries by default)</span></span></div>
</div>
</div>

## Reviewed public-runtime gaps

These classifications are generated from the machine-readable surface contract used by the census and `can-i-use`.

| Disposition | Availability | Symbols | Reason | Evidence |
|---|---|---|---|---|
| database.runtime-class-values | deferred | `DataSnapshot`, `Database`, `QueryConstraint`, `TransactionResult` | These Firebase classes are mirrored structurally in Pyric's type surface but are not exported as runtime constructor values; runtime identity remains unbuilt. | upstream:firebase/database |
| database.connection-lifecycle | deferred | `OnDisconnect`, `onDisconnect` | onDisconnect requires a live connection lifecycle the in-memory sandbox has no equivalent for today — buildable as an honest no-op or inert token like the connection-management APIs, not genuinely un-modelable. | registry:rtdb-modular#163 |
| database.priority-ordering | deferred | `orderByPriority`, `setPriority`, `setWithPriority` | Firebase's legacy priority ordering system is absent; the sandbox exposes orderByChild/Key/Value only today. Priority ordering is data-modelable as a sort key, so this is revisitable scope rather than a hard sandbox limitation. | upstream:firebase/database |
