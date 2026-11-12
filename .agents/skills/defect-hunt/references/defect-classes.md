# Defect classes and standing mechanical checks

Raw finding counts hide whether a round uncovered **new defect mechanisms** or
rediscovered an already-known mechanism in a sibling serializer, plane, or AST
pass. Classify every confirmed finding by **Class**, **Sub-Class** (for
`SEMANTICS-DIVERGENCE`), **Mechanism**, and **Novelty** so fix campaigns close
whole classes instead of patching one caller at a time.

## 1. Primary defect classes

| Class | Meaning | Typical boundary |
|---|---|---|
| `SEMANTICS-DIVERGENCE` | Pyric reimplements a Firebase evaluator, prover, tree/query rule, regex/MIME rule, or SDK contract with behavior that differs from production or the spec. **Always assign one `SD:*` sub-class below.** | Rules runtime, list prover, RTDB/Firestore/Storage engines, SDK/Admin methods |
| `STATE-ROUNDTRIP` | A serializer, snapshot, checkpoint, reset, branch, replay, fixture, seed export, or loopback clone drops, mutates, or fails to restore state, rules, metadata, priorities, or credentials (`decode(encode(S)) != S`). | Snapshots, `.pyric/state/*`, `branches`, `verifyFixture`, `seed-from-live`, `/__pyric/state` |
| `BACKEND-PARITY` | Two execution planes implementing the same contract or backed by the same sandbox disagree on results, error codes, ordering, or cross-visibility. | In-process vs SharedWorker vs IndexedDB vs Hosted Node vs `pyric-admin` local/remote vs MCP |
| `ENTRYPOINT-PARITY` | Two entrypoints or configuration loaders resolve project config, `rules_version = '2+modules'`, `.firebaserc` targets, flags, or mode guards inconsistently. | CLI commands, MCP `--surface` modes, Vite plugin, Next plugin, `lint()`, `verify`, library APIs |
| `GUARD-BYPASS` | An isolation, module-swap, refusal, path-containment, or local-surface access-control guard can be bypassed or misrouted. | Swap-or-Stop (`ADR 0022`/`0023`), Live project/write refusal, loopback token/`Origin`/`Sec-Fetch-Site`/`Host` (`ADR 0024`) |
| `FAIL-OPEN` | An evaluator, static pass, Live local-rules check, auth check, or CLI command handles missing state, unmodeled syntax, partial observation, or invalid input by emitting a decided allow/proof/success verdict instead of abstaining or failing closed. | Live `observe-local-*`, static assurance passes, token/user gates, config parsers |
| `REDACTION-LEAK` | An unused credential or pyric-held upstream secret (provider key, OAuth/refresh token, seeded password in a shareable fixture) leaks into capture records, wire messages, logs, or responses beyond `ADR 0024`. | Capture boundaries, upstream AI proxy error paths, shareable snapshot/campaign exports |

## 2. `SEMANTICS-DIVERGENCE` sub-classes (`SD:*`)

Assign exactly one sub-class whenever `Class` is `SEMANTICS-DIVERGENCE`. Keep
high-severity Security Rules sub-classes separate from SDK/runtime shape drift:

| Sub-Class | Scope | Primary offline oracle / check |
|---|---|---|
| `SD:ASSURANCE-RULES-SEMANTICS` | Assurance static rules AST projection, scoping, and witness synthesis | In-repo `pyric/rules.simulate()` + `Sandbox` |
| `SD:FS-LIST-PROVER` | Firestore `list` / `collectionGroup` static query satisfiability prover | Counterexample universe checked against single-doc `firestoreRules().simulate()` |
| `SD:FS-RULES-EVAL` | Firestore Security Rules expression evaluator, wrapper types, lexical scopes, `getAfter()` (**Note: Firebase Security Rules are NOT Google CEL**) | `observations/firestore-rules/` + offline Firestore Emulator |
| `SD:RTDB-RULES-AND-TREE` | RTDB `.read`/`.write`/`.validate`/`.indexOn` cascade, `.priority`, and sparse tree/query semantics | Installed `@firebase/database` + `observations/rtdb*` + RTDB Emulator |
| `SD:STORAGE-RULES-AND-MIME` | Storage Security Rules `resource`/`request.resource`/`firestore.get()` and upload MIME/name derivation | `observations/storage*` + intercepted `@firebase/storage` + Storage Emulator |
| `SD:REGEX-ENGINES` | Security Rules RE2 validation/matching/normalization and RTDB regex dialect | Offline RE2 engine + `observations/*-rules/` |
| `SD:SDK-ERRORS-CALLBACKS-SHAPES` | Client and Admin SDK error codes, prototypes, return shapes, and async observer delivery | Installed `firebase` / `firebase-admin` + `observations/` |
| `SD:FIRESTORE-ENGINE` | Firestore UTF-8 ordering, `runTransaction` isolation, aggregations, indexes, and bundles | `observations/firestore/` + `@firebase/firestore` + Firestore Emulator |
| `SD:AI-AND-APP-CHECK` | AI Logic and App Check init, `CustomProvider`, `AbortSignal`, and Admin TTLs | `@firebase/{ai,app-check}` over mocked `fetch`/SSE + `observations/` |
| `SD:FUNCTIONS-RUNTIME` | Functions trigger discovery, `.env` loading, body quotas, and worker supervision | `firebase-functions` manifest + Functions Emulator + spec |
| `SD:AUTH-SDK` | Client/Admin Auth init persistence, `reload()` listeners, `UserRecord`/`IdTokenResult` shapes | `@firebase/auth` (loopback stub) + `observations/auth/` |
| `SD:MESSAGING-ADMIN` | Admin Messaging condition grammar precedence and error shapes | `firebase-admin/messaging` + grammar truth table + `observations/` |

## 3. Normalized `OTHER:*` classes and the `NEW:*` escape hatch

Use these when a finding genuinely falls outside the 7 primary classes:

- `OTHER:STATIC-ANALYSIS-MODEL`: Static TS/Rules AST analyzers or `2+modules` bundlers mismodeling language syntax, spreads, barrels, or imports (distinct from runtime rules semantics).
- `OTHER:HOST-LIFECYCLE-AND-ERRORS`: Mutating state before input validation throws, stale session/PID state across transitions, or sync-throw vs async-error contracts.
- `OTHER:DIAGNOSTIC-FIDELITY`: Wrong refusal code, broken remediation snippet, or missing beacon/error attribution.
- `OTHER:MISSING-SURFACE`: Documented static/prototype member or package export missing.
- `OTHER:RESOURCE-LEAK`: Unbounded heap, listener, file handle, or uncancelled upstream request leak.
- `OTHER:DOCS-DRIFT`: Published docs contradict the exported or observed contract.
- `NEW:<UPPER-KEBAB-NAME>`: **Novelty escape hatch.** If a defect mechanism fits none of the classes above, mint `NEW:<SHORT-NAME>` and explain why. Never force-fit a novel failure mode into an existing bucket.

## 4. Required fields per finding

Every hunter finding, verifier row, and ledger row records four classification fields:

1. **Class:** Primary class, `OTHER:*`, or `NEW:*`.
2. **Sub-Class:** Required `SD:*` when `Class` is `SEMANTICS-DIVERGENCE`; otherwise `n/a`.
3. **Mechanism:** Short `kebab-case` identifier naming the root failure mechanism (e.g., `named-bucket-snapshot-loss`, `helper-wildcard-shadowing`, `partial-obs-claims-definite-allow`, `missing-origin-check-sse`).
4. **Novelty:** One of:
   - `new-class` (first time this class appears on the surface, or `NEW:*`),
   - `new-mechanism` (existing class, distinct mechanism not seen in earlier rounds or open issues),
   - `repeat-mechanism (<prior ID or issue>)` (same mechanism repeating on a sibling serializer, plane, route, or AST pass).

## 5. Repeat-class escalation rule

Point fixes that only pin the reported repro leave sibling consumers exposed.
When a `Class` (or `SD:*` sub-class) **repeats across consecutive rounds** or
accumulates **`>= 3` confirmed `REAL` findings in one round**, the fix campaign
must land or extend a **standing mechanical check** alongside the source fixes:

| Repeating class / sub-class | Standing mechanical check to build or extend |
|---|---|
| `STATE-ROUNDTRIP` | Maximal-state "kitchen-sink" roundtrip harness (`decode(encode(S)) == S`) covering every snapshot, reset, branch, fixture, seed, and loopback clone path. |
| `SD:ASSURANCE-RULES-SEMANTICS` | Differential fuzzer comparing static rule projection, synthesized witnesses, and probe setup against `pyric/rules.simulate()` and `Sandbox`. |
| `FAIL-OPEN` (abstention) | Two-world partial-observation oracle: when two concrete worlds compatible with a partial observation disagree under `simulate()`, assert Live Mode and Assurance abstain. |
| `SD:FS-LIST-PROVER` | Counterexample-universe soundness check: whenever `proveListQuery` returns allow, assert zero query-matching docs in an adversarial universe deny under `simulate()`. |
| `BACKEND-PARITY` | Parameterized multi-op driver matrix across in-process, worker/HTTP, IndexedDB, local/remote Admin, and MCP backed by one `Sandbox`. |
| `ENTRYPOINT-PARITY` | Multi-feature canonical project fixture (`2+modules`, `.firebaserc` targets, named resources, `--surface` modes) exercised across all CLI/MCP/plugin/API entrypoints. |
| `GUARD-BYPASS` | Loopback canary sink and adversarial vector matrix across Node register/child/Worker, Vite, Next, Hosted HTTP, and Live routes (including session token, `Origin`, `Sec-Fetch-Site`, and loopback `Host`). |
| `SD:REGEX-ENGINES` | Differential pattern corpus against an offline RE2 engine across every regex caller. |
| `OTHER:STATIC-ANALYSIS-MODEL` | Generated TS/modular-rules corpus comparing static extracted access sites against an instrumented `Sandbox`. |

## 6. Scoring a round by novelty, not raw volume

In the round ledger (`templates/ledger.md`), track **New Mechanisms** and
**Repeat Mechanisms** next to **Confirmed (`REAL`)**:

- A high count of `repeat-mechanism` findings means the last fix campaign
  shipped point fixes without a class-level standing check. Prioritize building
  the standing check before running another hunter sweep on that surface.
- An angle or class whose standing check catches sibling misses in CI -- driving
  hunt `repeat-mechanism` yield to `0` -- is working as designed.
