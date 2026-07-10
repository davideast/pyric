---
title: "@pyric/rtdb compatibility matrix"
navLabel: "Realtime Database"
group: "Compatibility"
section: ""
order: 31
---
<!-- Generated from scripts/compat/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `@pyric/rtdb` compatibility matrix

> ⚠ **EXPERIMENTAL — not v1-supported.** `@pyric/rtdb` is functional but
> work-in-progress. The v1-supported, conformance-held surface is **auth +
> firestore + rules**. The modular `firebase/database` shim rows below are
> verified **sandbox-side** by unit probes — they are NOT wrong — but most are
> **not yet captured against a live prod project** (no `oracle:` citation), so
> conformance is best-effort, not guaranteed. Don't depend on RTDB parity for a
> production swap yet.

The single readable contract for "what this package guarantees vs the
production Firebase Realtime Database surface."

`@pyric/rtdb` covers **two surfaces** that share the package:

1. **Agent-tool surface (shipped today).** The factory +
   rule-authoring DSL — the 11 agent tools returned by
   `createRtdbAdminTools({ host })` (`rtdb_get`, `rtdb_set`,
   `rtdb_update`, `rtdb_push`, `rtdb_delete`, `rtdb_get_rules`,
   `rtdb_deploy_rules`, `rtdb_crawl_structure`,
   `rtdb_simulate_access`, `rtdb_validated_write`,
   `rtdb_build_expression`); the lower-level `getRtdbTools(host)`
   programmatic API; the `RtdbHost` contract and `fetchDatabase`
   REST helper; the constraint authoring surface (`atoms`,
   `policies`, `compose`, `ruleset`); the IR / simulator / mapper
   internals.
2. **Modular SDK surface.** A `firebase/database`
   modular shim — `getDatabase`, `ref`, `get`, `set`, `update`,
   `remove`, `push`, `onValue`, `runTransaction`, `query` constraints,
   sentinels, etc. — mirroring how `pyric/auth`, `pyric/firestore`,
   `pyric/storage` ship both an agent-tool surface AND a modular
   SDK surface in one package. The sandbox implementation lives in
   `packages/pyric/src/database/modular.ts` + `packages/pyric/src/database/sandbox/`;
   the matrix below tracks which rows the sandbox locks (✓) vs. those
   still pending implementation (—). Oracle probes capture prod
   behavior so the sandbox is correct by construction.

The package wraps two real services:

- The **RTDB REST API** for admin-mode data ops and rules deploy
  (`fetchDatabase` → `${databaseUrl}<path>.json?…`).
- The **`firebase/database` modular SDK** for user-mode data ops
  (via `host.getClientForUser(auth)`).
- The **`firebase-admin/database` SDK** for admin-mode data ops in
  the data handler.

The conformance oracle for this package therefore observes a
mixture: REST-shape claims (status codes, response bodies) and
`firebase/database` SDK-shape claims (ref/get/set/onValue/push
semantics). The sandbox-vs-prod axis is much smaller here than in
`pyric/auth` or `pyric/firestore` because there is no in-process
RTDB sandbox — the package goes directly to the real service. The
relevant divergence axis is **simulator-vs-prod-rules-engine** for
the rule-evaluation surface.

See the design rationale for the methodology
(vocabulary of conformance / oracle / matrix; how to add rows;
how the runner attributes failures).

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — observable behavior matches the wrapped service, locked by a passing probe |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match the wrapped service but doesn't; failing probe pins it |
| — | **Unsupported** — not implemented yet (deliberately or pending) |
| ? | **Unverified** — claim from docs / source that we haven't yet observed against the live service |

Probe references: `unit:<file>` means a Bun test in
`packages/pyric/test/database/<file>`. `oracle:<obs>` means an observation
under `scripts/oracle/observations/<obs>.json`.

Targets:
- **admin** — operations run via `firebase-admin/database` or the
  REST `access_token=…` path. Rules bypassed.
- **user** — operations run via `host.getClientForUser(auth)`
  (`firebase/database` modular SDK) or REST `auth=…`. Rules
  enforced.
- **simulator** — the in-process rule evaluator
  (`SimulateHandler` + the Ohm-based RTDB expression grammar).
  Acts as the oracle for "would prod allow this?" questions
  without round-tripping.

---

## `RtdbHost` contract + `fetchDatabase`

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">1</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>fetchDatabase(host, path)</code> (no userToken) calls the URL <code>&lt;databaseUrl&gt;&lt;path&gt;?access_token=&lt;adminToken&gt;</code></div>
<div class="compat-probe"><code>unit:host.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">2</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>fetchDatabase(host, path, params, userToken)</code> uses <code>auth=&lt;userToken&gt;</code> (NOT <code>access_token</code>) and does NOT call <code>resolveAdminToken()</code></div>
<div class="compat-probe"><code>unit:host.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">3</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Extra <code>params</code> are merged into the URL query string alongside the auth param</div>
<div class="compat-probe"><code>unit:host.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">4</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>host.databaseUrl</code> is concatenated as a prefix to the path</div>
<div class="compat-probe"><code>unit:host.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">5</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">REST endpoints respond on <code>&lt;databaseUrl&gt;&lt;path&gt;.json</code> — <code>.json</code> suffix is the RTDB REST contract</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-rest-json-suffix-contract.json</code> — <code>&lt;path&gt;.json</code> returned <code>application/json; charset=utf-8</code> and round-tripped the seeded payload; the same URL WITHOUT the <code>.json</code> suffix returned <code>text/html; charset=utf-8</code> (the Google sign-in redirector page). Locks the <code>.json</code>-suffix contract every handler that calls <code>fetchDatabase</code> depends on.</div>
</div>
</div>
</div>

## `getRtdbTools(host)` — programmatic surface

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">6</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns an object with the 11 methods listed in the <code>RtdbTools</code> interface (<code>generateIR</code>, <code>simulate</code>, <code>writeRules</code>, <code>crawlStructure</code>, <code>readData</code>, <code>setData</code>, <code>updateData</code>, <code>pushData</code>, <code>removeData</code>, <code>validatedWrite</code>)</div>
<div class="compat-probe"><code>unit:resolver.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">7</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>simulate()</code> returns <code>IR_NOT_GENERATED</code> until <code>generateIR()</code> has been called and cached the IR</div>
<div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">8</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">After a successful <code>generateIR()</code>, the resolver caches the IR for subsequent <code>simulate()</code> calls</div>
<div class="compat-probe"><code>unit:resolver.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">9</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>crawlStructure({ auth })</code> resolves the user token via <code>host.resolveUserToken</code> before crawling; a token-resolution failure surfaces as <code>PERMISSION_DENIED</code></div>
<div class="compat-probe"><code>unit:resolver.test.ts</code></div>
</div>
</div>
</div>

## `rtdb_get` / `readData(path)` — single-path read

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">10</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Admin mode returns <code>{ success: true, data: &lt;value or null&gt; }</code>; uses <code>firebase-admin/database</code> <code>ref(path).get().val()</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code>; oracle: <code>scripts/oracle/observations/rtdb-handler-admin-vs-user-returnshape.json</code> — admin-SDK <code>ref(path).get().val()</code> returned the exact seeded payload, wrapped as <code>{ success: true, data: &lt;value&gt; }</code>.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">11</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">User mode returns <code>{ success: true, data: &lt;value or null&gt; }</code>; uses <code>firebase/database</code> modular <code>get(ref(db, path)).val()</code> via <code>host.getClientForUser(auth)</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code>; oracle: <code>scripts/oracle/observations/rtdb-handler-admin-vs-user-returnshape.json</code> — <code>shapesAgree: true</code> between admin and modular paths against blockingfun (same <code>data</code> value, same <code>success: true</code> shape).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">12</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>null</code> at the path (empty / missing) round-trips as <code>data: null</code> (NOT a not-found error) — matches <code>DataSnapshot.val()</code> returning <code>null</code> for absent paths</div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code> ("admin GET returns null for empty path")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">13</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Any thrown error in admin mode is wrapped as <code>{ success: false, error: { code: 'READ_FAILED', recoverable: false } }</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">14</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Rules-denied user-mode <code>get</code>/<code>set</code>/<code>update</code>/<code>push</code>/<code>remove</code> surface as <code>{ success: false, error: { code: 'PERMISSION_DENIED', recoverable: false } }</code> — the handler inspects the caught error before the generic <code>READ_FAILED</code> / <code>WRITE_FAILED</code> wrap and preserves the <code>PERMISSION_DENIED</code> signal. The inspection matches both <code>(err.code === 'PERMISSION_DENIED')</code> and <code>(err.message.toLowerCase().includes('permission_denied'))</code> so it covers the uppercase <code>set/get/remove</code> shape AND the lowercase <code>runTransaction</code> shape from oracle row #15 / M37e. Non-rules errors (network, token mint, etc.) still surface as <code>READ_FAILED</code> / <code>WRITE_FAILED</code>.</div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code> ("rules-denied GET/SET/REMOVE surfaces as PERMISSION_DENIED", "non-rules error for GET/SET still surfaces as READ_FAILED/WRITE_FAILED", "transaction-shaped rules-denied (lowercase message, no .code) surfaces as PERMISSION_DENIED"); oracles cited: <code>scripts/oracle/observations/rtdb-rules-denied-error-code.json</code> + <code>scripts/oracle/observations/rtdb-modular-runtransaction-on-rules-denied-path.json</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">15</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Rules-denied read against the real RTDB throws on the modular SDK side with <code>code: 'PERMISSION_DENIED'</code> and message <code>PERMISSION_DENIED: Permission denied</code>. The thrown value is a <strong>plain <code>Error</code></strong> (not a <code>FirebaseError</code>) — <code>.name === 'Error'</code>, <code>.constructor.name === 'Error'</code> — diverging from Firestore/Auth which throw <code>FirebaseError</code>.</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-rules-denied-error-code.json</code> (<code>code: 'PERMISSION_DENIED'</code>, <code>errorName: 'Error'</code>, <code>constructorName: 'Error'</code>, <code>isErrorInstance: true</code> against blockingfun, fb-js-sdk 12.13.0; observed on the <code>set</code> path — the <code>get</code>/<code>set</code> paths share the same error-emit code in firebase/database)</div>
</div>
</div>
</div>

## `rtdb_set` / `setData(path, data)` — full overwrite

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">16</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Admin mode replaces the value at the path entirely; resolves <code>{ success: true, data: null }</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">17</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">User mode replaces via the modular SDK's <code>set(ref, data)</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">18</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Setting <code>null</code> at a path is equivalent to removing it (matches RTDB's documented behavior)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-remove-vs-set-null.json</code> — observed <code>afterRemove: null === afterSetNull: null</code> against blockingfun, fb-js-sdk 12.13.0; sandbox-aligned: <code>unit:modular/sandbox-target.test.ts</code> ("remove and set(null) produce identical end-state")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">19</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Errors on either path wrap as <code>{ success: false, error: { code: 'WRITE_FAILED', recoverable: false } }</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">20</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Rules-denied write against the real RTDB throws with <code>code: 'PERMISSION_DENIED'</code> (uppercase, snake-case — distinct from Firestore's lowercase-kebab <code>'permission-denied'</code>) and message <code>PERMISSION_DENIED: Permission denied</code>. The thrown value is a <strong>plain <code>Error</code></strong>, not a <code>FirebaseError</code>.</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-rules-denied-error-code.json</code> (against blockingfun, fb-js-sdk 12.13.0)</div>
</div>
</div>
</div>

## `rtdb_update` / `updateData(path, data)` — partial / multi-location update

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">21</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Admin mode merges top-level keys at the path; resolves <code>{ success: true, data: null }</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">22</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">User mode merges via the modular SDK's <code>update(ref, data)</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">23</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">When <code>path === '/'</code> and <code>data</code> keys are root-relative paths (e.g. <code>{ '/users/alice/name': 'A', '/posts/p1/author': 'alice' }</code>), the underlying SDK performs an atomic fan-out write at every listed path</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-update-multipath-atomic.json</code> — <code>update(parentRef, { 'a/x': 1, 'b/y': 2 })</code> landed both writes; see also <code>rtdb-modular-update-multipath-rules-denial.json</code> for the atomic rollback when one path is denied. Sandbox-aligned: <code>unit:modular/sandbox-target.test.ts</code> ("writes every listed path atomically" + "rejects the entire update if rules deny any one path")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">24</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Update operations are validated for syntax (overlapping paths, invalid characters) by the underlying SDK; surface as <code>WRITE_FAILED</code></div>
<div class="compat-probe">Sandbox aligned: locked by unit test <code>packages/pyric/test/database/modular/sandbox-target.test.ts</code> ("rejects overlapping paths") — descendant-path overlap throws before any path is written</div>
</div>
</div>
</div>

## `rtdb_push` / `pushData(path, data)` — auto-id append

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">25</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Admin mode returns <code>{ success: true, data: { key: &lt;auto-id&gt; } }</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">26</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">User mode returns <code>{ success: true, data: { key: &lt;auto-id&gt; } }</code> via <code>push(ref, data).key</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">27</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Auto-id format is RTDB's "push ID": 20 characters, starts with <code>-</code>, lexicographically sortable, timestamp-prefixed (encodes the millisecond timestamp at the time of generation)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-push-autoid-format.json</code> (against blockingfun, fb-js-sdk 12.13.0: 3 sequential <code>push()</code> calls returned 20-char keys (<code>-OsshG1AxGukSGUYn_De</code>, <code>-OsshG1GZ2pAt7bveAWv</code>, <code>-OsshG1NmrNFxZuwufff</code>), all starting with <code>-</code>. The <code>push.key</code> is minted client-side from the millisecond timestamp + randomness — it's available immediately even when the subsequent server write is denied by rules.)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">28</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Two <code>push</code> calls in quick succession produce monotonically sortable keys (the timestamp prefix guarantees order)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-push-autoid-format.json</code> (<code>monotonicallySorted: true</code> across 3 keys generated ~5ms apart)</div>
</div>
</div>
</div>

## `rtdb_delete` / `removeData(path)` — delete

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">29</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Admin mode removes the value and all children; resolves <code>{ success: true, data: null }</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">30</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">User mode removes via the modular SDK's <code>remove(ref)</code></div>
<div class="compat-probe"><code>unit:data/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">31</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>remove(ref)</code> and <code>set(ref, null)</code> produce the same end state (no path remains, <code>get</code> returns <code>null</code>)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-remove-vs-set-null.json</code> — observed <code>bothNull: true, equivalent: true</code> against blockingfun; sandbox-aligned: <code>unit:modular/sandbox-target.test.ts</code> ("remove and set(null) produce identical end-state")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">32</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Removing a non-existent path is a no-op that resolves successfully (matches RTDB's idempotent delete semantics)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-remove-idempotent.json</code> — <code>remove</code> on a never-written path observed <code>threw: false, afterExists: false</code>; sandbox-aligned: <code>unit:modular/sandbox-target.test.ts</code> ("removing a non-existent path is a no-op")</div>
</div>
</div>
</div>

## `rtdb_get_rules` / `generateIR()` — fetch + parse rules

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">33</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Fetches <code>/.settings/rules.json</code> AND <code>/.json?shallow=true</code> in parallel, then maps to an <code>RtdbIR</code> tree</div>
<div class="compat-probe"><code>unit:ir/handler.test.ts</code> ("hits both /.settings/rules.json and /.json")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">34</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns <code>RULES_FETCH_FAILED</code> when <code>/.settings/rules.json</code> returns 403 (insufficient admin permissions)</div>
<div class="compat-probe"><code>unit:ir/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">35</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns <code>RULES_PARSE_FAILED</code> when the rules response body is not valid JSON</div>
<div class="compat-probe"><code>unit:ir/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">36</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns success even when <code>/.json?shallow=true</code> returns 404 (proceeds with <code>null</code> shallow data, <code>rules.exists === false</code>)</div>
<div class="compat-probe"><code>unit:ir/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">37</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">The returned IR has <code>service === 'realtime-database'</code> and <code>databaseUrl === host.databaseUrl</code></div>
<div class="compat-probe"><code>unit:ir/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">38</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">The IR tree's root node carries <code>read</code>/<code>write</code>/<code>validate</code> expressions parsed via the Ohm grammar; expressions expose <code>parsed.valid</code> + error list</div>
<div class="compat-probe"><code>unit:ir/handler.test.ts</code>, <code>unit:mapper.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">39</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Top-level rule structure (e.g. <code>rules</code> wrapper, <code>.read</code>/<code>.write</code>/<code>.validate</code> keys, path-variable segments <code>$userId</code>) is parsed identically to how the REST <code>rules.json</code> PUT endpoint accepts it</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-rules-json-roundtrip.json</code> — PUT a rules subtree containing <code>$userId</code> path-variable segments, <code>.indexOn: ['createdAt', 'name']</code>, plus <code>.read</code>/<code>.write</code>/<code>.validate</code> expressions; GET-back returned <code>exactRoundTrip: true</code> (byte-for-byte JSON equality). Confirms the deploy / fetch shape is identical to what <code>RtdbMapper.mapToRulesJSON</code> and <code>mapToIR</code> expect.</div>
</div>
</div>
</div>

## `rtdb_deploy_rules` / `writeRules(ir)` — deploy rules

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">40</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Maps the IR to a rules-JSON payload via <code>RtdbMapper.mapToRulesJSON(ir)</code> and PUTs to <code>&lt;databaseUrl&gt;/.settings/rules.json?access_token=&lt;admin&gt;</code></div>
<div class="compat-probe"><code>unit:write/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">41</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns <code>{ success: true }</code> on HTTP 200</div>
<div class="compat-probe"><code>unit:write/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">42</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns <code>{ success: false, error: { code: 'PERMISSION_DENIED' } }</code> on HTTP 403</div>
<div class="compat-probe"><code>unit:write/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">43</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns <code>{ success: false, error: { code: 'INVALID_RULES_JSON', recoverable: true } }</code> on HTTP 400 (includes the response body in <code>message</code>)</div>
<div class="compat-probe"><code>unit:write/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">44</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns <code>{ success: false, error: { code: 'WRITE_FAILED' } }</code> for any other non-OK status</div>
<div class="compat-probe"><code>unit:write/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">45</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Any thrown exception during fetch is caught and wrapped as <code>WRITE_FAILED</code></div>
<div class="compat-probe"><code>unit:write/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">46</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Live RTDB rules-PUT endpoint takes a few seconds to propagate before subsequent reads/writes are evaluated under the new rules</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-rules-deploy-propagation-timing.json</code> — deployed a permissive rule then polled writes at 200ms intervals; the FIRST write succeeded at <code>firstSuccessElapsedMs: 154</code> (observed once against blockingfun on fb-js-sdk 12.13.0). Both <code>within5s: true</code> and <code>within10s: true</code>; the harness's current 5s wait is comfortably above the observed bound. Note: a single observation isn't a guaranteed upper bound; propagation can vary with load.</div>
</div>
</div>
</div>

## `rtdb_crawl_structure` / `crawlStructure(options)` — shape discovery

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">47</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Defaults to <code>path: '/'</code>, <code>maxDepth: 10</code>, <code>maxChildren: 100</code>, <code>maxConcurrency: 5</code> (from <code>CRAWL_DEFAULTS</code>)</div>
<div class="compat-probe"><code>unit:crawl/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">48</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Recursively fetches <code>&lt;path&gt;.json?shallow=true</code> at each level; uses <code>value === true</code> to identify object children and recurse</div>
<div class="compat-probe"><code>unit:crawl/handler.test.ts</code> ("schema excludes object children (value === true)")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">49</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Leaf primitive values (non-true, non-null) populate <code>node.schema[key]</code> with their <code>typeof</code></div>
<div class="compat-probe"><code>unit:crawl/handler.test.ts</code> ("schema infers types from leaf primitive values")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">50</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">A leaf primitive at the crawled path itself sets <code>node.valueType</code> rather than recursing</div>
<div class="compat-probe"><code>unit:crawl/handler.test.ts</code> ("leaf primitive node has valueType set")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">51</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">A child node that returns only true-marked keys (the RTDB shallow representation of a nested object) is recursed; the schema of that child is populated from grandchild leaves</div>
<div class="compat-probe"><code>unit:crawl/handler.test.ts</code> ("schema populated from children that are leaf primitives")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">52</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">403 at the root returns <code>{ success: false, error: { code: 'PERMISSION_DENIED' } }</code></div>
<div class="compat-probe"><code>unit:crawl/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">53</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">403 at a child returns an empty node (<code>childCount: 0</code>, <code>children: []</code>) rather than failing the whole crawl</div>
<div class="compat-probe"><code>unit:crawl/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">54</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">A network error mid-crawl at a child returns an empty node for that subtree; the rest of the crawl proceeds</div>
<div class="compat-probe"><code>unit:crawl/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">55</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>maxDepth</code> truncates: deeper nodes are reported with <code>childCount</code> set but <code>children: []</code></div>
<div class="compat-probe"><code>unit:crawl/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">56</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>maxChildren</code> exceeded → <code>truncated: true</code> on that node</div>
<div class="compat-probe"><code>unit:crawl/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">57</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>maxConcurrency</code> is enforced via a semaphore — concurrent in-flight fetches never exceed the limit</div>
<div class="compat-probe"><code>unit:crawl/handler.test.ts</code> ("concurrency is respected")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">58</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Live RTDB <code>shallow=true</code> REST response shape: object → object with keys mapped to <code>true</code>; leaf primitive → the primitive itself; missing path → <code>null</code></div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-shallow-rest-response-shape.json</code> — seeded <code>{ obj: { a, b, c }, leaf: 'hello', leafNum: 42, leafBool: true }</code>, then GET with <code>?shallow=true</code> at each path: object node returned <code>{ a: true, b: true, c: true }</code> (all keys → <code>true</code>), string leaf returned the string <code>'hello'</code>, numeric leaf returned <code>42</code>, boolean leaf returned <code>true</code>, missing path returned <code>null</code>. Locks every assumption the <code>CrawlStructureHandler</code> depends on.</div>
</div>
</div>
</div>

## `rtdb_simulate_access` / `simulate(input)` — in-process rule evaluator

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">59</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns <code>{ success: false, error: { code: 'IR_NOT_GENERATED' } }</code> when called before <code>generateIR()</code></div>
<div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">60</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns <code>{ success: false, error: { code: 'INVALID_INPUT' } }</code> when input doesn't parse against <code>SimulationInputSchema</code> (e.g. path missing leading slash, operation not in read / write / validate)</div>
<div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">61</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Walks ancestors from root → target; the first ancestor whose rule expression evaluates to <code>true</code> grants access — matches RTDB's documented "rules cascade from root, true at any ancestor grants" semantics</div>
<div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">62</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Path variables (<code>$userId</code>) are bound from the URL path and exposed in <code>pathVariableBindings</code> (also without the <code>$</code> prefix for ergonomic access in expressions)</div>
<div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">63</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>auth</code> context: when <code>null</code>, <code>auth</code> is null inside expressions; when present, <code>auth.uid</code> and <code>auth.token.*</code> are bound</div>
<div class="compat-probe"><code>unit:simulation/handler.test.ts</code>, <code>unit:grammar/simulator.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">64</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>mockData</code> becomes the value of <code>data</code> at every path during evaluation; <code>newData</code> is the proposed value for write/validate</div>
<div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">65</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>data.child("…")</code>, <code>data.parent()</code>, <code>data.exists()</code>, <code>data.val()</code> evaluate against the in-process snapshot — matches the documented <code>DataSnapshot</code> rule-context surface</div>
<div class="compat-probe"><code>unit:grammar/simulator.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="diverged">
<span class="compat-num">66</span>
<span class="compat-dot" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span>
<div class="compat-main">
<div class="compat-behavior">Cross-path <code>root.child(…).val()</code> reads return <code>null</code> for paths NOT present in <code>mockData</code> — divergence from real prod rules where the engine reads the live database</div>
<div class="compat-probe">divergence: the simulator uses ONLY what's in <code>mockData</code>. Real rules engine reads from the live RTDB. Documented in <code>validated.ts</code> ("simulation uses empty mockData, so cross-path rule lookups … will evaluate as false")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">67</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">An expression that fails to parse (<code>parsed.valid === false</code>) is skipped — the simulator falls through to the next ancestor</div>
<div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">68</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">When no ancestor rule allows, the result is <code>{ allowed: false }</code> with <code>matchedPath</code> set to the deepest matched node</div>
<div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">69</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">When NO ancestor has a rule for the operation at all, returns <code>{ success: false, error: { code: 'NO_MATCHING_RULE' } }</code></div>
<div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">70</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Evaluation errors (grammar mismatch, unknown identifier) surface as <code>EVALUATION_ERROR</code></div>
<div class="compat-probe"><code>unit:simulation/handler.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">71</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Simulator's allow/deny decision matches the real RTDB rules engine for the same <code>{ rules, mockData, auth, operation, path, newData }</code> tuple, modulo the documented cross-path divergence on row #66</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-simulator-vs-prod-agreement.json</code> — 8 test rules × 29 (rule, op) tuples; 28 agreements, 1 disagreement at capture time (<code>r4-validate-structure</code>: the simulator did not evaluate <code>.validate</code> on writes). The <code>.validate</code> walk is now implemented (<code>src/database/simulation/handler.ts</code>, reached from all backend write sites; grammar array-literals + <code>hasChildren(keys)</code> fixed alongside), closing the recorded disagreement — replayed as prod-conforming denial in <code>oracle-conformance.test.ts</code>. The frozen capture documents the historical divergence</div>
</div>
</div>
</div>

## `rtdb_validated_write` / `validatedWrite(input)` — preflighted write

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">72</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Crawls the structure at <code>path</code> to infer schema; collects <code>SchemaWarning[]</code> for <code>type_mismatch</code> (existing key with different type) and <code>new_field</code> (key not seen before)</div>
<div class="compat-probe"><code>unit:data/validated.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">73</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Simulates the write against the IR's rules using <code>mockData: {}</code> and the supplied <code>auth</code></div>
<div class="compat-probe"><code>unit:data/validated.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">74</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Admin mode (no <code>auth</code>): simulation denial returns <code>{ success: false, error: { code: 'SIMULATION_DENIED', recoverable: true } }</code> — blocks the live write</div>
<div class="compat-probe"><code>unit:data/validated.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">75</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">User mode (<code>auth</code> provided): simulation denial is advisory only — the live write still runs because real rules will enforce against the actual database, where cross-path lookups can succeed</div>
<div class="compat-probe"><code>unit:data/validated.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">76</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">After preflight, the actual write is dispatched through <code>DataHandler.execute</code> with the original <code>auth</code></div>
<div class="compat-probe"><code>unit:data/validated.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">77</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Schema warnings are returned even on success — they're advisory, not blocking</div>
<div class="compat-probe"><code>unit:data/validated.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">78</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">A failed crawl is swallowed — the handler proceeds with no schema warnings and an unchecked write</div>
<div class="compat-probe"><code>unit:data/validated.test.ts</code></div>
</div>
</div>
</div>

## `rtdb_build_expression` — rule expression authoring

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">79</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns a <code>RtdbRuleExpression</code> with <code>raw</code>, <code>parsed.valid</code>, <code>parsed.errors</code>, <code>parsed.warnings</code>, <code>parsed.referencedIdentifiers</code></div>
<div class="compat-probe"><code>unit:mapper.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">80</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">A syntactically valid expression sets <code>parsed.valid === true</code> and lists referenced identifiers (<code>auth</code>, <code>auth.uid</code>, <code>data</code>, etc.)</div>
<div class="compat-probe"><code>unit:mapper.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">81</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">A syntactically invalid expression sets <code>parsed.valid === false</code> and populates <code>parsed.errors</code> with <code>{ code, message }</code></div>
<div class="compat-probe"><code>unit:mapper.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">82</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Linter warnings (e.g. always-true expressions, missing <code>auth</code> checks) populate <code>parsed.warnings</code></div>
<div class="compat-probe"><code>unit:grammar/linter.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">83</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">The grammar accepts every documented RTDB rule operator: logical (<code>&amp;&amp;</code>, <code>or</code>, <code>!</code>), equality (<code>==</code>, <code>===</code>, <code>!=</code>), comparison (<code>&lt;</code>, <code>&lt;=</code>, <code>&gt;</code>, <code>&gt;=</code>), arithmetic (<code>+</code>, <code>-</code>, <code>*</code>, <code>/</code>, <code>%</code>), ternary <code>?:</code>, member access, function call, string/regex literals</div>
<div class="compat-probe"><code>unit:grammar/RtdbExprParser.test.ts</code></div>
</div>
</div>
</div>

## Constraint authoring surface (`atoms` / `policies` / `compose` / `ruleset`)

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">84</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>atoms</code> exports the documented set of primitive predicates (<code>authenticated</code>, <code>ownPath</code>, <code>ownField</code>, <code>isNew</code>, <code>hasChildren</code>, <code>hasChild</code>, <code>fieldIsString/Number/Boolean</code>, <code>fieldEnum</code>, <code>immutable</code>, <code>immutableSelf</code>, <code>rootExists</code>, <code>rootEquals</code>) — each returns an <code>Expr</code></div>
<div class="compat-probe"><code>unit:constraints/atoms.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">85</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>policies</code> exports composite predicates that compose atoms: <code>pathOwnerOnly</code>, <code>fieldOwnerOnly</code>, <code>ownerOrNew</code>, <code>hasRole</code>, <code>isMember</code>, <code>required</code>, <code>transition</code></div>
<div class="compat-probe"><code>unit:constraints/policies.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">86</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>compose</code> exports the boolean combinators <code>all</code>, <code>any</code>, <code>not</code>, <code>deny</code>, <code>always</code>, plus the raw <code>expr</code> constructor</div>
<div class="compat-probe"><code>unit:constraints/compose.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">87</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>ruleset(...)</code> builds an RTDB rules JSON object from a tree of path definitions + expression objects</div>
<div class="compat-probe"><code>unit:constraints/ruleset.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">88</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Game-domain helpers (<code>turnGuard</code>, <code>flip</code>, <code>winCheckHelper</code>) compose into legal rule expressions</div>
<div class="compat-probe"><code>unit:constraints/game.test.ts</code></div>
</div>
</div>
</div>

## `RtdbMapper` — IR ↔ rules-JSON

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">89</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>mapToIR(rulesJson, shallowData, databaseUrl)</code> produces an <code>RtdbIR</code> tree where each node carries its path, parsed expressions, and child nodes</div>
<div class="compat-probe"><code>unit:mapper.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">90</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>mapToRulesJSON(ir)</code> is the inverse: produces a rules-JSON payload accepted by the <code>/.settings/rules.json</code> PUT endpoint</div>
<div class="compat-probe"><code>unit:mapper.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">91</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Round-trip <code>mapToIR(mapToRulesJSON(ir))</code> produces an equivalent IR (locked path/expression-text equality, not object identity)</div>
<div class="compat-probe"><code>unit:mapper.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">92</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Path-variable segments (<code>$userId</code>, <code>$gameId</code>) preserved across the round-trip</div>
<div class="compat-probe"><code>unit:mapper.test.ts</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">93</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>.indexOn</code> arrays preserved across the round-trip</div>
<div class="compat-probe"><code>unit:mapper.test.ts</code></div>
</div>
</div>
</div>

---

## Modular SDK surface (Phase 3)

The modular surface mirrors `firebase/database`'s tree-shakable
free-function shape (`getDatabase`, `ref`, `child`, `get`, `set`,
`update`, `remove`, `push`, `onValue`, `serverTimestamp`,
`connectDatabaseEmulator`). Three backends dispatch on what's passed
to `getDatabase`:

- **Sandbox** — `getDatabase(ctx: SandboxContext)`. Frozen identity
  baked into the handle at construction; ops route to `RtdbBackend`
  (in-memory JSON tree + the `@pyric/rtdb` rule simulator).
- **Sandbox-live** — `getDatabase(sandbox: Sandbox)`. Identity read
  per-op from `sandbox.currentUser`; `pyric/auth` sign-ins flip the
  next op's `request.auth` without re-binding the handle.
- **Prod** — `getDatabase(app: FirebaseApp)`. Delegates to
  `firebase/database`.

Dispatch lives in `packages/pyric/src/database/modular.ts`; the sandbox backend
in `packages/pyric/src/database/sandbox/` (data-tree, rules-eval glue, sentinel
resolver, push-ID generator). The sandbox backend reuses the existing
`SimulateHandler` for rule evaluation — no separate engine.

Rows below are scoped to the modular surface; the agent-tool rows
above (#1–#93) describe the IR / handler / rules-DSL surface that
remains unchanged.

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">M1</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>getDatabase(ctx)</code> builds a sandbox-target <code>Database</code>; frozen <code>ctx.auth</code> baked in</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("getDatabase(ctx) returns a tagged Database handle")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M2</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>getDatabase(sandbox)</code> builds a sandbox-live target; reads <code>sandbox.currentUser</code> per op</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("reads sandbox.currentUser at op time, not at getDatabase time")</div>
</div>
</div>
<div class="compat-row" data-status="unsupported">
<span class="compat-num">M3</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior"><code>getDatabase(app)</code> builds a prod target; delegates to <code>firebase/database.getDatabase(app)</code></div>
<div class="compat-probe">not yet locked by a prod-target integration test (firestore template covers the pattern; rtdb-side defers to Tier 5)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M4</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>ref(db, path?)</code> returns a path-tagged <code>DatabaseReference</code>; default is root</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("ref(db) returns a root ref" + "ref(db, ...) returns a path ref")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M5</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>child(ref, 'sub/path')</code> composes paths; result inherits the parent's target</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("child(ref, 'sub') composes paths")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M6</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>ref.parent</code> returns the parent ref; <code>root.parent === null</code></div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("ref.parent returns the parent ref; root.parent is null")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M7</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>ref.root</code> returns the root ref of the same target</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("ref.root returns the root ref")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M8</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>get(ref)</code> returns a <code>DataSnapshot</code>-shaped object with <code>val()</code>, <code>exists()</code>, <code>key</code>, <code>child()</code>, <code>hasChildren()</code>, <code>numChildren()</code>, <code>toJSON()</code></div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> (snapshot shape tests)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M9</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>get</code> on an absent path resolves to <code>{ val: null, exists: false }</code> (matches <code>DataSnapshot.val()</code> contract)</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("reads return null for an absent path")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M10</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>set(ref, value)</code> replaces the value at the path</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("round-trips a primitive value" + "round-trips nested objects"); matches oracle observation <code>scripts/oracle/observations/rtdb-set-then-get-roundtrip.json</code> (prod observation blocked on rules; sandbox locks the contract directly)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M11</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>set(ref, null)</code> deletes the subtree at the path</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("set(ref, null) deletes the path"); matches oracle observation <code>scripts/oracle/observations/rtdb-remove-vs-set-null.json</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M12</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>remove(ref)</code> is equivalent to <code>set(ref, null)</code> (same end state)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("remove and set(null) produce identical end-state"); matches oracle observation <code>scripts/oracle/observations/rtdb-remove-vs-set-null.json</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M13</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>update(ref, patch)</code> shallow-merges top-level keys at the ref's path</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("shallow-merges top-level keys")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M14</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>null</code> value in a shallow update deletes that key</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("null values in a shallow update delete the key")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M15</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>update(rootRef, { '/a/x': v1, '/b/y': v2 })</code> is a multi-path atomic write — all paths land or none do</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("writes every listed path atomically" + "rejects the entire update if rules deny any one path"); matches the matrix #23 prod contract</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M16</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Overlapping multi-path updates (one path is a descendant of another) reject before any path is written</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("rejects overlapping paths")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M17</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>push(ref)</code> mints a 20-char auto-id key starting with <code>-</code>, lexicographically sortable</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("mints 20-char keys starting with \"-\"" + "sequential push keys are lex-sortable"); matches oracle observation <code>scripts/oracle/observations/rtdb-push-autoid-format.json</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M18</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>push(ref, value)</code> writes <code>value</code> at the new child path</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("push(ref, value) writes the value at the new child path")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M19</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>pushKey()</code> mints a fresh push-shaped key without writing — used by callers building multi-path updates that need the key first</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("pushKey() mints a fresh key without writing")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M20</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>serverTimestamp()</code> returns the <code>{ ".sv": "timestamp" }</code> sentinel marker the wire encoder recognises</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("serverTimestamp() returns the documented shape"); matches the prod wire contract</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M21</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>serverTimestamp()</code> resolves to a number (epoch ms) on read-back</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("resolves to a number on read-back"); matches oracle observation <code>scripts/oracle/observations/rtdb-servertimestamp-resolves.json</code> (prod observation blocked on rules; sandbox locks the contract directly)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M22</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>serverTimestamp()</code> sentinels resolve when nested inside multi-path update payloads</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("resolves sentinels nested deep inside an update payload")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M23</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Rules-denied write throws a plain <code>Error</code> (NOT a <code>FirebaseError</code>) with <code>.code === 'PERMISSION_DENIED'</code> (uppercase snake-case) and <code>.message === 'PERMISSION_DENIED: Permission denied'</code></div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("rules-denied set throws a plain Error with PERMISSION_DENIED code"); matches oracle observation <code>scripts/oracle/observations/rtdb-rules-denied-error-code.json</code> (against blockingfun, fb-js-sdk 12.13.0)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M24</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Rules-denied read throws the same plain-<code>Error</code> <code>PERMISSION_DENIED</code> shape as a denied write</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("rules-denied get throws the same plain Error shape"); matches oracle observation <code>scripts/oracle/observations/rtdb-rules-denied-error-code.json</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M25</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Rules-denied remove throws the same plain-<code>Error</code> <code>PERMISSION_DENIED</code> shape</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-target.test.ts</code> ("rules-denied remove throws the same plain Error shape")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M26</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onValue(ref, cb)</code> fires immediately on subscribe with the current value at the path</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("fires on subscribe with the current value")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M27</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onValue</code> fires again after every write that CHANGES the value at the watched path; a write that leaves the watched subtree byte-identical (a no-change re-write, or an ancestor/descendant write that doesn't alter this path) is suppressed (DB-B8)</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("fires after every write that touches the watched path") + <code>unit:modular/no-change-suppression.test.ts</code> ("re-writing the same value does NOT re-fire" + "ancestor write leaving the subtree unchanged does NOT fire")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M28</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onValue</code> fires after a descendant write (the listener sees subtree changes)</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("fires on a descendant write")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M29</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onValue</code> initial-fire for an absent path delivers <code>val=null, exists=false</code> (matches matrix expectation locked by oracle for sentinel/listener shape)</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("absent path: initial fire delivers val=null, exists=false")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M30</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">The <code>onValue</code> return value is an unsubscribe function; calling it stops further fires</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("fires after every write that touches the watched path" — checks unsubscribed listener doesn't fire on subsequent write)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M31</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onChildAdded</code> / <code>onChildChanged</code> / <code>onChildRemoved</code> / <code>onChildMoved</code> — plain-ref subscription surface</div>
<div class="compat-probe">Tier 2: sandbox aligned with oracle observations under <code>scripts/oracle/observations/rtdb-modular-onchild*.json</code>. See M41–M48 for the per-event behavioral claims.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M41</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onChildAdded</code> replays each existing direct child of the parent ref on subscribe (one fire per existing key)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("replays existing direct children on subscribe — one fire per key"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-onchildadded-initial-replay.json</code> (seeded <code>{k1,k2,k3}</code>, observed <code>firedKeys: ['k1','k2','k3']</code>).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M42</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">After subscribe, <code>onChildAdded</code> fires exactly once per new direct child write; snapshot carries <code>{key, val}</code> of the new child</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("fires exactly once per NEW direct child after subscribe"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-onchildadded-post-subscribe.json</code> (<code>postSubscribeFires: 1</code>, <code>lastFire: {key:'k3', val:{v:3}}</code>).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M43</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onChildChanged</code> has NO initial replay; fires once when an existing direct child's value transitions; snapshot carries the NEW value</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("does NOT fire on subscribe (no initial replay)" + "fires once when an existing child transitions to a new value; snapshot carries NEW val"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-onchildchanged-fires-on-update.json</code> (<code>firedOnInitial: 0, firedOnUpdate: 1, lastFire: {key:'k1', val:{v:2}}</code>).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M44</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onChildChanged</code> does NOT fire for added or removed children — those go to the other event listeners</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("does NOT fire when a child is added" + "does NOT fire when a child is removed").</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M45</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onChildRemoved</code> has NO initial replay; fires once when a direct child is deleted (via <code>remove(child)</code> or <code>set(child, null)</code>); snapshot carries the PRIOR (now-removed) value</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("fires once when a child is deleted via remove(); snapshot carries PRIOR val" + "fires once when a child is deleted via set(child, null); snapshot carries PRIOR val"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-onchildremoved-fires-on-delete.json</code> (<code>firedOnInitial: 0, firedOnDelete: 1, removedSnapCarriesPriorValue: true</code>).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M46</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onChildMoved</code> on a plain ref (no <code>query(_, orderBy*)</code>) NEVER fires — per RTDB docs, child_moved emits only under ordered queries</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("does NOT fire on a plain ref (no ordering)"); matches the upstream contract observed under ordered-query in <code>scripts/oracle/observations/rtdb-modular-onchildmoved-with-orderby.json</code> (where ordered-query did fire — Tier 3 will wire that path; Tier 2 locks the plain-ref no-fire case).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M47</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>off(ref)</code> (no event type) removes ALL listeners at that ref — value + every child event variety</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("off(ref) removes ALL listeners at the ref" + "off(ref) also removes value listeners at the same path"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-off-stops-child-fires.json</code> (<code>postOffFires: 0</code>).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M48</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>off(ref, eventType?, callback?)</code> variants: <code>off(ref, 'value')</code> / <code>off(ref, 'child_added')</code> / <code>off(ref, eventType, cb)</code> remove the targeted subset; returned-unsubscribe from <code>onChild*</code> is equivalent to <code>off(ref, eventType, cb)</code></div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/sandbox-child-events.test.ts</code> ("off(ref, \"child_added\") removes only that event variety" + "off(ref, \"value\") removes only value listeners" + "off(ref, eventType, cb) removes only the matching callback" + "returned-unsubscribe from onChildAdded is functionally equivalent to off()").</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M32</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>connectDatabaseEmulator(db, host, port)</code> is a no-op on sandbox targets (the sandbox IS a local emulator)</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("is a no-op on sandbox handles")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M33</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>sandbox.setRules(db, rulesJson)</code> deploys rules to the in-process simulator; <code>setRules(db, null)</code> clears rules (default-allow)</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("sandbox.setRules(db, null) clears rules")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M34</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>sandbox.setData(db, { '/path': value })</code> bulk-loads data, bypassing rules</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("sandbox.setData seeds the tree (rule-bypass)")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M35</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>sandbox.snapshotState(db)</code> dumps the full tree as a plain JSON object</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("sandbox.snapshotState dumps the full tree")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M36</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>query(ref, ...constraints)</code> + ordering/range constraints</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> covers <code>query(ref, orderByChild/Key/Value, startAt/After, endAt/Before, equalTo, limitToFirst/Last)</code> against the executor in <code>packages/pyric/src/database/sandbox/query.ts</code>; oracle observations under <code>scripts/oracle/observations/rtdb-modular-{orderbychild-window,orderbykey-window,orderbyvalue-numeric,equalTo-filter,limittofirst-vs-limittolast,startafter-endbefore-exclusive,onvalue-with-query}.json</code> lock each constraint's behavior. See M49–M64 below for the per-claim breakdown.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M37</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>runTransaction(ref, fn, options?)</code> resolves to <code>{ committed: boolean, snapshot: DataSnapshot }</code> for the happy path — the update fn return value is written, committed is <code>true</code>, and <code>snapshot.val()</code> reflects the committed value</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/transaction.test.ts</code> ("resolves to { committed: boolean, snapshot } with the committed value"); matches oracle observations <code>scripts/oracle/observations/rtdb-modular-runtransaction-success.json</code> + <code>rtdb-modular-runtransaction-returns-committed-snapshot.json</code> (against blockingfun, fb-js-sdk 12.13.0)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M37a</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returning <code>undefined</code> from the update fn ABORTS the transaction — resolves <code>{ committed: false, snapshot }</code>; no write performed, no listener fan-out</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/transaction.test.ts</code> ("returning undefined aborts — committed: false, no write" + "aborted transaction does NOT fan out to listeners"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-runtransaction-abort-undefined.json</code> — known divergence: prod's <code>result.snapshot.val()</code> reflects the CLIENT's pre-fetch (often <code>null</code> even when the server has a value because the speculative invocation runs before the server snap arrives); the sandbox returns the actual pre-transaction value at the path (more useful in single-client harness). The agreed-upon contract callers should rely on is <code>committed === false</code> and unchanged server-side data, NOT the snapshot's <code>.val()</code> on the abort path.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M37b</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">The update fn receives the CURRENT value at the ref's path; for an absent path the argument is <code>null</code> (NOT <code>undefined</code>)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/transaction.test.ts</code> ("update fn receives null for an absent path" + "update fn receives the existing value for a seeded path"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-runtransaction-current-value-arg.json</code> (prod observation showed <code>missingArgs[0].isNull === true</code>) — note divergence: prod ALSO speculatively calls the fn with <code>null</code> for a seeded path before the server-snap arrives, the sandbox skips that speculative call (single invocation with the real current value)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M37c</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">The update fn arg is a defensive deep clone — mutating it does NOT corrupt the stored tree (matters for code that does <code>current.count++; return undefined</code> and expects abort to preserve state)</div>
<div class="compat-probe"><code>unit:modular/transaction.test.ts</code> ("mutating the update-fn arg does NOT corrupt the stored tree") — no separate oracle row (defensive contract; prod behavior is identical because the SDK clones on the wire boundary)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M37d</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>options.applyLocally</code> controls whether the in-flight optimistic value fans out to <code>onValue</code> listeners — default <code>true</code> (apply locally before commit); <code>false</code> suppresses intermediate fires so listeners see only the committed value</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/transaction.test.ts</code> ("applyLocally: true (default) — listener sees initial + committed value" + "applyLocally: false — listener sees only the committed value"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-runtransaction-options-applylocally.json</code> (single-client harness: both branches produce 2 fires (initial + commit) — divergence vs prod's documented multi-client suppression would surface under contention, which the sandbox doesn't model)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M37e</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Rules-denied transaction rejects with a plain <code>Error</code> whose <code>message === 'permission_denied'</code> (lowercase) and NO <code>.code</code> field — DIFFERENT from <code>set</code>/<code>get</code>'s <code>'PERMISSION_DENIED: Permission denied'</code> shape with uppercase <code>.code</code>. <strong>Note: the divergence between the two shapes is real at the SDK boundary, but the <code>DataHandler</code> layer normalizes both to <code>error.code === 'PERMISSION_DENIED'</code> (row #14) so consumer code only needs to branch on one value.</strong></div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/transaction.test.ts</code> ("rejects with a plain Error whose message is \"permission_denied\""); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-runtransaction-on-rules-denied-path.json</code> (against blockingfun: <code>message: 'permission_denied', code: null, constructorName: 'Error'</code>). Handler-level unification locked by <code>unit:data/handler.test.ts</code> ("transaction-shaped rules-denied (lowercase message, no .code) surfaces as PERMISSION_DENIED").</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M37f</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Rules-denied transaction does NOT write — pre-transaction value at the path is preserved through the rejection</div>
<div class="compat-probe"><code>unit:modular/transaction.test.ts</code> ("does not write to the path when rules deny") — locked alongside the M37e shape claim</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M37g</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Committed transaction fans out to <code>onValue</code> listeners on the watched path with the new value (default applyLocally behavior)</div>
<div class="compat-probe"><code>unit:modular/transaction.test.ts</code> ("committed write fans out to onValue listeners")</div>
</div>
</div>
<div class="compat-row" data-status="unsupported">
<span class="compat-num">M37h</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior">Concurrent contention / retry-on-conflict — single-client sandbox doesn't model real concurrency; the documented "up to 25 retries" contract is degenerate (the fn is invoked once)</div>
<div class="compat-probe">matrix #161 documents the same gap on the spec side; oracle observation hard to obtain from a single client (oracle row stays <code>?</code>)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M38</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Identity-aware sandbox-live op routing — sign-in/sign-out via <code>pyric/auth</code> is observed by the next RTDB op without re-binding</div>
<div class="compat-probe"><code>unit:modular/sandbox-target.test.ts</code> ("reads sandbox.currentUser at op time, not at getDatabase time")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M39</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Backend identity is per-<code>Sandbox</code> — two <code>getDatabase(sandbox)</code> calls on the same sandbox share data, two on different sandboxes don't</div>
<div class="compat-probe">implicit via the WeakMap binding; tested transitively by <code>sandbox.setData</code> + <code>get</code> round-trips in the same test suite</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M40</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Sandbox refs carry a stable <code>key</code> (last path segment) and <code>toString()</code> returning <code>sandbox://rtdb/&lt;path&gt;</code></div>
<div class="compat-probe">covered by the <code>ref</code> / <code>child</code> / <code>parent</code> tests</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M49</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>query(ref, orderByChild(p), startAt(v), endAt(w))</code> window is BOTH-INCLUSIVE — children whose ordered field === <code>v</code> or === <code>w</code> are included</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("returns children whose ordered child is within [startAt, endAt] inclusive"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-orderbychild-window.json</code> (positions <code>[2,3,4]</code>, both ends inclusive).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M50</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>orderByKey()</code> orders children by RTDB <code>nameCompare</code> — integer-looking keys sort numerically FIRST (so <code>['1','2','10']</code>, not the lexicographic <code>['1','10','2']</code>), then non-integer keys lexicographically; <code>startAt</code>/<code>endAt</code> cursors + the optional <code>key</code> tie-breaker use the same order (DB-B4)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("orderByKey + startAt(s) + endAt(e) yields keys in [s,e] inclusive") + <code>unit:modular/name-compare.test.ts</code> ("orderByKey sorts integer keys numerically, before non-integer keys" + "numeric-key cursor uses nameCompare bounds"); matches oracle <code>rtdb-modular-orderbykey-window.json</code> and upstream <code>core/util/util.ts:253-276</code>.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M51</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>orderByValue()</code> orders primitive children by their value; <code>limitToFirst(N)</code> returns the N smallest, ascending</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("returns the limitToFirst(N) smallest values, ascending"). Oracle observation <code>scripts/oracle/observations/rtdb-modular-orderbyvalue-numeric.json</code> shows prod threw <code>Index not defined</code> against blockingfun — the sandbox does NOT enforce <code>.indexOn</code> (rules-engine integration for query indexes is deferred); the semantic claim (ordering by value) is locked here.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M52</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>orderByChild(p) + equalTo(v)</code> returns ALL children whose field at <code>p</code> === <code>v</code> — no uniqueness enforced</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("returns ALL children whose ordered field === the supplied value"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-equalTo-filter.json</code> (both 'b'-grouped children returned).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M53</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>equalTo</code> with no matches returns an empty snapshot (<code>exists() === false</code>, <code>numChildren() === 0</code>)</div>
<div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("returns an empty snapshot when nothing matches")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M54</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>limitToFirst(N)</code> keeps the lowest-ranked N children (post-ordering, pre-filter)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("limitToFirst takes the lowest-ranked window"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-limittofirst-vs-limittolast.json</code> (firstPositions <code>[1,2]</code>).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M55</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>limitToLast(N)</code> keeps the highest-ranked N children</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("limitToLast takes the highest-ranked window"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-limittofirst-vs-limittolast.json</code> (lastPositions <code>[4,5]</code>).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M56</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>limitToFirst(N)</code> larger than the result returns the full window (no padding, no throw)</div>
<div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("limitToFirst(N) larger than the result returns the full window")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M57</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>startAfter(v)</code> and <code>endBefore(v)</code> are EXCLUSIVE — the boundary value is dropped from the result</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("startAfter + endBefore drop the boundary values"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-startafter-endbefore-exclusive.json</code> (positions <code>[3,4]</code>, cursors 2 + 5 dropped).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M58</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onValue(query, cb)</code> only fires when the windowed result changes — writes OUTSIDE the window don't re-fire the listener; writes that displace a member DO</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/queries.test.ts</code> ("fires only when the windowed result changes"); matches oracle observation <code>scripts/oracle/observations/rtdb-modular-onvalue-with-query.json</code> (3 fires: initial + INSIDE-window write + displacing write; OUTSIDE-window write skipped).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M59</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onValue(query)</code> initial fire delivers an empty window (<code>numChildren() === 0</code>) when the path is absent</div>
<div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("initial fire on an empty path delivers an empty window")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M60</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>query(query(ref, c1), c2)</code> composes constraints — chaining folds both into one spec</div>
<div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("query(query(ref, c1), c2) composes constraints")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M61</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Snapshot from a query exposes children via <code>snap.forEach</code> in the executor-computed order — NOT necessarily the order <code>Object.entries(val)</code> would yield</div>
<div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("forEach visits children in ascending order of the child key")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M62</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>startAt(value, key)</code> uses <code>key</code> as the tie-breaker when multiple children share the same ordered value — children before <code>key</code> are dropped, the row at <code>key</code> is included (inclusive cursor)</div>
<div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("startAt with key tie-breaker drops earlier same-value children")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M63</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>orderByChild('p')</code> on children missing the field treats their value as <code>null</code> (sorts FIRST per RTDB's type ordering)</div>
<div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("orderByChild on a missing child path treats those children as null")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M64</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>query</code> on a path holding a primitive (or absent path) returns an empty snapshot — no rows to iterate</div>
<div class="compat-probe"><code>unit:modular/queries.test.ts</code> ("query on a path with primitive value returns no rows")</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M65</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Write-boundary normalization (<code>nodeFromJSON</code>-equivalent): a value written as an array is stored as an integer-keyed object — <code>child(ref, '1')</code> returns the element, <code>forEach</code> iterates <code>0,1,2…</code> (DB-B2)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/normalization.test.ts</code> ("array write is addressable by integer-string child key" + "forEach over an array iterates its elements"); upstream <code>core/snap/nodeFromJSON.ts:118-128</code>, <code>core/snap/ChildrenNode.ts:194-230</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M66</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Read-side array coercion: a dense integer-keyed object renders back as an array on <code>snap.val()</code> (<code>allIntegerKeys &amp;&amp; maxKey &lt; 2 * numKeys</code>) (DB-B2)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/normalization.test.ts</code> ("a dense integer-keyed object reads back as an array"); upstream <code>core/snap/ChildrenNode.ts:196-230</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M67</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>null</code> children and empty objects are pruned at the write boundary — <code>set(ref, {})</code> is equivalent to <code>remove(ref)</code>; nested <code>null</code> collapses empty ancestors ("empty nodes don't exist") (DB-B3)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/normalization.test.ts</code> ("set(ref, {}) is equivalent to remove" + "null children are pruned"); upstream <code>core/snap/nodeFromJSON.ts:78-88,122-126</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M68</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Write validation: an <code>undefined</code> payload, a non-finite number (<code>NaN</code>/<code>±Infinity</code>), or a key containing a forbidden char (<code>.</code>, <code>#</code>, <code>$</code>, <code>/</code>, <code>[</code>, <code>]</code>, control chars) is rejected with a plain <code>Error</code> (DB-B1)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/normalization.test.ts</code> ("rejects an undefined payload" + "rejects an invalid key" + "rejects a non-finite number"); upstream <code>core/util/validation.ts:45,58,112-199</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M69</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Conflicting query constraints throw synchronously at <code>query(...)</code> construction (NOT silent last-win): multiple <code>orderBy*</code>, a second <code>limitToFirst</code>/<code>limitToLast</code>, a second start (<code>startAt</code>/<code>startAfter</code>/<code>equalTo</code>) or end (<code>endAt</code>/<code>endBefore</code>/<code>equalTo</code>) (DB-B5)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/constraint-conflicts.test.ts</code> (5 cases); upstream <code>api/Reference_impl.ts:160-165,1824-1841,1888-1905,1945-1951,2193-2206</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M70</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>push(ref, value?)</code> returns a <code>ThenableReference</code> (a <code>DatabaseReference</code> with <code>.then</code>/<code>.catch</code>). The key + ref are minted CLIENT-SIDE and available synchronously even when the optional value write is rules-denied; the write is deferred onto the promise, so a denial REJECTS the awaited push rather than throwing synchronously and discarding the key (DB-B7)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/push-thenable.test.ts</code> (4 cases); matches oracle <code>scripts/oracle/observations/rtdb-push-autoid-format.json</code> ("available immediately even when the subsequent server write is denied by rules") + upstream <code>api/Reference_impl.ts:599-630</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M71</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>DataSnapshot</code> shape: <code>size</code> (getter), <code>priority</code> (always <code>null</code> — priority deny-listed), <code>exportVal()</code>, <code>key</code>, <code>ref</code>, <code>val()</code>, <code>exists()</code>, <code>child()</code>, <code>hasChild()</code>, <code>hasChildren()</code>, <code>forEach()</code>, <code>toJSON()</code>. It does NOT ship the legacy namespaced <code>numChildren()</code> method (DB-B10)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/snapshot-shape.test.ts</code> ("exposes size/priority/exportVal; NOT numChildren()"); matches oracle <code>scripts/oracle/observations/rtdb-modular-get-snapshot-shape.json</code> (<code>hasSize: true, hasNumChildren: false</code>) + upstream <code>api/Reference_impl.ts:288-447</code>. <strong>Flipped masking tests</strong>: <code>modular/queries.test.ts</code> + <code>modular/sandbox-target.test.ts</code> asserted <code>snap.numChildren()</code> — updated to <code>snap.size</code>.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M72</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Object-valued children are ORDER-EQUAL — the sort/range tie is broken by key (<code>nameCompare</code>), NOT by an invented <code>JSON.stringify</code> ordering; a query re-write that only reorders object keys is "no change" and doesn't re-fire (DB-B11)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/object-order-equality.test.ts</code>; upstream <code>core/snap/ChildrenNode.ts:386-400</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M73</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">A primitive at the ROOT is legal (<code>set(ref(db), 'hello')</code>); a subsequent child write replaces the primitive root ("writes win") (DB-B13)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/root-primitive.test.ts</code> (2 cases)</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">M74</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onValue(ref, cb, { onlyOnce: true })</code> fires once then auto-unsubscribes (DB-B12)</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/onvalue-onlyonce.test.ts</code>; upstream <code>api/Reference_impl.ts:975-980</code></div>
</div>
</div>
<div class="compat-row" data-status="diverged">
<span class="compat-num">M75</span>
<span class="compat-dot" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span>
<div class="compat-main">
<div class="compat-behavior"><strong>Divergence (DB-B12, honest doc):</strong> the onChild<em> callbacks do NOT receive the <code>previousChildName</code> second argument; <code>onValue</code>/<code>onChild</em></code> do NOT accept a <code>cancelCallback</code>; <code>onChildAdded</code>/<code>Changed</code>/<code>Removed</code>/<code>Moved</code> accept only plain refs (not <code>Query</code>); <code>child_moved</code> never fires (ordered-query move detection unmodeled). These listener-surface holes are out of scope for the current phase — consumers needing them use <code>firebase/database</code> directly.</div>
<div class="compat-probe">divergence documented; partial coverage: <code>{ onlyOnce }</code> IS implemented (M74).</div>
</div>
</div>
<div class="compat-row" data-status="diverged">
<span class="compat-num">M76</span>
<span class="compat-dot" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span>
<div class="compat-main">
<div class="compat-behavior"><strong>Divergence (DB-B9, honest doc):</strong> <code>.validate</code> rules are NOT enforced on modular sandbox writes (<code>set</code>/<code>update</code>/<code>runTransaction</code>). The modular write path routes through the same <code>RulesEvaluator</code> → <code>SimulateHandler</code> as the simulator, which short-circuits on the first ancestor <code>.write</code> that grants access without also requiring every ancestor <code>.validate</code> to pass (same divergence as row #71). A write the live RTDB rejects via a deeper <code>.validate</code> still succeeds in the sandbox.</div>
<div class="compat-probe">divergence documented (shared root with row #71); fix path noted under "Simulator-vs-prod divergences".</div>
</div>
</div>
</div>

### Deferred behaviors (Tier 3+ — out of scope for the current phase unless time permits)

- **Child listeners (`onChildAdded` / `onChildChanged` / `onChildRemoved` / `onChildMoved`) — DONE in Tier 2.**
  Sandbox implementation lives in `packages/pyric/src/database/sandbox/backend.ts`
  (per-child diff against the parent's prior children snapshot, captured
  before every write). Plain-ref subscriptions are fully aligned with
  the oracle observations under `scripts/oracle/observations/rtdb-modular-onchild*.json`.
  `onChildMoved` only fires under ordered queries (per the upstream
  contract); the plain-ref no-fire case is locked. Ordered-query
  `onChildMoved` lands with Tier 3's `query` / `orderBy*` surface.
- **Queries + constraints (`query`, `orderByChild`, `equalTo`, `limit*`).**
  Tier 3. Requires sort/filter pipeline over the in-memory tree at
  read + listener-fire time. Defer until a consumer needs it.
- **Transactions (`runTransaction`).** Tier 4 — **DONE.** RTDB
  transactions retry-on-conflict against the server's local snapshot,
  with abort-by-returning-`undefined`. Sandbox match is straightforward
  (no concurrency to conflict on) and the semantics are locked by
  oracle observations
  `rtdb-modular-runtransaction-{success,abort-undefined,current-value-arg,returns-committed-snapshot,options-applylocally,on-rules-denied-path}.json`.
  See M37 / M37a–M37h above for the full claim breakdown. The
  retry-on-conflict path (#161) stays unmodeled — single-client
  harness, nothing to conflict with.
- **Playground integration (`firebase/database` virtual-imports
  re-export).** Tier 5 — **shipped**. App code that imports
  `firebase/database` inside the playground preview iframe is
  aliased to `@pyric/rtdb`'s modular surface. Three-file scope
  expansion:
  - `packages/playground/src/lib/preview/virtual-imports-plugin.ts`
    adds a `firebase/database` entry to the `ALIASES` map listing the
    exports the synthetic re-export module surfaces.
  - `packages/playground/src/lib/preview/preview-scope.ts` adds
    a `'firebase/database'` slot to `PreviewModuleId` and the
    `PreviewScope` interface, constrained via `Pick<typeof PyricRtdbModular, ...>`.
  - `packages/playground/src/components/AppPreview.tsx` installs
    the slot at runtime: imports the modular surface from `@pyric/rtdb`,
    wraps `getDatabase` so a bare-arg call defaults to the runner's
    sandbox (mirrors the `getAuth` / `getFirestore` wrap), and supplies
    the rest of the read/write family unchanged.

  The `sandbox.*` test-driver namespace (`setRules`, `setData`,
  `snapshotState`) is deliberately omitted from the alias — it's
  runner-side only, not app code. The deploy bundler at
  `packages/playground/src/lib/deploy/bundleApp.ts` already lists
  `firebase/database` as `external` and resolves it to esm.sh's
  upstream module; the metafile gate (`assertNoPyricLeak`) still trips
  on any direct `@pyric/rtdb` import in deployed app code, so the
  preview-only alias is not a deploy-time leak vector.

## Agent-tool surface — deny-list (intentionally NOT shimmed)

The agent-tool surface deliberately excludes the parts of
`firebase/database` that don't translate to a tool-call shape or
that would require background state the host can't supply. The
**modular SDK surface** documented below DOES cover most of these —
the deny-list here is scoped to the agent-tool surface only.

| Name | Reason |
|---|---|
| `onValue` / `onChildAdded` / `onChildChanged` / `onChildRemoved` / `onChildMoved` / `onDisconnect` | Long-lived listeners don't fit the request-response tool-call shape. Live data streaming is out of scope for v0; consumers needing real-time updates use `firebase/database` directly with a host-supplied `Database` handle. |
| `query` + ordering constraints (`orderByChild`, `orderByKey`, `orderByValue`, `equalTo`, `startAt`, `endAt`, `limitToFirst`, `limitToLast`) | The tool surface today only does whole-path reads; filtered reads would require either constraint-shaped tool parameters or query objects threaded through the tool boundary. Worth revisiting if agent workflows need filtering. |
| `runTransaction` | Transactional client semantics (read-modify-write with retry) don't model cleanly as a single tool call; deferred. |
| `serverTimestamp()` / `increment(n)` sentinels in the data tools | Not yet wired through; would require sentinel-aware serialization on the REST + admin paths. |
| `goOnline` / `goOffline` / `Database.useEmulator` | No persistent client state for the data tools (admin REST + on-demand user clients); not modeled. |
| `connectDatabaseEmulator` | Out of scope; the package targets real RTDB. |
| `Database.app` / `getDatabase()` | Lifecycle is owned by the host (`host.getClientForUser`); package consumers don't construct `Database` directly. |

---

## Modular SDK surface

The `firebase/database` modular shim — the surface a consumer
imports as `getDatabase`, `ref`, `set`, `onValue`, etc. The sandbox
implementation lives under `packages/pyric/src/database/` (dispatch in
`modular.ts`, backend in `sandbox/`); see the "Modular SDK surface
(Phase 3)" section above for the per-row detail. The oracle probes
lock prod behavior so the sandbox is correct by construction.

Targets (same flavors as `pyric/firestore`):

- **sandbox** — frozen-ctx target built via `getDatabase(ctx: SandboxContext)`. Identity baked in at handle-construction.
- **sandbox-live** — live-identity target built via `getDatabase(sandbox: Sandbox)`. Every op re-reads `sandbox.currentUser`. The playground preview always uses this flavor.
- **prod** — `firebase/database` target built via `getDatabase(app: FirebaseApp)`. Identity comes from `firebase/auth`'s `currentUser`.

Sandbox rows lift from **—** to **✓** as the implementation lands;
prod rows sit at **?** unless an oracle observation under
`scripts/oracle/observations/` locks them. The matrix is the spec;
the oracle locks it.

### `getDatabase(target)` — initializer

<div class="compat-list">
<div class="compat-row" data-status="unsupported">
<span class="compat-num">94</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior"><code>getDatabase(ctx)</code> returns a tagged sandbox-target handle (frozen identity)</div>
<div class="compat-probe">Phase 3</div>
</div>
</div>
<div class="compat-row" data-status="unsupported">
<span class="compat-num">95</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior"><code>getDatabase(sandbox)</code> returns a tagged sandbox-live handle (per-op identity)</div>
<div class="compat-probe">Phase 3</div>
</div>
</div>
<div class="compat-row" data-status="unverified">
<span class="compat-num">96</span>
<span class="compat-dot" role="img" aria-label="Unverified" title="Unverified"></span>
<div class="compat-main">
<div class="compat-behavior"><code>getDatabase(app)</code> returns a tagged prod target</div>
<div class="compat-probe">upstream <code>firebase/database</code> contract; not currently probed in isolation</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">97</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>getDatabase()</code> (no argument) — wrapped in the playground preview to default to the sandbox; raw call delegates to prod</div>
<div class="compat-probe">Phase 3 Tier 5: virtualized in the playground preview scope. Wired at <code>packages/playground/src/components/AppPreview.tsx</code> (slot install with bare-call wrap), <code>packages/playground/src/lib/preview/virtual-imports-plugin.ts</code> (alias map), and <code>packages/playground/src/lib/preview/preview-scope.ts</code> (type-level slot). Mirrors the <code>getAuth</code> / <code>getFirestore</code> wrap pattern. Demo fixture: <code>packages/playground/scripts/fixtures/rtdb-set-get-roundtrip.tsx</code> (bare <code>getDatabase()</code> + <code>set</code>/<code>get</code>/<code>remove</code> round-trip with anon sign-in) — passes end-to-end through the <code>bun run debug:fixtures</code> Playwright suite (revived in the playground rtdb-fixture follow-up; the suite previously couldn't load <code>@pyric/rtdb</code> in the client because its top-level re-export of <code>DataHandler</code> pulled <code>firebase-admin</code>, now stubbed via <code>packages/playground/src/lib/node-shims/firebase-admin.ts</code>).</div>
<div class="compat-note">(wrap, fixture passing)</div>
</div>
</div>
<div class="compat-row" data-status="unsupported">
<span class="compat-num">98</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior">Two <code>getDatabase(sandbox)</code> calls share state (same underlying <code>LocalEnvironment</code>)</div>
<div class="compat-probe">Phase 3</div>
</div>
</div>
<div class="compat-row" data-status="unsupported">
<span class="compat-num">99</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior">Handle dispatch by <code>TARGET_SYMBOL</code> brand — refs route to their owning target via a <code>refToTarget</code> WeakMap (mirror of firestore's pattern)</div>
<div class="compat-probe">Phase 3</div>
</div>
</div>
</div>

### `ref(db, path)` / `child` / `parent` / `root`

<div class="compat-list">
<div class="compat-row" data-status="unverified">
<span class="compat-num">100</span>
<span class="compat-dot" role="img" aria-label="Unverified" title="Unverified"></span>
<div class="compat-main">
<div class="compat-behavior"><code>ref(db, path)</code> returns a tagged <code>DatabaseReference</code> carrying <code>key</code>, <code>parent</code>, <code>root</code>, <code>toString()</code></div>
<div class="compat-probe">upstream <code>firebase/database</code> contract</div>
</div>
</div>
<div class="compat-row" data-status="unverified">
<span class="compat-num">101</span>
<span class="compat-dot" role="img" aria-label="Unverified" title="Unverified"></span>
<div class="compat-main">
<div class="compat-behavior"><code>ref(db)</code> with no path returns the root ref (<code>key === null</code>, <code>parent === null</code>)</div>
<div class="compat-probe">upstream contract</div>
</div>
</div>
<div class="compat-row" data-status="unverified">
<span class="compat-num">102</span>
<span class="compat-dot" role="img" aria-label="Unverified" title="Unverified"></span>
<div class="compat-main">
<div class="compat-behavior"><code>child(ref, 'a/b')</code> joins a relative path, including embedded slashes</div>
<div class="compat-probe">upstream contract</div>
</div>
</div>
<div class="compat-row" data-status="unverified">
<span class="compat-num">103</span>
<span class="compat-dot" role="img" aria-label="Unverified" title="Unverified"></span>
<div class="compat-main">
<div class="compat-behavior"><code>ref.parent</code> is <code>null</code> at root, otherwise the parent ref</div>
<div class="compat-probe">upstream contract</div>
</div>
</div>
<div class="compat-row" data-status="unverified">
<span class="compat-num">104</span>
<span class="compat-dot" role="img" aria-label="Unverified" title="Unverified"></span>
<div class="compat-main">
<div class="compat-behavior"><code>ref.key</code> is the final path segment, <code>null</code> for root</div>
<div class="compat-probe">upstream contract</div>
</div>
</div>
<div class="compat-row" data-status="unsupported">
<span class="compat-num">105</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior">Unknown ref (not produced by this package) → <code>TypeError</code> in shim ops</div>
<div class="compat-probe">Phase 3</div>
</div>
</div>
</div>

### `get(ref)` — single read

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">106</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returns a <code>DataSnapshot</code> carrying <code>.val()</code>, <code>.exists()</code>, <code>.key</code>, <code>.ref</code>, <code>.size</code> (getter, returns child count), <code>.hasChildren()</code>, <code>.hasChild(path)</code>, <code>.forEach(cb)</code>. The legacy namespaced-SDK method <code>.numChildren()</code> is <strong>NOT</strong> on the modular DataSnapshot — use <code>.size</code> instead. Observed: <code>hasNumChildren: false</code>, <code>size: 3</code> for a <code>{a,b,c}</code> object, <code>forEachKeys: ['a','b','c']</code> against blockingfun, fb-js-sdk 12.13.0.</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-get-snapshot-shape.json</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">107</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>snap.val()</code> returns <code>null</code> for a missing path (NOT a thrown error — RTDB diverges from Firestore here; <code>getDoc</code> returns <code>exists()===false</code> but <code>get</code> on RTDB just returns a <code>null</code>-val snapshot)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-get-missing-path.json</code> — observed <code>threw: false, val: null, exists: false</code> on a never-written path against blockingfun.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">108</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>snap.exists()</code> is <code>false</code> when <code>val() === null</code>, <code>true</code> otherwise</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-get-missing-path.json</code> — observed <code>exists: false</code> for <code>val: null</code>.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">109</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Round-trip: <code>set(ref, payload)</code> then <code>get(ref)</code> returns the payload (lock the basic write→read invariant)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-set-then-get-roundtrip.json</code> — the payload round-trips structurally on both sides (this row's claim holds). NOTE — adjacent divergence pinned in <code>oracle-conformance.test.ts</code>: prod returns object children in LEXICOGRAPHIC key order (the capture's <code>roundTripEqual: false</code> — a <code>JSON.stringify</code> round-trip against a non-sorted payload fails), while the sandbox preserves insertion order (stringify round-trip succeeds). Key-order-sensitive consumers behave differently.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">110</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Rules-denied read throws a plain <code>Error</code> (NOT a <code>FirebaseError</code>) with <code>code: 'PERMISSION_DENIED'</code> (uppercase snake-case) — matches the agent-tool rows #15/#20</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-rules-denied-error-code.json</code></div>
</div>
</div>
</div>

### `set(ref, value)` — full write

<div class="compat-list">
<div class="compat-row" data-status="unverified">
<span class="compat-num">111</span>
<span class="compat-dot" role="img" aria-label="Unverified" title="Unverified"></span>
<div class="compat-main">
<div class="compat-behavior">Replaces the value at the path entirely; resolves to <code>undefined</code> (unlike <code>setDoc</code> which resolves to <code>void</code>, RTDB's <code>set</code> is documented as <code>Promise&lt;void&gt;</code>)</div>
<div class="compat-probe">upstream contract</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">112</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>set(ref, null)</code> removes the path entirely — equivalent to <code>remove(ref)</code>, subsequent <code>get</code> returns <code>null</code>-val snapshot</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-set-null-equals-remove.json</code> — observed <code>beforeExists: true → afterExists: false, afterVal: null</code> after <code>set(ref, null)</code>.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">113</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Nested objects overwrite — <code>set(ref, {a: 1})</code> after <code>set(ref, {a: 1, b: 2})</code> leaves <code>{a: 1}</code> only, NOT a merge (RTDB <code>set</code> is replacement, not merge)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-set-replaces-not-merges.json</code> — observed <code>final: {a: 1}</code> with <code>b</code> absent after the second set.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">114</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Primitive round-trip — numbers, strings, booleans, arrays all survive a set→get cycle</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-set-then-get-roundtrip.json</code> — the payload round-trips structurally on both sides (this row's claim holds). NOTE — adjacent divergence pinned in <code>oracle-conformance.test.ts</code>: prod returns object children in LEXICOGRAPHIC key order (the capture's <code>roundTripEqual: false</code> — a <code>JSON.stringify</code> round-trip against a non-sorted payload fails), while the sandbox preserves insertion order (stringify round-trip succeeds). Key-order-sensitive consumers behave differently.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">115</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Rules-denied write throws plain <code>Error</code> with <code>code: 'PERMISSION_DENIED'</code> (same shape as #110)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-rules-denied-error-code.json</code></div>
</div>
</div>
</div>

### `update(ref, values)` — partial / multi-path update

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">116</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>update(ref, {a: 1, b: 2})</code> merges top-level keys at the ref; unspecified keys preserved (in contrast to <code>set</code>'s replacement)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-update-merges-keys.json</code> — after <code>set({a:1,b:2})</code> then <code>update({a:10})</code>, observed <code>final: {a:10, b:2}</code>.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">117</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Multi-path update — <code>update(parentRef, { 'a/x': 1, 'b/y': 2 })</code> lands BOTH writes atomically at distinct subtrees (RTDB's most distinctive feature; this is the "fan-out" pattern)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-update-multipath-atomic.json</code> — observed <code>aX: 1, bY: 2</code> both readable after a single update call.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">118</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Multi-path update is atomic: if any path is denied by rules, the entire update rejects and no path is written</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-update-multipath-rules-denial.json</code> — observed <code>threw: true, code: 'PERMISSION_DENIED'</code> AND <code>okPathWrittenDespiteDenial: false</code> (the otherwise-permitted path also rolled back).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">119</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Setting a key to <code>null</code> inside <code>update</code> removes that key — same equivalence as <code>set(ref, null)</code></div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-update-null-removes-key.json</code> — after <code>set({a:1,b:2})</code> then <code>update({a:null})</code>, observed <code>final: {b:2}</code> with <code>a</code> absent.</div>
</div>
</div>
<div class="compat-row" data-status="unverified">
<span class="compat-num">120</span>
<span class="compat-dot" role="img" aria-label="Unverified" title="Unverified"></span>
<div class="compat-main">
<div class="compat-behavior">Update path validation — overlapping paths (e.g. <code>'/a'</code> and <code>'/a/x'</code> in the same call) throws synchronously before any write</div>
<div class="compat-probe">upstream contract — needs targeted probe</div>
</div>
</div>
</div>

### `remove(ref)` — delete

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">121</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Removes the value AND all children; subsequent <code>get</code> returns <code>null</code>-val snapshot</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-remove-vs-set-null.json</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">122</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Idempotent — <code>remove</code> on a path that's already absent resolves successfully (no-throw)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-remove-idempotent.json</code> — <code>remove</code> on a never-written path observed <code>threw: false, afterExists: false</code>.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">123</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>remove(ref)</code> and <code>set(ref, null)</code> produce the same end state — locks the documented RTDB invariant</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-remove-vs-set-null.json</code></div>
</div>
</div>
</div>

### `push(ref, value?)` — auto-id append

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">124</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>push(ref).key</code> is a 20-char string starting with <code>-</code>, available <strong>synchronously</strong> (client-side mint, no server round-trip required)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-push-autoid-format.json</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">125</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Sequential <code>push</code> calls produce monotonically-sortable keys (timestamp-prefixed for chronological ordering via <code>orderByKey</code>)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-push-autoid-format.json</code></div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">126</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>push(ref, value)</code> writes the value AND returns the new child ref (both behaviors in one call); <code>push(ref)</code> mints the ref without writing</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-push-with-value.json</code> — <code>await push(parent, {hello:'world'})</code> returned a ref with a 20-char key; subsequent <code>get(r)</code> returned <code>{hello:'world'}</code>.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">127</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">The returned ref <code>r = push(parent, value)</code> is usable in follow-up ops: <code>get(r)</code>, <code>set(r, …)</code>, <code>remove(r)</code></div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-push-with-value.json</code> — observed all 4 follow-up ops succeed through the returned ref (<code>refIsUsableForFollowupOps: true</code>).</div>
</div>
</div>
</div>

### `onValue(ref, cb)` — value-level listener

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">128</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Subscribing to a path with <strong>existing data</strong> fires the listener once with the current snapshot (the "initial fire")</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-onvalue-initial-with-data.json</code> — observed exactly 1 initial fire within ~46ms of subscribe, snapshot.val() === the seeded payload.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">129</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Subscribing to a <strong>nonexistent path</strong> still fires the listener once — with a <code>null</code>-val snapshot AND <code>exists() === false</code>. Matches Firestore's <code>onSnapshot</code>-on-missing-doc semantics: prod RTDB does NOT silently skip the initial fire for empty paths.</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-onvalue-initial-no-data.json</code> — observed 1 initial fire on a never-written path with <code>firstFire.val: null, firstFire.exists: false</code> (~55ms after subscribe).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">130</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Subsequent <code>set(ref, …)</code> fires the listener with the new value</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-onvalue-fires-on-set.json</code> — observed 1 fire per <code>set()</code> (1+1+1 = 3 total: initial-null, after-first-set, after-second-set).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">131</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Unsubscribe — the returned unsubscribe function stops further fires; subsequent writes produce 0 additional fires after <code>unsub()</code></div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-onvalue-unsubscribe.json</code> — observed <code>preUnsubFires: 2, postUnsubFires: 2</code> (a write performed after <code>unsub()</code> produced 0 additional fires within a 500ms settle window).</div>
</div>
</div>
<div class="compat-row" data-status="unverified">
<span class="compat-num">132</span>
<span class="compat-dot" role="img" aria-label="Unverified" title="Unverified"></span>
<div class="compat-main">
<div class="compat-behavior">The returned value from <code>onValue(ref, cb)</code> is the unsubscribe function (NOT an object); calling it removes the listener</div>
<div class="compat-probe">upstream contract — locked indirectly by #131</div>
</div>
</div>
</div>

### `onChildAdded` / `onChildChanged` / `onChildRemoved` / `onChildMoved`

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">133</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onChildAdded</code> replays the existing children on subscribe — one fire per existing child key, in <code>orderByKey</code> order by default (unlike <code>onValue</code> which fires once with the parent snapshot)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-onchildadded-initial-replay.json</code> — seeded <code>{k1, k2, k3}</code>, observed 3 initial fires with <code>firedKeys: ['k1', 'k2', 'k3']</code> in insertion order against blockingfun.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">134</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">After subscribe, adding a child via <code>push</code> or <code>set(child, …)</code> fires <code>onChildAdded</code> exactly once for that key</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-onchildadded-post-subscribe.json</code> — seeded <code>{k1,k2}</code>, observed <code>postSubscribeFires: 1, lastFire: {key:'k3', val:{v:3}}</code> after writing the new child.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">135</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onChildChanged</code> fires when an existing child's value changes; does NOT fire for added or removed children</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-onchildchanged-fires-on-update.json</code> — observed <code>firedOnInitial: 0, firedOnUpdate: 1, lastFire: {key:'k1', val:{v:2}}</code> (the NEW value, not the prior).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">136</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onChildRemoved</code> fires when a child is deleted (via <code>remove(child)</code> or <code>set(child, null)</code>); snapshot carries the PRIOR value</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-onchildremoved-fires-on-delete.json</code> — observed <code>firedOnDelete: 1, removedSnapCarriesPriorValue: true</code> (snapshot.val() was the pre-delete value).</div>
</div>
</div>
<div class="compat-row" data-status="diverged">
<span class="compat-num">137</span>
<span class="compat-dot" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span>
<div class="compat-main">
<div class="compat-behavior"><code>onChildMoved</code> under an ordered query. Prod: fires when a child's <code>orderByChild</code>/<code>orderByValue</code> priority changes — emitted only on ordered queries. Sandbox: <strong>never fires on reorder</strong> — <code>onChildMoved</code> supports the plain-ref (no-fire) case only; the ordered-query overload is unimplemented</div>
<div class="compat-probe">divergence, oracle-locked by <code>scripts/oracle/observations/rtdb-modular-onchildmoved-with-orderby.json</code>: prod observed <code>firedOnMove: 1</code> under <code>query(ref, orderByChild('priority'))</code> after bumping a child's priority to a new sort position; the sandbox fires 0 on reorder. Partial alignment landed: all <code>onChild*</code> now ACCEPT a <code>Query</code> (previously threw a misleading <code>unrecognized reference</code> TypeError) with window-aware <code>child_added</code>/<code>child_changed</code>/<code>child_removed</code> diffs (<code>src/database/sandbox/backend.ts</code>); <code>child_moved</code> reorder semantics and <code>previousChildName</code> ordering remain held pending two new oracle captures. Both sides pinned in <code>modular/oracle-conformance.test.ts</code> and <code>modular/sandbox-child-events.test.ts</code>. Sandbox Tier 2 locks the plain-ref no-fire case (M46).</div>
</div>
</div>
</div>

### `off(ref, eventType?, callback?)` — unsubscribe variants

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">138</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>off(ref)</code> removes ALL listeners at that ref (any event type, any callback)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-off-stops-child-fires.json</code> — after <code>off(ref)</code> with no eventType, a subsequent write produced <code>postOffFires: 0</code> against an <code>onChildAdded</code> registration.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">139</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>off(ref, 'value')</code> removes only <code>value</code> listeners at that ref</div>
<div class="compat-probe">Sandbox aligned (M48); oracle: <code>scripts/oracle/observations/rtdb-off-eventtype-precision.json</code> — registered TWO <code>value</code> listeners + one <code>child_added</code> at the same ref; after <code>off(ref, 'value')</code> (no callback), <code>valueListenersStopped: true</code> (neither value cb fired on subsequent writes) AND <code>childListenerStillFiringAfterOffValue: true</code> (the child listener kept firing). <code>offValueClearsAllValueListeners: true</code> confirms the no-callback variant removes ALL value listeners at the ref.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">140</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>off(ref, 'value', cb)</code> removes only the specific callback</div>
<div class="compat-probe">Sandbox aligned (M48); adjacent to #141 — the upstream <code>off</code> with the cb argument removes only the matching callback. Same probe (<code>rtdb-onvalue-unsub-equivalence.json</code> Case 2) confirms <code>off(ref, 'value', cb)</code> stops only that callback.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">141</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">The returned unsubscribe function from <code>onValue(ref, cb)</code> is equivalent to <code>off(ref, 'value', cb)</code></div>
<div class="compat-probe">Sandbox aligned (M48); oracle: <code>scripts/oracle/observations/rtdb-onvalue-unsub-equivalence.json</code> — <code>unsubReturnType: 'function'</code>, <code>unsubReturnedFnStopsListener: true</code> (the captured return value halted fires on write), <code>offRefValueCbStopsListener: true</code> (the same effect via <code>off(ref, 'value', cb)</code>), <code>bothFormsEquivalent: true</code>.</div>
</div>
</div>
</div>

### `query(ref, ...constraints)` + ordering / bounds / limits

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">142</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>query(ref, orderByChild('field'), limitToFirst(N))</code> returns a <code>Query</code> whose <code>get()</code> resolves a snapshot containing N children ordered by <code>field</code></div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-query-orderbychild-limit.json</code> — seeded 4 children with positions <code>[3,1,4,2]</code>, observed <code>orderedKeys: [{key:'a',pos:1}, {key:'b',pos:2}]</code> (first 2 in ascending order). Requires <code>.indexOn</code> declared in rules.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">143</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>orderByKey()</code> orders by the auto-id / numeric key</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-orderbykey-window.json</code> — seeded <code>{a,b,c,d,e}</code> in shuffled insertion order, observed <code>matchedKeys: ['b','c','d']</code> for <code>orderByKey() + startAt('b') + endAt('d')</code> (in key order).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">144</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>orderByValue()</code> orders by the primitive value of each child (for collections of primitives)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-orderbyvalue-numeric.json</code> — seeded <code>{alice:30, bob:10, carol:50, dave:20, eve:40}</code>, the prod call threw <code>Index not defined, add ".indexOn": ".value"</code> (so prod enforces an index requirement on <code>orderByValue()</code>); semantic ordering claim still holds, sandbox does not enforce indexes.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">145</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>equalTo(v)</code> filters children whose ordered field === v (returns 0, 1, or multiple matches — RTDB does NOT enforce uniqueness)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-query-equalto.json</code> — seeded <code>{red, blue, blue, green}</code>, observed <code>matchedKeys: ['k2', 'k3']</code> for <code>equalTo('blue')</code> (both blue children, none of the others). Additional probe: <code>scripts/oracle/observations/rtdb-modular-equalTo-filter.json</code> (a..b..c groups) confirms <code>equalTo('b')</code> returns the two <code>b</code> children.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">146</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>startAt(v)</code> is <strong>inclusive</strong> (the child whose ordered value === v is included)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-query-startat-inclusive.json</code> — seeded positions <code>[1,2,3,4]</code>, observed <code>matched: [2,3,4]</code> for <code>startAt(2)</code> (cursor doc included).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">147</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>endAt(v)</code> is <strong>inclusive</strong></div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-orderbychild-window.json</code> — <code>startAt(2) + endAt(4)</code> matched positions <code>[2,3,4]</code> (endAt(4) included its boundary value).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">148</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>startAfter(v)</code> is <strong>exclusive</strong></div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-startafter-endbefore-exclusive.json</code> — <code>startAfter(2) + endBefore(5)</code> matched positions <code>[3,4]</code> (cursor <code>2</code> dropped).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">149</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>endBefore(v)</code> is <strong>exclusive</strong></div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-startafter-endbefore-exclusive.json</code> — same probe; cursor <code>5</code> dropped.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">150</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>limitToFirst(N)</code> caps the result count from the start of the ordered range</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-query-orderbychild-limit.json</code> plus <code>scripts/oracle/observations/rtdb-modular-limittofirst-vs-limittolast.json</code> (firstPositions <code>[1,2]</code>).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">151</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>limitToLast(N)</code> caps from the end</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-limittofirst-vs-limittolast.json</code> — observed <code>lastKeys: ['d','e'], lastPositions: [4,5]</code> for <code>limitToLast(2)</code> on a 5-child collection ordered by <code>pos</code>.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">152</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Listeners on a <code>Query</code> (<code>onValue(q, …)</code>) emit only the windowed snapshot — NOT the parent ref's full data</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-onvalue-with-query.json</code> — seeded 3 children, watched first 2 by <code>pos</code>; observed 3 fires total: (1) initial <code>[a,b]</code>, (2) OUTSIDE-window write to <code>c/extra</code> did NOT fire, (3) INSIDE-window mutation of <code>a</code> re-fired, (4) new child <code>z</code> displaced <code>b</code> and re-fired. Outside-window writes are silent.</div>
</div>
</div>
</div>

### Sentinels — `serverTimestamp()` / `increment(n)`

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">153</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>serverTimestamp()</code> resolves server-side to a <strong>number</strong> (epoch milliseconds) — diverges from Firestore's <code>Timestamp</code> instance</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-servertimestamp-resolves.json</code> — observed <code>createdAtType: 'number', createdAt: 1779075391118</code> (i.e. a plain JS number, NOT a <code>Timestamp</code> object).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">154</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>serverTimestamp()</code> as a field value in <code>set</code> or <code>update</code> writes the <code>{".sv": "timestamp"}</code> sentinel; the read-back value is the resolved number</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-servertimestamp-resolves.json</code> — read-back showed <code>createdAtSentinelShape: false</code> (sentinel resolved server-side; client sees the number, not the <code>.sv</code> placeholder).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">155</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>increment(n)</code> against a <strong>missing</strong> field starts at 0 (so <code>increment(5)</code> lands as <code>5</code>)</div>
<div class="compat-probe">Sandbox aligned (modular <code>increment</code> export now present): <code>unit:modular/increment.test.ts</code> ("increment against a missing field starts from 0"); matches oracle <code>scripts/oracle/observations/rtdb-modular-increment-from-missing.json</code> — observed <code>afterFirst: 5</code> from <code>increment(5)</code> against an absent <code>count</code> field.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">156</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior"><code>increment(n)</code> against an existing numeric field adds atomically; negative deltas subtract</div>
<div class="compat-probe">Sandbox aligned: <code>unit:modular/increment.test.ts</code> ("subsequent increments accumulate (positive then negative)" + "nested inside an update patch resolves per-field"); matches oracle <code>scripts/oracle/observations/rtdb-modular-increment-from-missing.json</code> — observed <code>afterSecond: 8</code> (5+3) then <code>afterNegative: 6</code> (8-2).</div>
</div>
</div>
<div class="compat-row" data-status="unverified">
<span class="compat-num">157</span>
<span class="compat-dot" role="img" aria-label="Unverified" title="Unverified"></span>
<div class="compat-main">
<div class="compat-behavior">Two concurrent <code>increment</code> calls interleave correctly (last-write-wins is NOT the contract — both deltas accumulate)</div>
<div class="compat-probe">hard to observe deterministically from a single client; documented contract</div>
</div>
</div>
</div>

### `runTransaction(ref, transactionUpdate, options?)` — optimistic concurrency

<div class="compat-list">
<div class="compat-row" data-status="ok">
<span class="compat-num">158</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Basic success — <code>runTransaction(ref, current =&gt; (current ?? 0) + 1)</code> resolves <code>{ committed: true, snapshot }</code> where <code>snapshot.val()</code> is the new value</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-runtransaction-success.json</code> — observed <code>committed: true, snapVal: 1</code> after running <code>current =&gt; (current ?? 0) + 1</code> against an empty ref.</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">159</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Returning <code>undefined</code> from the update fn <strong>aborts</strong> the transaction — resolves <code>{ committed: false }</code>, no write performed (RTDB-specific; distinct from Firestore where the only abort path is throwing)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-runtransaction-abort-undefined.json</code> — seeded <code>100</code> then transaction returned <code>undefined</code>; observed <code>committed: false, snapVal: null, afterValOnServer: 100</code> (existing value preserved).</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">160</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">The update fn is called with the CURRENT server value (may be <code>null</code> if the ref is empty); the fn's return value is the proposed new value</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-runtransaction-success.json</code> — observed <code>seenCurrentValues: [null]</code> on first invocation against an empty ref (a single call, no speculative re-runs against <code>undefined</code>). NOTE — adjacent divergence pinned in <code>modular/oracle-conformance.test.ts</code>: for a SEEDED path, prod speculatively invokes the update fn twice (first with <code>null</code>, then the real value; <code>rtdb-modular-runtransaction-current-value-arg.json</code> <code>seededArgs.length: 2</code>) while the sandbox invokes once with the actual value. The argument-semantics claim of this row holds for the effective invocation on both sides. WARNING for update-fn authors: prod may invoke your fn first with <code>null</code> even when data exists — the pattern <code>if (current === null) return;</code> (abort-on-empty) silently loses writes on prod while working on the sandbox, and side effects inside the fn can run twice on prod. Held (not mimicked) deliberately: the speculative call is a cold-cache artifact, and sandbox determinism + replay depend on single invocation; re-evaluate when a warm-client capture exists.</div>
</div>
</div>
<div class="compat-row" data-status="unverified">
<span class="compat-num">161</span>
<span class="compat-dot" role="img" aria-label="Unverified" title="Unverified"></span>
<div class="compat-main">
<div class="compat-behavior">Concurrent contention — if another client writes between the read and write, the update fn is retried with the new current value (typically up to 25 retries by default)</div>
<div class="compat-probe">hard to observe deterministically from a single client</div>
</div>
</div>
<div class="compat-row" data-status="ok">
<span class="compat-num">162</span>
<span class="compat-dot" role="img" aria-label="Conforming" title="Conforming"></span>
<div class="compat-main">
<div class="compat-behavior">Result snapshot's <code>.val()</code> reflects the committed value (or the existing value if aborted)</div>
<div class="compat-probe">oracle: <code>scripts/oracle/observations/rtdb-modular-runtransaction-success.json</code> — observed <code>snapVal: 1</code> matching the committed value.</div>
</div>
</div>
</div>

### `goOnline` / `goOffline` — connection control

<div class="compat-list">
<div class="compat-row" data-status="unsupported">
<span class="compat-num">163</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior"><code>goOffline(db)</code> disconnects the client; subsequent writes queue locally and surface via <code>onValue</code> with <code>hasPendingWrites</code> (cached value) until <code>goOnline</code> flushes them</div>
<div class="compat-probe">Phase 3 — needs the sandbox to model an offline state; in prod this is upstream contract</div>
</div>
</div>
<div class="compat-row" data-status="unsupported">
<span class="compat-num">164</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior"><code>goOnline(db)</code> reconnects and flushes queued writes</div>
<div class="compat-probe">Phase 3</div>
</div>
</div>
</div>

### `connectDatabaseEmulator` — emulator hook

<div class="compat-list">
<div class="compat-row" data-status="unsupported">
<span class="compat-num">165</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior">No-op on sandbox-target handles (the sandbox IS the local emulator)</div>
<div class="compat-probe">Phase 3</div>
</div>
</div>
<div class="compat-row" data-status="unsupported">
<span class="compat-num">166</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior">Forwards to <code>firebase/database</code>'s <code>connectDatabaseEmulator</code> on prod-target handles</div>
<div class="compat-probe">Phase 3</div>
</div>
</div>
</div>

### `sandbox.*` — sandbox-only test driver

<div class="compat-list">
<div class="compat-row" data-status="unsupported">
<span class="compat-num">167</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior"><code>sandbox.setData(db, {path: value, ...})</code> bulk-loads data, bypassing rules</div>
<div class="compat-probe">Phase 3 — mirror of firestore's <code>sandbox.seedDocuments</code></div>
</div>
</div>
<div class="compat-row" data-status="unsupported">
<span class="compat-num">168</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior"><code>sandbox.setRules(db, rules)</code> loads rules into the underlying local environment; returns <code>LintResult</code></div>
<div class="compat-probe">Phase 3</div>
</div>
</div>
<div class="compat-row" data-status="unsupported">
<span class="compat-num">169</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior"><code>sandbox.snapshotState(db)</code> dumps every path the local store has stored</div>
<div class="compat-probe">Phase 3</div>
</div>
</div>
<div class="compat-row" data-status="unsupported">
<span class="compat-num">170</span>
<span class="compat-dot" role="img" aria-label="Unsupported" title="Unsupported"></span>
<div class="compat-main">
<div class="compat-behavior">All <code>sandbox.*</code> methods throw on prod-target handles with <code>failed-precondition</code></div>
<div class="compat-probe">Phase 3</div>
</div>
</div>
</div>

### Modular SDK surface — deny-list (intentionally NOT shimmed)

| Name | Reason |
|---|---|
| `enableLogging` | Logging is owned by the host harness, not the modular SDK shim. |
| IndexedDB persistence APIs (the Web SDK's RTDB caches in-memory; there's no `enableIndexedDbPersistence` for RTDB, but if upstream adds one, we deny-list it for sandbox parity with firestore's persistence deny-list) | Persistence is owned by `pyric/sandbox`; the modular SDK's cache APIs would conflict. |
| `.info/connected` reads (`onValue(ref(db, '.info/connected'), …)`) | The sandbox has no real connection state to model; firing `true` constantly or never would be a divergence either way. Phase 3 may model this as always-`true` on the sandbox-target. |
| `onDisconnect(ref).set(...)` / `.update(...)` / `.remove(...)` / `.cancel()` | Disconnect handlers require a real network channel; the sandbox has no equivalent. Considered for Phase 3 with explicit divergence documentation. NOT exported (no build break — nothing in the shim references it). |
| `orderByPriority()` / `setPriority(ref, p)` / `setWithPriority(ref, v, p)` and the whole `.priority` model (DB-B6, DB-GAP) | RTDB's priority model — a per-node `.priority` plus a `PriorityIndex` default ordering — is a cross-cutting data-model concern (every node carries an optional priority; the default child ordering is by priority, not key). Modeling it faithfully touches the tree, the snapshot surface, and every query path; it is not cheap and there is no agent/playground demand. Deny-listed with this note. **Divergence:** the sandbox's default child ordering is `orderByKey` (not priority); `setPriority`/`setWithPriority`/`orderByPriority` are not exported. Consumers needing priority use `firebase/database` directly. |
| `refFromURL(db, url)` | Resolving an absolute `https://<db>.firebaseio.com/path` URL has no meaning against the in-memory sandbox (no host/namespace). Use `ref(db, path)`. |

---



### Agent-tool surface — rows still marked **?** (need explicit probes / oracle observations)

_All previously-unprobed rows in this section are now oracle-locked. The list below tracks what was locked in the last sweep, with the probe name + matrix row for each._

- ~~#5 RTDB REST `.json`-suffix contract~~ — locked by `rtdb-rest-json-suffix-contract.json`.
- ~~#39 rules-JSON round-trip vs the REST `/.settings/rules.json` accept format~~ — locked by `rtdb-rules-json-roundtrip.json` (`exactRoundTrip: true`).
- ~~#46 rules-deploy propagation timing~~ — locked by `rtdb-rules-deploy-propagation-timing.json` (`firstSuccessElapsedMs: 154`).
- ~~#58 RTDB shallow REST response shape~~ — locked by `rtdb-shallow-rest-response-shape.json`.
- ~~#71 simulator-vs-live-RTDB allow/deny agreement~~ — observed by `rtdb-simulator-vs-prod-agreement.json` (28/29 agree; 1 divergence documented below). Status is **⚠** rather than **✓** because of the validate-rule divergence.

Rows **flipped from ? to ✓ by Phase 3** (the modular sandbox locks the contract; oracle observations remain blocked on the live RTDB rules at the oracle project, but the sandbox aligned tests pin the same end-state the documented prod behavior requires):

- #18, #31 `set(null) === remove` end-state equivalence — locked by `unit:modular/sandbox-target.test.ts`.
- #23 atomic fan-out update at root path — locked by `unit:modular/sandbox-target.test.ts`.
- #24 multi-path update overlap validation — locked by `unit:modular/sandbox-target.test.ts`.
- #32 idempotent remove on non-existent path — locked by `unit:modular/sandbox-target.test.ts`.

### Modular SDK surface — rows still marked **?** (need explicit probes)

Rows **locked by the empirical oracle harness** (committed observations under `scripts/oracle/observations/`, captured against the `blockingfun` project):

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

36 oracle observations under `scripts/oracle/observations/rtdb-modular-*.json` lock the following modular-SDK rows against `blockingfun`, fb-js-sdk 12.13.0 (20 from Phase 1 + 4 transaction probes from Tier 4 + 5 child-event probes from Tier 2 + 7 query probes from Tier 3):

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

### Agent-tool surface — rows now locked by the live-RTDB happy-path observations (newly unblocked)

Once `ensureOracleRtdbRules` deployed the namespace + index, the 4 originally-blocked legacy probes captured happy-path observations:

- #16 `setData` round-trip — confirmed via `rtdb-set-then-get-roundtrip.json`.
- #18 `set(null)` removes — `rtdb-remove-vs-set-null.json` (`bothNull: true`).
- #23 atomic fan-out update — locked by the new `rtdb-modular-update-multipath-atomic.json` and `rtdb-modular-update-multipath-rules-denial.json` observations (same upstream SDK either way).
- #31 `remove` vs `set(null)` end state — `rtdb-remove-vs-set-null.json` (`equivalent: true`).
- #32 idempotent remove on absent path — `rtdb-modular-remove-idempotent.json`.

### Rows currently marked **⚠** that we might want to upgrade to **✓**

(by aligning the package to the wrapped service or by formally documenting the divergence in `feature-matrix.md`):

- #14 user-mode `READ_FAILED` swallowing the upstream `PERMISSION_DENIED` code.
- #66 simulator cross-path lookup using empty `mockData` instead of reading the live database. (The advisory-only behavior for user-mode writes already documents this; a fix would teach the simulator to fetch cross-path values from the host on demand.)

### Agent-tool rows currently marked **—** that we might want to fill (rough priority)

1. `onValue` / `onChild*` listener tools — most-requested addition; would require tool-call-friendly stream semantics (poll? snapshot at time T?).
2. `query`-with-constraints tool surface — `equalTo` / `orderByChild` / `limit*` parameter shapes.
3. `serverTimestamp` / `increment` sentinel support in the data tools.
4. `runTransaction` tool — atomic read-modify-write.

### Modular SDK surface — implementation status

The sandbox implementation has landed (`packages/pyric/src/database/modular.ts` + `sandbox/`); rows locked by sandbox unit tests or oracle observations sit at `✓`, and rows still pending implementation sit at `—` (see the per-row tables above for the current status of each). The oracle observations are the spec the sandbox conforms to.

## Probe coverage summary

- **Unit (`packages/pyric/test/database/`):** ~30 test files. Strong coverage
  on handlers (`data/handler.test.ts`, `crawl/handler.test.ts`,
  `write/handler.test.ts`, `ir/handler.test.ts`,
  `simulation/handler.test.ts`, `data/validated.test.ts`), the host
  contract (`host.test.ts`), the mapper round-trip
  (`mapper.test.ts`), the resolver (`resolver.test.ts`), and the
  tool factory shape (`tools.test.ts`). Constraint-authoring
  surface (`constraints/`) and grammar (`grammar/`) each have a
  dedicated test suite. The modular-SDK surface ships unit tests
  under `test/database/modular/` (`sandbox-target.test.ts` covers Tier 1
  foundation; `sandbox-child-events.test.ts` covers Tier 2 child events;
  `queries.test.ts` covers Tier 3 query semantics; `transaction.test.ts`
  covers Tier 4 `runTransaction`).
- **Oracle (`scripts/oracle/observations/`):** 50 RTDB probes
  (`scripts/oracle/observations/rtdb-*.json`) — 14 legacy
  (agent-tool surface) + 36 modular-SDK probes (20 Phase 1 + 4 Tier 4
  transaction + 5 Tier 2 child-event + 7 Tier 3 query; see the "Modular
  SDK surface — rows locked by the empirical oracle harness" section for
  the full per-row list). A representative subset:
  - Legacy:
    - `rtdb-set-then-get-roundtrip` — **passing** — locks #16/#10 round-trip.
    - `rtdb-onvalue-fires-on-set` — **passing** — locks listener-fire-on-set semantics.
    - `rtdb-remove-vs-set-null` — **passing** — locks #18/#31.
    - `rtdb-push-autoid-format` — **passing** — locks #27/#28 (client-side key minting).
    - `rtdb-servertimestamp-resolves` — **passing** — locks sentinel resolution to a number.
    - `rtdb-rules-denied-error-code` — **passing** — locks #15/#20 (plain `Error` + `PERMISSION_DENIED` uppercase code).
  - Modular SDK Phase 1 (`rtdb-modular-*`):
    - `rtdb-modular-get-snapshot-shape` — locks #106.
    - `rtdb-modular-get-missing-path` — locks #107/#108.
    - `rtdb-modular-set-null-equals-remove` — locks #112.
    - `rtdb-modular-set-replaces-not-merges` — locks #113.
    - `rtdb-modular-update-merges-keys` — locks #116.
    - `rtdb-modular-update-multipath-atomic` — locks #117 + agent-tool #23.
    - `rtdb-modular-update-multipath-rules-denial` — locks #118.
    - `rtdb-modular-update-null-removes-key` — locks #119.
    - `rtdb-modular-remove-idempotent` — locks #122 + agent-tool #32.
    - `rtdb-modular-push-with-value` — locks #126/#127.
    - `rtdb-modular-onvalue-initial-with-data` — locks #128.
    - `rtdb-modular-onvalue-initial-no-data` — locks #129.
    - `rtdb-modular-onvalue-unsubscribe` — locks #131.
    - `rtdb-modular-onchildadded-initial-replay` — locks #133.
    - `rtdb-modular-query-orderbychild-limit` — locks #142/#150.
    - `rtdb-modular-query-equalto` — locks #145.
    - `rtdb-modular-query-startat-inclusive` — locks #146.
    - `rtdb-modular-increment-from-missing` — locks #155/#156.
    - `rtdb-modular-runtransaction-success` — locks #158/#160/#162.
    - `rtdb-modular-runtransaction-abort-undefined` — locks #159.
    - `rtdb-modular-runtransaction-current-value-arg` — locks #160 (`null` for absent paths; documents the prod-vs-sandbox speculative-call divergence for seeded paths).
    - `rtdb-modular-runtransaction-returns-committed-snapshot` — locks #162 (result shape: `{ committed, snapshot }`, snapshot responds to `.val()`/`.exists()`/`.key`).
    - `rtdb-modular-runtransaction-options-applylocally` — locks the `options.applyLocally` branch contract; single-client harness shows both branches end at the same value with init+commit fires.
    - `rtdb-modular-runtransaction-on-rules-denied-path` — locks the transaction-specific rules-denied error shape: plain `Error`, `message: 'permission_denied'` (lowercase), NO `.code` field — **distinct** from `set`/`get`'s uppercase `PERMISSION_DENIED:` shape.

### Harness extension: `ensureOracleRtdbRules`

`scripts/oracle/run.ts` now deploys an RTDB rules namespace
analogous to `ensureOracleRules` / `ensureOracleStorageRules`. The
JSON shape:```json
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
```The harness mints a separate OAuth token scoped to
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

## Simulator-vs-prod divergences (from row #71 audit)

The simulator-vs-prod agreement audit (`scripts/oracle/observations/rtdb-simulator-vs-prod-agreement.json`) deployed 8 rule patterns and ran 29 `(rule, op)` tuples against both the live `blockingfun` RTDB and the in-process `SimulateHandler`. 28 of 29 agreed; the one divergence:

### Divergence 1 — `.validate` rules not evaluated during writes

**Rule:**```json
{
  ".read": "auth != null",
  ".write": "auth != null",
  "entry": {
    ".validate": "newData.hasChildren(['title', 'body'])"
  }
}
```**Op:** `write` at `/r4-validate-structure/entry` with `newData: { title: 't' }` (intentionally missing `body`), `auth.uid` present.

**Live RTDB:** `PERMISSION_DENIED` — the `.validate` rule rejects the write because `newData.hasChildren(['title', 'body'])` is false.

**Simulator (`SimulateHandler`):** `allowed: true, reason: "Rule expression evaluated to true"` — the simulator's walk from root finds the ancestor `.write: 'auth != null'` returns true and short-circuits there, never descending into the `entry` node to evaluate the `.validate` rule.

**Root cause:** `packages/pyric/src/database/simulation/handler.ts` only reads `ancestor.node[operation]` (one of `'read'` | `'write'` | `'validate'`) per iteration. For an `operation: 'write'` simulation, it never queries the `.validate` rule on the same or descendant ancestors. RTDB's real rules engine evaluates `.validate` rules at every ancestor of the write path in addition to the `.write` rule — a single `.validate` failure rejects the entire write.

**Implication for consumers of `validatedWrite`:** the simulator's `SIMULATION_DENIED` signal currently doesn't fire for `.validate` failures during writes. In admin mode this means a write that prod would reject via `.validate` will still be dispatched. In user mode the live rule still enforces, so the deny lands at the prod write — same end-state, but the advisory preflight signal is missing.

**Fix path (out of scope for this PR):** the simulator's write-eval loop should also walk every ancestor's `.validate` rule and require ALL of them to evaluate `true` (or be absent) in addition to a `.write` rule granting access. Tracked as a follow-up engineering task — this PR's job is to document the divergence per the row #71 methodology, not fix the simulator.
