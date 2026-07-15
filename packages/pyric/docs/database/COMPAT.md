<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/database` compatibility matrix

<div class="compat-stat">
<p class="compat-stat-surface"><strong>Public surface:</strong> runtime 79.5% (35/44) <span aria-hidden="true">·</span> types 53.3% (8/15)</p>
<p class="compat-stat-figure">
<span class="compat-stat-pct">76.6%</span>
<span class="compat-stat-label">of tracked behaviors conform</span>
</p>
<p class="compat-stat-denom">154 of 201 tracked behaviors</p>
<div class="compat-stat-bar" role="img" aria-label="Behavior distribution: 154 conform, 9 documented divergences, 0 bugs, 26 unsupported, 12 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 154" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 9" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 26" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unverified" style="flex-grow: 12" aria-hidden="true"></span>
</div>
<ul class="compat-stat-key" aria-label="Behavior state counts">
<li class="compat-stat-item"><span class="compat-dot" data-status="ok" aria-hidden="true"></span><span><strong>154</strong> conform</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="diverged" aria-hidden="true"></span><span><strong>9</strong> documented divergences</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="bug" aria-hidden="true"></span><span><strong>0</strong> bugs</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unsupported" aria-hidden="true"></span><span><strong>26</strong> unsupported</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unverified" aria-hidden="true"></span><span><strong>12</strong> unverified</span></li>
</ul>
<p class="compat-stat-note">Public surface measures whether exports exist. Fidelity measures whether tracked behavior matches production.</p>
</div>
[Read how the axes differ.](../conformance/SCORES.md)

> ⚠ **EXPERIMENTAL — not v1-supported.** The v1-supported, conformance-held surface is **auth + firestore + rules**. The modular `firebase/database` mirror rows below are verified sandbox-side by unit probes, but most are not yet captured against a live production project. Do not depend on RTDB parity for a production swap yet.

`pyric/database` is the sandbox-only modular mirror. Package resolution selects it during Pyric development; production code continues to import the unchanged `firebase/database` package. The mirror never dispatches to production at runtime.

The pure RTDB rules engine remains on the unstable `pyric/rules/internal/rtdb` seam for simulator, replay, grammar, and constraints consumers. Its compiled rules tree carries no service or database environment metadata. Production data access and deployment are intentionally absent.

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — observable behavior matches Firebase, locked by a passing probe |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match Firebase but does not |
| — | **Unsupported** — not implemented or intentionally outside the mirror |
| ? | **Unverified** — not yet backed by sufficient evidence |

Probe references: `unit:<file>` means a Bun test under `packages/pyric/test/database/`; `oracle:<name>` cites a recorded observation under `packages/conformance/observations/`.

---

## Archived production-toolkit observations

These unsupported tombstones preserve immutable oracle `rowIds` for the removed host, REST, data, crawl, generation, and deployment toolkit. They are historical evidence, not current API claims.

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| Removed REST host |  | Historical `.json` REST transport contract for the removed production host. | — | Archived oracle observation; implementation removed. | 5 |
| Removed data handler |  | Historical admin read and set/get behavior for the removed production data handler. | — | Archived oracle observations; implementation removed. | 10 |
| Removed data handler |  | Historical user read return shape for the removed production data handler. | — | Archived oracle observation; implementation removed. | 11 |
| Removed data handler |  | Historical rules-denial normalization for the removed production data handler. | — | Archived oracle observations; implementation removed. | 14 |
| Removed data handler |  | Historical rules-denied read behavior for the removed production data handler. | — | Archived oracle observation; implementation removed. | 15 |
| Removed data handler |  | Historical set/get round trip for the removed production data handler. | — | Archived oracle observation; implementation removed. | 16 |
| Removed data handler |  | Historical set-null removal behavior for the removed production data handler. | — | Archived oracle observation; implementation removed. | 18 |
| Removed data handler |  | Historical rules-denied write behavior for the removed production data handler. | — | Archived oracle observation; implementation removed. | 20 |
| Removed data handler |  | Historical multi-path update behavior for the removed production data handler. | — | Archived oracle observation; implementation removed. | 23 |
| Removed data handler |  | Historical push key behavior for the removed production data handler. | — | Archived oracle observation; implementation removed. | 27 |
| Removed data handler |  | Historical push auto-ID format for the removed production data handler. | — | Archived oracle observation; implementation removed. | 28 |
| Removed data handler |  | Historical remove-versus-set-null behavior for the removed production data handler. | — | Archived oracle observation; implementation removed. | 31 |
| Removed data handler |  | Historical idempotent removal behavior for the removed production data handler. | — | Archived oracle observation; implementation removed. | 32 |
| Removed rules fetch handler |  | Historical deployed-rules JSON round trip for the removed production fetch handler. | — | Archived oracle observation; implementation removed. | 39 |
| Removed rules deployment handler |  | Historical rules deployment propagation timing for the removed production deploy handler. | — | Archived oracle observation; implementation removed. | 46 |
| Removed REST crawler |  | Historical shallow REST response shape for the removed production crawler. | — | Archived oracle observation; implementation removed. | 58 |

## `simulateRtdbRules(compiled, input)` — in-process rule evaluator

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| simulateRtdbRules(compiled, input) |  | The removed stateful simulator returned a generate-before-simulate error when no IR had been generated | — | The stateless `simulateRtdbRules(compiled, input)` API requires a compiled rules tree and has no generate-before-simulate lifecycle. | 59 |
| simulateRtdbRules(compiled, input) |  | Returns `{ success: false, error: { code: 'INVALID_INPUT' } }` when input doesn't parse against `SimulationInputSchema` (e.g. path missing leading slash, operation not in read / write / validate) | ✓ | `unit:simulation/handler.test.ts` | 60 |
| simulateRtdbRules(compiled, input) |  | Walks ancestors from root → target; the first ancestor whose rule expression evaluates to `true` grants access — matches RTDB's documented "rules cascade from root, true at any ancestor grants" semantics | ✓ | `unit:simulation/handler.test.ts` | 61 |
| simulateRtdbRules(compiled, input) |  | Path variables (`$userId`) are bound from the URL path and exposed in `pathVariableBindings` (also without the `$` prefix for ergonomic access in expressions) | ✓ | `unit:simulation/handler.test.ts` | 62 |
| simulateRtdbRules(compiled, input) |  | `auth` context: when `null`, `auth` is null inside expressions; when present, `auth.uid` and `auth.token.*` are bound | ✓ | `unit:simulation/handler.test.ts`, `unit:grammar/simulator.test.ts` | 63 |
| simulateRtdbRules(compiled, input) |  | `mockData` becomes the value of `data` at every path during evaluation; `newData` is the proposed value for write/validate | ✓ | `unit:simulation/handler.test.ts` | 64 |
| simulateRtdbRules(compiled, input) |  | `data.child("…")`, `data.parent()`, `data.exists()`, `data.val()` evaluate against the in-process snapshot — matches the documented `DataSnapshot` rule-context surface | ✓ | `unit:grammar/simulator.test.ts` | 65 |
| simulateRtdbRules(compiled, input) |  | Cross-path `root.child(…).val()` reads return `null` for paths NOT present in `mockData` — divergence from real prod rules where the engine reads the live database | ⚠ | divergence: the simulator uses ONLY what's in `mockData`. Real rules engine reads from the live RTDB. Documented in `validated.ts` ("simulation uses empty mockData, so cross-path rule lookups … will evaluate as false") | 66 |
| simulateRtdbRules(compiled, input) |  | An expression that fails to parse (`parsed.valid === false`) produces an unsupported result rather than silently granting or fabricating a deny | ✓ | `unit:simulation/handler.test.ts` | 67 |
| simulateRtdbRules(compiled, input) |  | When no ancestor rule allows, the result is `{ allowed: false }` with `matchedPath` set to the deepest matched node | ✓ | `unit:simulation/handler.test.ts` | 68 |
| simulateRtdbRules(compiled, input) |  | When NO ancestor has a rule for the operation at all, returns `{ success: false, error: { code: 'NO_MATCHING_RULE' } }` | ✓ | `unit:simulation/handler.test.ts` | 69 |
| simulateRtdbRules(compiled, input) |  | Evaluation errors (grammar mismatch, unknown identifier) surface as `EVALUATION_ERROR` | ✓ | `unit:simulation/handler.test.ts` | 70 |
| simulateRtdbRules(compiled, input) |  | Simulator's allow/deny decision matches the real RTDB rules engine for the same `{ rules, mockData, auth, operation, path, newData }` tuple, modulo the documented cross-path divergence on row #66 | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-simulator-vs-prod-agreement.json` — 8 test rules × 29 (rule, op) tuples; 28 agreements, 1 disagreement at capture time (`r4-validate-structure`: the simulator did not evaluate `.validate` on writes). The `.validate` walk is now implemented (`src/rules/rtdb/simulation/handler.ts`, reached from all backend write sites; grammar array-literals + `hasChildren(keys)` fixed alongside), closing the recorded disagreement — replayed as prod-conforming denial in `oracle-conformance.test.ts`. The frozen capture documents the historical divergence | 71 |

## Constraint authoring surface (`atoms` / `policies` / `compose` / `ruleset`)

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `atoms` exports the documented set of primitive predicates (`authenticated`, `ownPath`, `ownField`, `isNew`, `hasChildren`, `hasChild`, `fieldIsString/Number/Boolean`, `fieldEnum`, `immutable`, `immutableSelf`, `rootExists`, `rootEquals`) — each returns an `Expr` | ✓ | `unit:constraints/atoms.test.ts` | 84 |
|  |  | `policies` exports composite predicates that compose atoms: `pathOwnerOnly`, `fieldOwnerOnly`, `ownerOrNew`, `hasRole`, `isMember`, `required`, `transition` | ✓ | `unit:constraints/policies.test.ts` | 85 |
|  |  | `compose` exports the boolean combinators `all`, `any`, `not`, `deny`, `always`, plus the raw `expr` constructor | ✓ | `unit:constraints/compose.test.ts` | 86 |
|  |  | `ruleset(...)` builds an environment-independent compiled RTDB rules tree from path definitions + expression objects | ✓ | `unit:constraints/ruleset.test.ts` | 87 |
|  |  | Game-domain helpers (`turnGuard`, `flip`, `winCheckHelper`) compose into legal rule expressions | ✓ | `unit:constraints/game.test.ts` | 88 |

## Compiled RTDB rules tree ↔ rules JSON

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| compileRtdbRules |  | `compileRtdbRules(rulesJson)` produces an environment-independent tree where each node carries its path, parsed expressions, and child nodes | ✓ | `unit:compiled-rules.test.ts` | 89 |
| serializeRtdbRules |  | `serializeRtdbRules(compiled)` produces the Firebase rules-JSON payload for the compiled tree | ✓ | `unit:compiled-rules.test.ts` | 90 |
| compileRtdbRules / serializeRtdbRules |  | Round-trip `compileRtdbRules(serializeRtdbRules(compiled))` produces an equivalent rules tree (locked path/expression-text equality, not object identity) | ✓ | `unit:compiled-rules.test.ts` | 91 |
| compileRtdbRules / serializeRtdbRules |  | Path-variable segments (`$userId`, `$gameId`) preserved across the round-trip | ✓ | `unit:compiled-rules.test.ts` | 92 |
| compileRtdbRules / serializeRtdbRules |  | `.indexOn` arrays preserved across the round-trip | ✓ | `unit:compiled-rules.test.ts` | 93 |

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

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `getDatabase(ctx)` builds a sandbox-target `Database`; frozen `ctx.auth` baked in | ✓ | `unit:modular/sandbox-target.test.ts` ("getDatabase(ctx) returns a tagged Database handle") | M1 |
|  |  | `getDatabase(sandbox)` builds a sandbox-live target; reads `sandbox.currentUser` per op | ✓ | `unit:modular/sandbox-target.test.ts` ("reads sandbox.currentUser at op time, not at getDatabase time") | M2 |
|  |  | An in-module production target is intentionally absent; direct calls with a real `FirebaseApp` reject with package-resolution guidance | — | `unit:modular.test.ts`; production remains the responsibility of the unchanged `firebase/database` package | M3 |
|  |  | `ref(db, path?)` returns a path-tagged `DatabaseReference`; default is root | ✓ | `unit:modular/sandbox-target.test.ts` ("ref(db) returns a root ref" + "ref(db, ...) returns a path ref") | M4 |
|  |  | `child(ref, 'sub/path')` composes paths; result inherits the parent's target | ✓ | `unit:modular/sandbox-target.test.ts` ("child(ref, 'sub') composes paths") | M5 |
|  |  | `ref.parent` returns the parent ref; `root.parent === null` | ✓ | `unit:modular/sandbox-target.test.ts` ("ref.parent returns the parent ref; root.parent is null") | M6 |
|  |  | `ref.root` returns the root ref of the same target | ✓ | `unit:modular/sandbox-target.test.ts` ("ref.root returns the root ref") | M7 |
|  |  | `get(ref)` returns a `DataSnapshot`-shaped object with `val()`, `exists()`, `key`, `child()`, `hasChildren()`, `numChildren()`, `toJSON()` | ✓ | `unit:modular/sandbox-target.test.ts` (snapshot shape tests) | M8 |
|  |  | `get` on an absent path resolves to `{ val: null, exists: false }` (matches `DataSnapshot.val()` contract) | ✓ | `unit:modular/sandbox-target.test.ts` ("reads return null for an absent path") | M9 |
|  |  | `set(ref, value)` replaces the value at the path | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("round-trips a primitive value" + "round-trips nested objects"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-set-then-get-roundtrip.json` (prod observation blocked on rules; sandbox locks the contract directly) | M10 |
|  |  | `set(ref, null)` deletes the subtree at the path | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("set(ref, null) deletes the path"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` | M11 |
|  |  | `remove(ref)` is equivalent to `set(ref, null)` (same end state) | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("remove and set(null) produce identical end-state"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` | M12 |
|  |  | `update(ref, patch)` shallow-merges top-level keys at the ref's path | ✓ | `unit:modular/sandbox-target.test.ts` ("shallow-merges top-level keys") | M13 |
|  |  | `null` value in a shallow update deletes that key | ✓ | `unit:modular/sandbox-target.test.ts` ("null values in a shallow update delete the key") | M14 |
|  |  | `update(rootRef, { '/a/x': v1, '/b/y': v2 })` is a multi-path atomic write — all paths land or none do | ✓ | `unit:upstream-rtdb-probes.test.ts` ("one update nulls, mutates, and displaces within a limitToFirst window") + `unit:modular/sandbox-target.test.ts` (atomic multipath + rules denial); matches the matrix #23 prod contract | M15 |
|  |  | Overlapping multi-path updates (one path is a descendant of another) reject before any path is written | ✓ | `unit:modular/sandbox-target.test.ts` ("rejects overlapping paths") | M16 |
|  |  | `push(ref)` mints a 20-char auto-id key starting with `-`, lexicographically sortable | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("mints 20-char keys starting with \"-\"" + "sequential push keys are lex-sortable"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json` | M17 |
|  |  | `push(ref, value)` writes `value` at the new child path | ✓ | `unit:modular/sandbox-target.test.ts` ("push(ref, value) writes the value at the new child path") | M18 |
|  |  | `pushKey()` mints a fresh push-shaped key without writing — used by callers building multi-path updates that need the key first | ✓ | `unit:modular/sandbox-target.test.ts` ("pushKey() mints a fresh key without writing") | M19 |
|  |  | `serverTimestamp()` returns the `{ ".sv": "timestamp" }` sentinel marker the wire encoder recognises | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("serverTimestamp() returns the documented shape"); matches the prod wire contract | M20 |
|  |  | `serverTimestamp()` resolves to a number (epoch ms) on read-back | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("resolves to a number on read-back"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json` (prod observation blocked on rules; sandbox locks the contract directly) | M21 |
|  |  | `serverTimestamp()` sentinels resolve when nested inside multi-path update payloads | ✓ | `unit:modular/sandbox-target.test.ts` ("resolves sentinels nested deep inside an update payload") | M22 |
|  |  | Rules-denied write throws a plain `Error` (NOT a `FirebaseError`) with `.code === 'PERMISSION_DENIED'` (uppercase snake-case) and `.message === 'PERMISSION_DENIED: Permission denied'` | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("rules-denied set throws a plain Error with PERMISSION_DENIED code"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` (against blockingfun, fb-js-sdk 12.13.0) | M23 |
|  |  | Rules-denied read throws the same plain-`Error` `PERMISSION_DENIED` shape as a denied write | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("rules-denied get throws the same plain Error shape"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` | M24 |
|  |  | Rules-denied remove throws the same plain-`Error` `PERMISSION_DENIED` shape | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("rules-denied remove throws the same plain Error shape") | M25 |
|  |  | `onValue(ref, cb)` fires immediately on subscribe with the current value at the path | ✓ | `unit:modular/sandbox-target.test.ts` ("fires on subscribe with the current value") | M26 |
|  |  | `onValue` fires again after every write that CHANGES the value at the watched path; a write that leaves the watched subtree byte-identical (a no-change re-write, or an ancestor/descendant write that doesn't alter this path) is suppressed (DB-B8) | ✓ | `unit:modular/sandbox-target.test.ts` ("fires after every write that touches the watched path") + `unit:modular/no-change-suppression.test.ts` ("re-writing the same value does NOT re-fire" + "ancestor write leaving the subtree unchanged does NOT fire") | M27 |
|  |  | `onValue` fires after a descendant write (the listener sees subtree changes) | ✓ | `unit:modular/sandbox-target.test.ts` ("fires on a descendant write") | M28 |
|  |  | `onValue` initial-fire for an absent path delivers `val=null, exists=false` (matches matrix expectation locked by oracle for sentinel/listener shape) | ✓ | `unit:modular/sandbox-target.test.ts` ("absent path: initial fire delivers val=null, exists=false") | M29 |
|  |  | The `onValue` return value is an unsubscribe function; calling it stops further fires | ✓ | `unit:modular/sandbox-target.test.ts` ("fires after every write that touches the watched path" — checks unsubscribed listener doesn't fire on subsequent write) | M30 |
|  |  | `onChildAdded` / `onChildChanged` / `onChildRemoved` / `onChildMoved` — plain-ref subscription surface | ✓ | Tier 2: sandbox aligned with oracle observations under `packages/conformance/observations/rtdb-modular/rtdb-modular-onchild*.json`. See M41–M48 for the per-event behavioral claims. | M31 |
|  |  | `onChildAdded` replays each existing direct child of the parent ref on subscribe (one fire per existing key) | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("replays existing direct children on subscribe — one fire per key"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-initial-replay.json` (seeded `{k1,k2,k3}`, observed `firedKeys: ['k1','k2','k3']`). | M41 |
|  |  | After subscribe, `onChildAdded` fires exactly once per new direct child write; snapshot carries `{key, val}` of the new child | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("fires exactly once per NEW direct child after subscribe"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-post-subscribe.json` (`postSubscribeFires: 1`, `lastFire: {key:'k3', val:{v:3}}`). | M42 |
|  |  | `onChildChanged` has NO initial replay; fires once when an existing direct child's value transitions; snapshot carries the NEW value | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("does NOT fire on subscribe (no initial replay)" + "fires once when an existing child transitions to a new value; snapshot carries NEW val"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildchanged-fires-on-update.json` (`firedOnInitial: 0, firedOnUpdate: 1, lastFire: {key:'k1', val:{v:2}}`). | M43 |
|  |  | `onChildChanged` does NOT fire for added or removed children — those go to the other event listeners | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("does NOT fire when a child is added" + "does NOT fire when a child is removed"). | M44 |
|  |  | `onChildRemoved` has NO initial replay; fires once when a direct child is deleted (via `remove(child)` or `set(child, null)`); snapshot carries the PRIOR (now-removed) value | ✓ | `unit:upstream-rtdb-probes.test.ts` (parent wipe fan-out via remove(parent) / set(parent, scalar)) + `unit:modular/sandbox-child-events.test.ts` (single-child delete carries PRIOR val); matches oracle `rtdb-modular-onchildremoved-fires-on-delete.json` | M45 |
|  |  | `onChildMoved` on a plain ref (no `query(_, orderBy*)`) NEVER fires — per RTDB docs, child_moved emits only under ordered queries | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("does NOT fire on a plain ref (no ordering)"); matches the upstream contract observed under ordered-query in `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildmoved-with-orderby.json` (where ordered-query did fire — Tier 3 will wire that path; Tier 2 locks the plain-ref no-fire case). | M46 |
|  |  | `off(ref)` (no event type) removes ALL listeners at that ref — value + every child event variety | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("off(ref) removes ALL listeners at the ref" + "off(ref) also removes value listeners at the same path"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-off-stops-child-fires.json` (`postOffFires: 0`). | M47 |
|  |  | `off(ref, eventType?, callback?)` variants: `off(ref, 'value')` / `off(ref, 'child_added')` / `off(ref, eventType, cb)` remove the targeted subset; returned-unsubscribe from `onChild*` is equivalent to `off(ref, eventType, cb)` | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("off(ref, \"child_added\") removes only that event variety" + "off(ref, \"value\") removes only value listeners" + "off(ref, eventType, cb) removes only the matching callback" + "returned-unsubscribe from onChildAdded is functionally equivalent to off()"). | M48 |
|  |  | `connectDatabaseEmulator(db, host, port)` is a no-op on sandbox targets (the sandbox IS a local emulator) | ✓ | `unit:modular/sandbox-target.test.ts` ("is a no-op on sandbox handles") | M32 |
|  |  | `sandbox.setRules(db, rulesJson)` deploys rules to the in-process simulator; `setRules(db, null)` clears rules (default-allow) | ✓ | `unit:modular/sandbox-target.test.ts` ("sandbox.setRules(db, null) clears rules") | M33 |
|  |  | `sandbox.setData(db, { '/path': value })` bulk-loads data, bypassing rules | ✓ | `unit:modular/sandbox-target.test.ts` ("sandbox.setData seeds the tree (rule-bypass)") | M34 |
|  |  | `sandbox.snapshotState(db)` dumps the full tree as a plain JSON object | ✓ | `unit:modular/sandbox-target.test.ts` ("sandbox.snapshotState dumps the full tree") | M35 |
|  |  | `query(ref, ...constraints)` + ordering/range constraints | ✓ | `unit:upstream-rtdb-probes.test.ts` ("orderByChild('a/b') + limitToFirst orders by the nested path") + `unit:modular/queries.test.ts` + oracle observations under `packages/conformance/observations/rtdb-modular/`; see M49–M64 for the per-claim breakdown. | M36 |
|  |  | `runTransaction(ref, fn, options?)` resolves to `{ committed: boolean, snapshot: DataSnapshot }` for the happy path — the update fn return value is written, committed is `true`, and `snapshot.val()` reflects the committed value | ✓ | Sandbox aligned: `unit:modular/transaction.test.ts` ("resolves to { committed: boolean, snapshot } with the committed value"); matches oracle observations `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json` + `rtdb-modular-runtransaction-returns-committed-snapshot.json` (against blockingfun, fb-js-sdk 12.13.0) | M37 |
|  |  | Returning `undefined` from the update fn ABORTS the transaction — resolves `{ committed: false, snapshot }`; no write performed, no listener fan-out | ✓ | Sandbox aligned: `unit:modular/transaction.test.ts` ("returning undefined aborts — committed: false, no write" + "aborted transaction does NOT fan out to listeners"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-abort-undefined.json` — known divergence: prod's `result.snapshot.val()` reflects the CLIENT's pre-fetch (often `null` even when the server has a value because the speculative invocation runs before the server snap arrives); the sandbox returns the actual pre-transaction value at the path (more useful in single-client harness). The agreed-upon contract callers should rely on is `committed === false` and unchanged server-side data, NOT the snapshot's `.val()` on the abort path. | M37a |
|  |  | The update fn receives the CURRENT value at the ref's path; for an absent path the argument is `null` (NOT `undefined`) | ✓ | Sandbox aligned: `unit:modular/transaction.test.ts` ("update fn receives null for an absent path" + "update fn receives the existing value for a seeded path"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-current-value-arg.json` (prod observation showed `missingArgs[0].isNull === true`) — note divergence: prod ALSO speculatively calls the fn with `null` for a seeded path before the server-snap arrives, the sandbox skips that speculative call (single invocation with the real current value) | M37b |
|  |  | The update fn arg is a defensive deep clone — mutating it does NOT corrupt the stored tree (matters for code that does `current.count++; return undefined` and expects abort to preserve state) | ✓ | `unit:modular/transaction.test.ts` ("mutating the update-fn arg does NOT corrupt the stored tree") — no separate oracle row (defensive contract; prod behavior is identical because the SDK clones on the wire boundary) | M37c |
|  |  | `options.applyLocally` controls whether the in-flight optimistic value fans out to `onValue` listeners — default `true` (apply locally before commit); `false` suppresses intermediate fires so listeners see only the committed value | ✓ | Sandbox aligned: `unit:modular/transaction.test.ts` ("applyLocally: true (default) — listener sees initial + committed value" + "applyLocally: false — listener sees only the committed value"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-options-applylocally.json` (single-client harness: both branches produce 2 fires (initial + commit) — divergence vs prod's documented multi-client suppression would surface under contention, which the sandbox doesn't model) | M37d |
|  |  | Rules-denied transaction rejects with a plain `Error` whose `message === 'permission_denied'` (lowercase) and NO `.code` field — DIFFERENT from `set`/`get`'s `'PERMISSION_DENIED: Permission denied'` shape with uppercase `.code`. | ✓ | Sandbox aligned: `unit:modular/transaction.test.ts` ("rejects with a plain Error whose message is \"permission_denied\""); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-on-rules-denied-path.json` (against blockingfun: `message: 'permission_denied', code: null, constructorName: 'Error'`). | M37e |
|  |  | Rules-denied transaction does NOT write — pre-transaction value at the path is preserved through the rejection | ✓ | `unit:modular/transaction.test.ts` ("does not write to the path when rules deny") — locked alongside the M37e shape claim | M37f |
|  |  | Committed transaction fans out to `onValue` listeners on the watched path with the new value (default applyLocally behavior) | ✓ | `unit:modular/transaction.test.ts` ("committed write fans out to onValue listeners") | M37g |
|  |  | Concurrent contention / retry-on-conflict — single-client sandbox doesn't model real concurrency; the documented "up to 25 retries" contract is degenerate (the fn is invoked once) | — | matrix #161 documents the same gap on the spec side; oracle observation hard to obtain from a single client (oracle row stays `?`) | M37h |
|  |  | Identity-aware sandbox-live op routing — sign-in/sign-out via `pyric/auth` is observed by the next RTDB op without re-binding | ✓ | `unit:modular/sandbox-target.test.ts` ("reads sandbox.currentUser at op time, not at getDatabase time") | M38 |
|  |  | Backend identity is per-`Sandbox` — two `getDatabase(sandbox)` calls on the same sandbox share data, two on different sandboxes don't | ✓ | implicit via the WeakMap binding; tested transitively by `sandbox.setData` + `get` round-trips in the same test suite | M39 |
|  |  | Sandbox refs carry a stable `key` (last path segment) and `toString()` returning `sandbox://rtdb/<path>` | ✓ | covered by the `ref` / `child` / `parent` tests | M40 |
|  |  | `query(ref, orderByChild(p), startAt(v), endAt(w))` window is BOTH-INCLUSIVE — children whose ordered field === `v` or === `w` are included | ✓ | `unit:upstream-rtdb-probes.test.ts` (deep orderByChild nested path) + `unit:modular/queries.test.ts` ("returns children whose ordered child is within [startAt, endAt] inclusive"); matches oracle `rtdb-modular-orderbychild-window.json` | M49 |
|  |  | `orderByKey()` orders children by RTDB `nameCompare` — integer-looking keys sort numerically FIRST (so `['1','2','10']`, not the lexicographic `['1','10','2']`), then non-integer keys lexicographically; `startAt`/`endAt` cursors + the optional `key` tie-breaker use the same order (DB-B4) | ✓ | `unit:upstream-rtdb-probes.test.ts` (INT32 overflow/underflow cursors) + `unit:modular/queries.test.ts` + `unit:modular/name-compare.test.ts`; matches oracle `rtdb-modular-orderbykey-window.json` and upstream `core/util/util.ts:253-276` | M50 |
|  |  | `orderByValue()` orders primitive children by their value; `limitToFirst(N)` returns the N smallest, ascending | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("returns the limitToFirst(N) smallest values, ascending"). Oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-orderbyvalue-numeric.json` shows prod threw `Index not defined` against blockingfun — the sandbox does NOT enforce `.indexOn` (rules-engine integration for query indexes is deferred); the semantic claim (ordering by value) is locked here. | M51 |
|  |  | `orderByChild(p) + equalTo(v)` returns ALL children whose field at `p` === `v` — no uniqueness enforced | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("returns ALL children whose ordered field === the supplied value"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-equalTo-filter.json` (both 'b'-grouped children returned). | M52 |
|  |  | `equalTo` with no matches returns an empty snapshot (`exists() === false`, `numChildren() === 0`) | ✓ | `unit:modular/queries.test.ts` ("returns an empty snapshot when nothing matches") | M53 |
|  |  | `limitToFirst(N)` keeps the lowest-ranked N children (post-ordering, pre-filter) | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("limitToFirst takes the lowest-ranked window"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` (firstPositions `[1,2]`). | M54 |
|  |  | `limitToLast(N)` keeps the highest-ranked N children | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("limitToLast takes the highest-ranked window"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` (lastPositions `[4,5]`). | M55 |
|  |  | `limitToFirst(N)` larger than the result returns the full window (no padding, no throw) | ✓ | `unit:modular/queries.test.ts` ("limitToFirst(N) larger than the result returns the full window") | M56 |
|  |  | `startAfter(v)` and `endBefore(v)` are EXCLUSIVE — the boundary value is dropped from the result | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("startAfter + endBefore drop the boundary values"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json` (positions `[3,4]`, cursors 2 + 5 dropped). | M57 |
|  |  | `onValue(query, cb)` only fires when the windowed result changes — writes OUTSIDE the window don't re-fire the listener; writes that displace a member DO | ✓ | `unit:upstream-rtdb-probes.test.ts` ("one update nulls, mutates, and displaces within a limitToFirst window") + `unit:modular/queries.test.ts` ("fires only when the windowed result changes"); matches oracle `rtdb-modular-onvalue-with-query.json` | M58 |
|  |  | `onValue(query)` initial fire delivers an empty window (`numChildren() === 0`) when the path is absent | ✓ | `unit:modular/queries.test.ts` ("initial fire on an empty path delivers an empty window") | M59 |
|  |  | `query(query(ref, c1), c2)` composes constraints — chaining folds both into one spec | ✓ | `unit:modular/queries.test.ts` ("query(query(ref, c1), c2) composes constraints") | M60 |
|  |  | Snapshot from a query exposes children via `snap.forEach` in the executor-computed order — NOT necessarily the order `Object.entries(val)` would yield | ✓ | `unit:modular/queries.test.ts` ("forEach visits children in ascending order of the child key") | M61 |
|  |  | `startAt(value, key)` uses `key` as the tie-breaker when multiple children share the same ordered value — children before `key` are dropped, the row at `key` is included (inclusive cursor) | ✓ | `unit:modular/queries.test.ts` ("startAt with key tie-breaker drops earlier same-value children") | M62 |
|  |  | `orderByChild('p')` on children missing the field treats their value as `null` (sorts FIRST per RTDB's type ordering) | ✓ | `unit:modular/queries.test.ts` ("orderByChild on a missing child path treats those children as null") | M63 |
|  |  | `query` on a path holding a primitive (or absent path) returns an empty snapshot — no rows to iterate | ✓ | `unit:modular/queries.test.ts` ("query on a path with primitive value returns no rows") | M64 |
|  |  | Write-boundary normalization (`nodeFromJSON`-equivalent): a value written as an array is stored as an integer-keyed object — `child(ref, '1')` returns the element, `forEach` iterates `0,1,2…` (DB-B2) | ✓ | Sandbox aligned: `unit:modular/normalization.test.ts` ("array write is addressable by integer-string child key" + "forEach over an array iterates its elements"); upstream `core/snap/nodeFromJSON.ts:118-128`, `core/snap/ChildrenNode.ts:194-230` | M65 |
|  |  | Read-side array coercion: a dense integer-keyed object renders back as an array on `snap.val()` (`allIntegerKeys && maxKey < 2 * numKeys`) (DB-B2) | ✓ | Sandbox aligned: `unit:modular/normalization.test.ts` ("a dense integer-keyed object reads back as an array"); upstream `core/snap/ChildrenNode.ts:196-230` | M66 |
|  |  | `null` children and empty objects are pruned at the write boundary — `set(ref, {})` is equivalent to `remove(ref)`; nested `null` collapses empty ancestors ("empty nodes don't exist") (DB-B3) | ✓ | Sandbox aligned: `unit:modular/normalization.test.ts` ("set(ref, {}) is equivalent to remove" + "null children are pruned"); upstream `core/snap/nodeFromJSON.ts:78-88,122-126` | M67 |
|  |  | Write validation: an `undefined` payload, a non-finite number (`NaN`/`±Infinity`), or a key containing a forbidden char (`.`, `#`, `$`, `/`, `[`, `]`, control chars) is rejected with a plain `Error` (DB-B1) | ✓ | Sandbox aligned: `unit:modular/normalization.test.ts` ("rejects an undefined payload" + "rejects an invalid key" + "rejects a non-finite number"); upstream `core/util/validation.ts:45,58,112-199` | M68 |
|  |  | Conflicting query constraints throw synchronously at `query(...)` construction (NOT silent last-win): multiple `orderBy*`, a second `limitToFirst`/`limitToLast`, a second start (`startAt`/`startAfter`/`equalTo`) or end (`endAt`/`endBefore`/`equalTo`) (DB-B5) | ✓ | Sandbox aligned: `unit:modular/constraint-conflicts.test.ts` (5 cases); upstream `api/Reference_impl.ts:160-165,1824-1841,1888-1905,1945-1951,2193-2206` | M69 |
|  |  | `push(ref, value?)` returns a `ThenableReference` (a `DatabaseReference` with `.then`/`.catch`). The key + ref are minted CLIENT-SIDE and available synchronously even when the optional value write is rules-denied; the write is deferred onto the promise, so a denial REJECTS the awaited push rather than throwing synchronously and discarding the key (DB-B7) | ✓ | Sandbox aligned: `unit:modular/push-thenable.test.ts` (4 cases); matches oracle `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json` ("available immediately even when the subsequent server write is denied by rules") + upstream `api/Reference_impl.ts:599-630` | M70 |
|  |  | `DataSnapshot` shape: `size` (getter), `priority` (always `null` — priority deny-listed), `exportVal()`, `key`, `ref`, `val()`, `exists()`, `child()`, `hasChild()`, `hasChildren()`, `forEach()`, `toJSON()`. It does NOT ship the legacy namespaced `numChildren()` method (DB-B10) | ✓ | Sandbox aligned: `unit:modular/snapshot-shape.test.ts` ("exposes size/priority/exportVal; NOT numChildren()"); matches oracle `packages/conformance/observations/rtdb-modular/rtdb-modular-get-snapshot-shape.json` (`hasSize: true, hasNumChildren: false`) + upstream `api/Reference_impl.ts:288-447`. **Flipped masking tests**: `modular/queries.test.ts` + `modular/sandbox-target.test.ts` asserted `snap.numChildren()` — updated to `snap.size`. | M71 |
|  |  | Object-valued children are ORDER-EQUAL — the sort/range tie is broken by key (`nameCompare`), NOT by an invented `JSON.stringify` ordering; a query re-write that only reorders object keys is "no change" and doesn't re-fire (DB-B11) | ✓ | Sandbox aligned: `unit:modular/object-order-equality.test.ts`; upstream `core/snap/ChildrenNode.ts:386-400` | M72 |
|  |  | A primitive at the ROOT is legal (`set(ref(db), 'hello')`); a subsequent child write replaces the primitive root ("writes win") (DB-B13) | ✓ | Sandbox aligned: `unit:modular/root-primitive.test.ts` (2 cases) | M73 |
|  |  | `onValue(ref, cb, { onlyOnce: true })` fires once then auto-unsubscribes (DB-B12) | ✓ | Sandbox aligned: `unit:modular/onvalue-onlyonce.test.ts`; upstream `api/Reference_impl.ts:975-980` | M74 |
|  |  | **Divergence (DB-B12, honest doc):** the onChild* callbacks do NOT receive the `previousChildName` second argument; `onValue`/`onChild*` do NOT accept a `cancelCallback`; `onChildAdded`/`Changed`/`Removed`/`Moved` accept only plain refs (not `Query`); `child_moved` never fires (ordered-query move detection unmodeled). These listener-surface holes are out of scope for the current phase — consumers needing them use `firebase/database` directly. | ⚠ | divergence documented; partial coverage: `{ onlyOnce }` IS implemented (M74). | M75 |
|  |  | `.validate` rules are enforced on modular sandbox writes through `set`, atomic `update`, and `runTransaction`; a descendant validation failure rejects the operation without changing state. | ✓ | `unit:modular/sandbox-target.test.ts` executes all three write paths against a required-child `.validate` rule and proves each rejects without committing state. The shared `SimulateHandler` behavior is production-locked by RTDB rules corpus rows #4 and #15. | M76 |

### Deferred mirror behaviors

- Ordered-query `onChildMoved` is accepted but does not yet fire on reorder.
- `onDisconnect` has no in-process socket lifecycle to model yet.
- Priority ordering is not modeled.

The playground and `pyric dev` map canonical `firebase/database` imports to `pyric/database` before the mirror loads. A bare preview `getDatabase()` call is wrapped to receive the active sandbox. Production bundling leaves `firebase/database` unchanged.

Simulation and structure crawling are sandbox/CLI operations; rules authoring and analysis remain on the internal RTDB rules-engine seam until their later package relocation.

---

### `getDatabase(target)` — initializer

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `getDatabase(ctx)` returns a tagged sandbox-target handle (frozen identity) | — | Phase 3 | 94 |
|  |  | `getDatabase(sandbox)` returns a tagged sandbox-live handle (per-op identity) | — | Phase 3 | 95 |
|  |  | Inactive canonical `firebase/database` imports remain the upstream package; the mirror does not create tagged production targets | ? | package-resolution boundary; inactive RTDB canonical-import isolation is not yet claimed by this row | 96 |
|  |  | `getDatabase()` (no argument) — wrapped in the playground preview to supply the sandbox; a raw mirror call rejects with package-resolution guidance | ✓ (wrap, fixture passing) | Phase 3 Tier 5: virtualized in the playground preview scope. Wired at `packages/playground/src/components/AppPreview.tsx` (slot install with bare-call wrap), `packages/playground/src/lib/preview/virtual-imports-plugin.ts` (alias map), and `packages/playground/src/lib/preview/preview-scope.ts` (type-level slot). Mirrors the `getAuth` / `getFirestore` wrap pattern. Demo fixture: `packages/playground/scripts/fixtures/rtdb-set-get-roundtrip.tsx` (bare `getDatabase()` + `set`/`get`/`remove` round-trip with anonymous sign-in) passes end-to-end through the `bun run debug:fixtures` Playwright suite. | 97 |
|  |  | Two `getDatabase(sandbox)` calls share state (same underlying `LocalEnvironment`) | — | Phase 3 | 98 |
|  |  | Handle dispatch by `TARGET_SYMBOL` brand — refs route to their owning target via a `refToTarget` WeakMap (mirror of firestore's pattern) | — | Phase 3 | 99 |

### `ref(db, path)` / `child` / `parent` / `root`

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `ref(db, path)` returns a tagged `DatabaseReference` carrying `key`, `parent`, `root`, `toString()` | ? | upstream `firebase/database` contract | 100 |
|  |  | `ref(db)` with no path returns the root ref (`key === null`, `parent === null`) | ? | upstream contract | 101 |
|  |  | `child(ref, 'a/b')` joins a relative path, including embedded slashes | ? | upstream contract | 102 |
|  |  | `ref.parent` is `null` at root, otherwise the parent ref | ? | upstream contract | 103 |
|  |  | `ref.key` is the final path segment, `null` for root | ? | upstream contract | 104 |
|  |  | Unknown ref (not produced by this package) → `TypeError` in shim ops | — | Phase 3 | 105 |

### `get(ref)` — single read

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | Returns a `DataSnapshot` carrying `.val()`, `.exists()`, `.key`, `.ref`, `.size` (getter, returns child count), `.hasChildren()`, `.hasChild(path)`, `.forEach(cb)`. The legacy namespaced-SDK method `.numChildren()` is **NOT** on the modular DataSnapshot — use `.size` instead. Observed: `hasNumChildren: false`, `size: 3` for a `{a,b,c}` object, `forEachKeys: ['a','b','c']` against blockingfun, fb-js-sdk 12.13.0. | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-get-snapshot-shape.json` | 106 |
|  |  | `snap.val()` returns `null` for a missing path (NOT a thrown error — RTDB diverges from Firestore here; `getDoc` returns `exists()===false` but `get` on RTDB just returns a `null`-val snapshot) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-get-missing-path.json` — observed `threw: false, val: null, exists: false` on a never-written path against blockingfun. | 107 |
|  |  | `snap.exists()` is `false` when `val() === null`, `true` otherwise | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-get-missing-path.json` — observed `exists: false` for `val: null`. | 108 |
|  |  | Round-trip: `set(ref, payload)` then `get(ref)` returns the payload (lock the basic write→read invariant) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-set-then-get-roundtrip.json` — the payload round-trips structurally on both sides (this row's claim holds). NOTE — adjacent divergence pinned in `oracle-conformance.test.ts`: prod returns object children in LEXICOGRAPHIC key order (the capture's `roundTripEqual: false` — a `JSON.stringify` round-trip against a non-sorted payload fails), while the sandbox preserves insertion order (stringify round-trip succeeds). Key-order-sensitive consumers behave differently. | 109 |
|  |  | Rules-denied read throws a plain `Error` (NOT a `FirebaseError`) with `code: 'PERMISSION_DENIED'` (uppercase snake-case) — matches the agent-tool rows #15/#20 | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` | 110 |

### `set(ref, value)` — full write

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | Replaces the value at the path entirely; resolves to `undefined` (unlike `setDoc` which resolves to `void`, RTDB's `set` is documented as `Promise<void>`) | ? | upstream contract | 111 |
|  |  | `set(ref, null)` removes the path entirely — equivalent to `remove(ref)`, subsequent `get` returns `null`-val snapshot | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-set-null-equals-remove.json` — observed `beforeExists: true → afterExists: false, afterVal: null` after `set(ref, null)`. | 112 |
|  |  | Nested objects overwrite — `set(ref, {a: 1})` after `set(ref, {a: 1, b: 2})` leaves `{a: 1}` only, NOT a merge (RTDB `set` is replacement, not merge) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-set-replaces-not-merges.json` — observed `final: {a: 1}` with `b` absent after the second set. | 113 |
|  |  | Primitive round-trip — numbers, strings, booleans, arrays all survive a set→get cycle | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-set-then-get-roundtrip.json` — the payload round-trips structurally on both sides (this row's claim holds). NOTE — adjacent divergence pinned in `oracle-conformance.test.ts`: prod returns object children in LEXICOGRAPHIC key order (the capture's `roundTripEqual: false` — a `JSON.stringify` round-trip against a non-sorted payload fails), while the sandbox preserves insertion order (stringify round-trip succeeds). Key-order-sensitive consumers behave differently. | 114 |
|  |  | Rules-denied write throws plain `Error` with `code: 'PERMISSION_DENIED'` (same shape as #110) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` | 115 |

### `update(ref, values)` — partial / multi-path update

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `update(ref, {a: 1, b: 2})` merges top-level keys at the ref; unspecified keys preserved (in contrast to `set`'s replacement) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-merges-keys.json` — after `set({a:1,b:2})` then `update({a:10})`, observed `final: {a:10, b:2}`. | 116 |
|  |  | Multi-path update — `update(parentRef, { 'a/x': 1, 'b/y': 2 })` lands BOTH writes atomically at distinct subtrees (RTDB's most distinctive feature; this is the "fan-out" pattern) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-multipath-atomic.json` — observed `aX: 1, bY: 2` both readable after a single update call. | 117 |
|  |  | Multi-path update is atomic: if any path is denied by rules, the entire update rejects and no path is written | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-multipath-rules-denial.json` — observed `threw: true, code: 'PERMISSION_DENIED'` AND `okPathWrittenDespiteDenial: false` (the otherwise-permitted path also rolled back). | 118 |
|  |  | Setting a key to `null` inside `update` removes that key — same equivalence as `set(ref, null)` | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-null-removes-key.json` — after `set({a:1,b:2})` then `update({a:null})`, observed `final: {b:2}` with `a` absent. | 119 |
|  |  | Update path validation — overlapping paths (e.g. `'/a'` and `'/a/x'` in the same call) throws synchronously before any write | ? | upstream contract — needs targeted probe | 120 |

### `remove(ref)` — delete

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | Removes the value AND all children; subsequent `get` returns `null`-val snapshot | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` | 121 |
|  |  | Idempotent — `remove` on a path that's already absent resolves successfully (no-throw) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-remove-idempotent.json` — `remove` on a never-written path observed `threw: false, afterExists: false`. | 122 |
|  |  | `remove(ref)` and `set(ref, null)` produce the same end state — locks the documented RTDB invariant | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` | 123 |

### `push(ref, value?)` — auto-id append

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `push(ref).key` is a 20-char string starting with `-`, available **synchronously** (client-side mint, no server round-trip required) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json` | 124 |
|  |  | Sequential `push` calls produce monotonically-sortable keys (timestamp-prefixed for chronological ordering via `orderByKey`) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json` | 125 |
|  |  | `push(ref, value)` writes the value AND returns the new child ref (both behaviors in one call); `push(ref)` mints the ref without writing | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-push-with-value.json` — `await push(parent, {hello:'world'})` returned a ref with a 20-char key; subsequent `get(r)` returned `{hello:'world'}`. | 126 |
|  |  | The returned ref `r = push(parent, value)` is usable in follow-up ops: `get(r)`, `set(r, …)`, `remove(r)` | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-push-with-value.json` — observed all 4 follow-up ops succeed through the returned ref (`refIsUsableForFollowupOps: true`). | 127 |

### `onValue(ref, cb)` — value-level listener

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | Subscribing to a path with **existing data** fires the listener once with the current snapshot (the "initial fire") | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-initial-with-data.json` — observed exactly 1 initial fire within ~46ms of subscribe, snapshot.val() === the seeded payload. | 128 |
|  |  | Subscribing to a **nonexistent path** still fires the listener once — with a `null`-val snapshot AND `exists() === false`. Matches Firestore's `onSnapshot`-on-missing-doc semantics: prod RTDB does NOT silently skip the initial fire for empty paths. | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-initial-no-data.json` — observed 1 initial fire on a never-written path with `firstFire.val: null, firstFire.exists: false` (~55ms after subscribe). | 129 |
|  |  | Subsequent `set(ref, …)` fires the listener with the new value | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-onvalue-fires-on-set.json` — observed 1 fire per `set()` (1+1+1 = 3 total: initial-null, after-first-set, after-second-set). | 130 |
|  |  | Unsubscribe — the returned unsubscribe function stops further fires; subsequent writes produce 0 additional fires after `unsub()` | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-unsubscribe.json` — observed `preUnsubFires: 2, postUnsubFires: 2` (a write performed after `unsub()` produced 0 additional fires within a 500ms settle window). | 131 |
|  |  | The returned value from `onValue(ref, cb)` is the unsubscribe function (NOT an object); calling it removes the listener | ? | upstream contract — locked indirectly by #131 | 132 |

### `onChildAdded` / `onChildChanged` / `onChildRemoved` / `onChildMoved`

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `onChildAdded` replays the existing children on subscribe — one fire per existing child key, in `orderByKey` order by default (unlike `onValue` which fires once with the parent snapshot) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-initial-replay.json` — seeded `{k1, k2, k3}`, observed 3 initial fires with `firedKeys: ['k1', 'k2', 'k3']` in insertion order against blockingfun. | 133 |
|  |  | After subscribe, adding a child via `push` or `set(child, …)` fires `onChildAdded` exactly once for that key | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-post-subscribe.json` — seeded `{k1,k2}`, observed `postSubscribeFires: 1, lastFire: {key:'k3', val:{v:3}}` after writing the new child. | 134 |
|  |  | `onChildChanged` fires when an existing child's value changes; does NOT fire for added or removed children | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildchanged-fires-on-update.json` — observed `firedOnInitial: 0, firedOnUpdate: 1, lastFire: {key:'k1', val:{v:2}}` (the NEW value, not the prior). | 135 |
|  |  | `onChildRemoved` fires when a child is deleted (via `remove(child)` or `set(child, null)`); snapshot carries the PRIOR value | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildremoved-fires-on-delete.json` — observed `firedOnDelete: 1, removedSnapCarriesPriorValue: true` (snapshot.val() was the pre-delete value). | 136 |
|  |  | `onChildMoved` under an ordered query. Prod: fires when a child's `orderByChild`/`orderByValue` priority changes — emitted only on ordered queries. Sandbox: **never fires on reorder** — `onChildMoved` supports the plain-ref (no-fire) case only; the ordered-query overload is unimplemented | ⚠ | divergence, oracle-locked by `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildmoved-with-orderby.json`: prod observed `firedOnMove: 1` under `query(ref, orderByChild('priority'))` after bumping a child's priority to a new sort position; the sandbox fires 0 on reorder. Partial alignment landed: all `onChild*` now ACCEPT a `Query` (previously threw a misleading `unrecognized reference` TypeError) with window-aware `child_added`/`child_changed`/`child_removed` diffs (`src/database/sandbox/backend.ts`); the two hold-lifting captures now exist: `rtdb-modular-onchildmoved-previouschildname-sequencing` pins prev-name sequencing (end/middle/front reorders yield prev k3/k2/null, no initial replay) and `rtdb-modular-childchanged-cofire-with-childmoved` pins co-fire semantics (a reorder fires BOTH `child_changed` and `child_moved`; a non-ordered-field change fires neither moved; prod fires `child_moved` on an ordered-field value change EVEN WHEN RANK IS UNCHANGED). Implementation of ordered `child_moved` is unblocked. Both sides pinned in `modular/oracle-conformance.test.ts` and `modular/sandbox-child-events.test.ts`. Sandbox Tier 2 locks the plain-ref no-fire case (M46). | 137 |

### `off(ref, eventType?, callback?)` — unsubscribe variants

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `off(ref)` removes ALL listeners at that ref (any event type, any callback) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-off-stops-child-fires.json` — after `off(ref)` with no eventType, a subsequent write produced `postOffFires: 0` against an `onChildAdded` registration. | 138 |
|  |  | `off(ref, 'value')` removes only `value` listeners at that ref | ✓ | Sandbox aligned (M48); oracle: `packages/conformance/observations/rtdb/rtdb-off-eventtype-precision.json` — registered TWO `value` listeners + one `child_added` at the same ref; after `off(ref, 'value')` (no callback), `valueListenersStopped: true` (neither value cb fired on subsequent writes) AND `childListenerStillFiringAfterOffValue: true` (the child listener kept firing). `offValueClearsAllValueListeners: true` confirms the no-callback variant removes ALL value listeners at the ref. | 139 |
|  |  | `off(ref, 'value', cb)` removes only the specific callback | ✓ | Sandbox aligned (M48); adjacent to #141 — the upstream `off` with the cb argument removes only the matching callback. Same probe (`rtdb-onvalue-unsub-equivalence.json` Case 2) confirms `off(ref, 'value', cb)` stops only that callback. | 140 |
|  |  | The returned unsubscribe function from `onValue(ref, cb)` is equivalent to `off(ref, 'value', cb)` | ✓ | Sandbox aligned (M48); oracle: `packages/conformance/observations/rtdb/rtdb-onvalue-unsub-equivalence.json` — `unsubReturnType: 'function'`, `unsubReturnedFnStopsListener: true` (the captured return value halted fires on write), `offRefValueCbStopsListener: true` (the same effect via `off(ref, 'value', cb)`), `bothFormsEquivalent: true`. | 141 |
| off(ref, eventType, callback) |  | When the same callback is registered more than once, each `off(ref, eventType, callback)` removes one registration without orphaning the others | ? | Pyric behavior is locked by `packages/pyric/test/app/multi-app-listener-auth.test.ts`; a production duplicate-registration oracle capture is still needed | 183 |

### `query(ref, ...constraints)` + ordering / bounds / limits

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `query(ref, orderByChild('field'), limitToFirst(N))` returns a `Query` whose `get()` resolves a snapshot containing N children ordered by `field` | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-orderbychild-limit.json` — seeded 4 children with positions `[3,1,4,2]`, observed `orderedKeys: [{key:'a',pos:1}, {key:'b',pos:2}]` (first 2 in ascending order). Requires `.indexOn` declared in rules. | 142 |
|  |  | `orderByKey()` orders by the auto-id / numeric key | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-orderbykey-window.json` — seeded `{a,b,c,d,e}` in shuffled insertion order, observed `matchedKeys: ['b','c','d']` for `orderByKey() + startAt('b') + endAt('d')` (in key order). | 143 |
|  |  | `orderByValue()` orders by the primitive value of each child (for collections of primitives) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-orderbyvalue-numeric.json` — seeded `{alice:30, bob:10, carol:50, dave:20, eve:40}`, the prod call threw `Index not defined, add ".indexOn": ".value"` (so prod enforces an index requirement on `orderByValue()`); semantic ordering claim still holds, sandbox does not enforce indexes. | 144 |
|  |  | `equalTo(v)` filters children whose ordered field === v (returns 0, 1, or multiple matches — RTDB does NOT enforce uniqueness) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-equalto.json` — seeded `{red, blue, blue, green}`, observed `matchedKeys: ['k2', 'k3']` for `equalTo('blue')` (both blue children, none of the others). Additional probe: `packages/conformance/observations/rtdb-modular/rtdb-modular-equalTo-filter.json` (a..b..c groups) confirms `equalTo('b')` returns the two `b` children. | 145 |
|  |  | `startAt(v)` is **inclusive** (the child whose ordered value === v is included) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-startat-inclusive.json` — seeded positions `[1,2,3,4]`, observed `matched: [2,3,4]` for `startAt(2)` (cursor doc included). | 146 |
|  |  | `endAt(v)` is **inclusive** | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-orderbychild-window.json` — `startAt(2) + endAt(4)` matched positions `[2,3,4]` (endAt(4) included its boundary value). | 147 |
|  |  | `startAfter(v)` is **exclusive** | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json` — `startAfter(2) + endBefore(5)` matched positions `[3,4]` (cursor `2` dropped). | 148 |
|  |  | `endBefore(v)` is **exclusive** | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json` — same probe; cursor `5` dropped. | 149 |
|  |  | `limitToFirst(N)` caps the result count from the start of the ordered range | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-orderbychild-limit.json` plus `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` (firstPositions `[1,2]`). | 150 |
|  |  | `limitToLast(N)` caps from the end | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` — observed `lastKeys: ['d','e'], lastPositions: [4,5]` for `limitToLast(2)` on a 5-child collection ordered by `pos`. | 151 |
|  |  | Listeners on a `Query` (`onValue(q, …)`) emit only the windowed snapshot — NOT the parent ref's full data | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-with-query.json` — seeded 3 children, watched first 2 by `pos`; observed 3 fires total: (1) initial `[a,b]`, (2) OUTSIDE-window write to `c/extra` did NOT fire, (3) INSIDE-window mutation of `a` re-fired, (4) new child `z` displaced `b` and re-fired. Outside-window writes are silent. | 152 |

### Sentinels — `serverTimestamp()` / `increment(n)`

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `serverTimestamp()` resolves server-side to a **number** (epoch milliseconds) — diverges from Firestore's `Timestamp` instance | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json` — observed `createdAtType: 'number', createdAt: 1779075391118` (i.e. a plain JS number, NOT a `Timestamp` object). | 153 |
|  |  | `serverTimestamp()` as a field value in `set` or `update` writes the `{".sv": "timestamp"}` sentinel; the read-back value is the resolved number | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json` — read-back showed `createdAtSentinelShape: false` (sentinel resolved server-side; client sees the number, not the `.sv` placeholder). | 154 |
|  |  | `increment(n)` against a **missing** field starts at 0 (so `increment(5)` lands as `5`) | ✓ | Sandbox aligned (modular `increment` export now present): `unit:modular/increment.test.ts` ("increment against a missing field starts from 0"); matches oracle `packages/conformance/observations/rtdb-modular/rtdb-modular-increment-from-missing.json` — observed `afterFirst: 5` from `increment(5)` against an absent `count` field. | 155 |
|  |  | `increment(n)` against an existing numeric field adds atomically; negative deltas subtract | ✓ | Sandbox aligned: `unit:modular/increment.test.ts` ("subsequent increments accumulate (positive then negative)" + "nested inside an update patch resolves per-field"); matches oracle `packages/conformance/observations/rtdb-modular/rtdb-modular-increment-from-missing.json` — observed `afterSecond: 8` (5+3) then `afterNegative: 6` (8-2). | 156 |
|  |  | Two concurrent `increment` calls interleave correctly (last-write-wins is NOT the contract — both deltas accumulate) | ? | hard to observe deterministically from a single client; documented contract | 157 |

### `runTransaction(ref, transactionUpdate, options?)` — optimistic concurrency

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | Basic success — `runTransaction(ref, current => (current ?? 0) + 1)` resolves `{ committed: true, snapshot }` where `snapshot.val()` is the new value | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json` — observed `committed: true, snapVal: 1` after running `current => (current ?? 0) + 1` against an empty ref. | 158 |
|  |  | Returning `undefined` from the update fn **aborts** the transaction — resolves `{ committed: false }`, no write performed (RTDB-specific; distinct from Firestore where the only abort path is throwing) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-abort-undefined.json` — seeded `100` then transaction returned `undefined`; observed `committed: false, snapVal: null, afterValOnServer: 100` (existing value preserved). | 159 |
|  |  | The update fn is called with the CURRENT server value (may be `null` if the ref is empty); the fn's return value is the proposed new value | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json` — observed `seenCurrentValues: [null]` on first invocation against an empty ref (a single call, no speculative re-runs against `undefined`). NOTE — adjacent divergence pinned in `modular/oracle-conformance.test.ts`: for a SEEDED path, prod speculatively invokes the update fn twice (first with `null`, then the real value; `rtdb-modular-runtransaction-current-value-arg.json` `seededArgs.length: 2`) while the sandbox invokes once with the actual value. The argument-semantics claim of this row holds for the effective invocation on both sides. WARNING for update-fn authors: prod may invoke your fn first with `null` even when data exists — the pattern `if (current === null) return;` (abort-on-empty) silently loses writes on prod while working on the sandbox, and side effects inside the fn can run twice on prod. RESOLVED by the warm-client capture `rtdb-modular-runtransaction-warm-client-speculation`: a warm prod client (active listener + prior get) receives a SINGLE invocation with the cached value, exactly matching the sandbox. The cold-cache speculative double-call is an artifact of an empty client cache, which the always-warm in-process sandbox structurally never has; the sandbox behavior IS the warm-client contract. | 160 |
|  |  | Concurrent contention — if another client writes between the read and write, the update fn is retried with the new current value (typically up to 25 retries by default) | ? | hard to observe deterministically from a single client | 161 |
|  |  | Result snapshot's `.val()` reflects the committed value (or the existing value if aborted) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json` — observed `snapVal: 1` matching the committed value. | 162 |

### `goOnline` / `goOffline` — connection control

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `goOffline(db)` — accepted no-op: there is no network connection in the local sandbox to toggle, so nothing is disconnected (we deliberately do NOT simulate a disconnect — pending writes, listeners, and `get()` keep working) | ⚠ no network connection in the local sandbox to toggle | `unit:modular/fruit-aliases.test.ts` | 163 |
|  |  | `goOnline(db)` — accepted no-op: there is no connection to reopen (see `goOffline`) | ⚠ no network connection in the local sandbox to toggle | `unit:modular/fruit-aliases.test.ts` | 164 |

### `connectDatabaseEmulator` — emulator hook

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | No-op on sandbox-target handles (the sandbox IS the local emulator) | — | Phase 3 | 165 |
|  |  | A production target is intentionally absent; production code continues to use `connectDatabaseEmulator` from the unchanged `firebase/database` package | — | Phase 3 | 166 |

### Transport, logging, and URL-reference exports

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
|  |  | `forceLongPolling()` — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (it never opens a real socket). Accepted so init code that calls it compiles + runs | ⚠ transport selection not applicable to the in-process/worker sandbox | `unit:modular/fruit-aliases.test.ts` | 171 |
|  |  | `forceWebSockets()` — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (see `forceLongPolling`) | ⚠ transport selection not applicable to the in-process/worker sandbox | `unit:modular/fruit-aliases.test.ts` | 172 |
|  |  | `enableLogging(logger?, persistent?)` — accepted no-op: the sandbox has no modular-SDK-style logger to wire a level/sink into (it uses host-level `console` logging directly, matching `pyric/firestore`'s `setLogLevel`). Accepted so init code that calls it compiles + runs | ⚠ accepted no-op; no sandbox logger to wire into | `unit:modular/fruit-aliases.test.ts` | 173 |
|  |  | `refFromURL(db, url)` — real alias: parses the path out of the absolute database URL and delegates to `ref(db, path)`, so the returned ref resolves + reads exactly like `ref(db, path)`. Divergence: the sandbox is single-database with no host/namespace, so the URL's HOST is NOT validated against the handle (the real SDK throws if the host doesn't match the db's namespace); only the path is honored | ⚠ path resolves like `ref`; URL host/namespace not validated (single-database sandbox) | `unit:modular/fruit-aliases.test.ts` | 174 |

### Modular SDK surface — deny-list (intentionally NOT shimmed)

> `goOffline` / `goOnline` / `forceLongPolling` / `forceWebSockets` / `enableLogging` (honest no-ops) and `refFromURL` (a real alias to `ref`) were moved OUT of this deny-list and mirrored — see the tables above.

| Name | Reason |
|---|---|
| IndexedDB persistence APIs (the Web SDK's RTDB caches in-memory; there's no `enableIndexedDbPersistence` for RTDB, but if upstream adds one, we deny-list it for sandbox parity with firestore's persistence deny-list) | Persistence is owned by `pyric/sandbox`; the modular SDK's cache APIs would conflict. |
| `.info/connected` reads (`onValue(ref(db, '.info/connected'), …)`) | The sandbox has no real connection state to model; firing `true` constantly or never would be a divergence either way. Phase 3 may model this as always-`true` on the sandbox-target. |
| `onDisconnect(ref).set(...)` / `.update(...)` / `.remove(...)` / `.cancel()` | Disconnect handlers require a real network channel; the sandbox has no equivalent. Considered for Phase 3 with explicit divergence documentation. NOT exported (no build break — nothing in the shim references it). |
| `orderByPriority()` / `setPriority(ref, p)` / `setWithPriority(ref, v, p)` and the whole `.priority` model (DB-B6, DB-GAP) | RTDB's priority model — a per-node `.priority` plus a `PriorityIndex` default ordering — is a cross-cutting data-model concern (every node carries an optional priority; the default child ordering is by priority, not key). Modeling it faithfully touches the tree, the snapshot surface, and every query path; it is not cheap and there is no agent/playground demand. Deny-listed with this note. **Divergence:** the sandbox's default child ordering is `orderByKey` (not priority); `setPriority`/`setWithPriority`/`orderByPriority` are not exported. Consumers needing priority use `firebase/database` directly. |

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

| API | Behavior |
|---|---|
| simulateRtdbRules(compiled, input) | Cross-path `root.child(…).val()` reads return `null` for paths NOT present in `mockData` — divergence from real prod rules where the engine reads the live database |
|  | **Divergence (DB-B12, honest doc):** the onChild* callbacks do NOT receive the `previousChildName` second argument; `onValue`/`onChild*` do NOT accept a `cancelCallback`; `onChildAdded`/`Changed`/`Removed`/`Moved` accept only plain refs (not `Query`); `child_moved` never fires (ordered-query move detection unmodeled). These listener-surface holes are out of scope for the current phase — consumers needing them use `firebase/database` directly. |
|  | `onChildMoved` under an ordered query. Prod: fires when a child's `orderByChild`/`orderByValue` priority changes — emitted only on ordered queries. Sandbox: **never fires on reorder** — `onChildMoved` supports the plain-ref (no-fire) case only; the ordered-query overload is unimplemented |
|  | `goOffline(db)` — accepted no-op: there is no network connection in the local sandbox to toggle, so nothing is disconnected (we deliberately do NOT simulate a disconnect — pending writes, listeners, and `get()` keep working) |
|  | `goOnline(db)` — accepted no-op: there is no connection to reopen (see `goOffline`) |
|  | `forceLongPolling()` — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (it never opens a real socket). Accepted so init code that calls it compiles + runs |
|  | `forceWebSockets()` — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (see `forceLongPolling`) |
|  | `enableLogging(logger?, persistent?)` — accepted no-op: the sandbox has no modular-SDK-style logger to wire a level/sink into (it uses host-level `console` logging directly, matching `pyric/firestore`'s `setLogLevel`). Accepted so init code that calls it compiles + runs |
|  | `refFromURL(db, url)` — real alias: parses the path out of the absolute database URL and delegates to `ref(db, path)`, so the returned ref resolves + reads exactly like `ref(db, path)`. Divergence: the sandbox is single-database with no host/namespace, so the URL's HOST is NOT validated against the handle (the real SDK throws if the host doesn't match the db's namespace); only the path is honored |

### Unsupported

Tracked behavior that is not implemented in the current contract.

| API | Behavior |
|---|---|
| Removed REST host | Historical `.json` REST transport contract for the removed production host. |
| Removed data handler | Historical admin read and set/get behavior for the removed production data handler. |
| Removed data handler | Historical user read return shape for the removed production data handler. |
| Removed data handler | Historical rules-denial normalization for the removed production data handler. |
| Removed data handler | Historical rules-denied read behavior for the removed production data handler. |
| Removed data handler | Historical set/get round trip for the removed production data handler. |
| Removed data handler | Historical set-null removal behavior for the removed production data handler. |
| Removed data handler | Historical rules-denied write behavior for the removed production data handler. |
| Removed data handler | Historical multi-path update behavior for the removed production data handler. |
| Removed data handler | Historical push key behavior for the removed production data handler. |
| Removed data handler | Historical push auto-ID format for the removed production data handler. |
| Removed data handler | Historical remove-versus-set-null behavior for the removed production data handler. |
| Removed data handler | Historical idempotent removal behavior for the removed production data handler. |
| Removed rules fetch handler | Historical deployed-rules JSON round trip for the removed production fetch handler. |
| Removed rules deployment handler | Historical rules deployment propagation timing for the removed production deploy handler. |
| Removed REST crawler | Historical shallow REST response shape for the removed production crawler. |
| simulateRtdbRules(compiled, input) | The removed stateful simulator returned a generate-before-simulate error when no IR had been generated |
|  | An in-module production target is intentionally absent; direct calls with a real `FirebaseApp` reject with package-resolution guidance |
|  | Concurrent contention / retry-on-conflict — single-client sandbox doesn't model real concurrency; the documented "up to 25 retries" contract is degenerate (the fn is invoked once) |
|  | `getDatabase(ctx)` returns a tagged sandbox-target handle (frozen identity) |
|  | `getDatabase(sandbox)` returns a tagged sandbox-live handle (per-op identity) |
|  | Two `getDatabase(sandbox)` calls share state (same underlying `LocalEnvironment`) |
|  | Handle dispatch by `TARGET_SYMBOL` brand — refs route to their owning target via a `refToTarget` WeakMap (mirror of firestore's pattern) |
|  | Unknown ref (not produced by this package) → `TypeError` in shim ops |
|  | No-op on sandbox-target handles (the sandbox IS the local emulator) |
|  | A production target is intentionally absent; production code continues to use `connectDatabaseEmulator` from the unchanged `firebase/database` package |

### Unverified

Tracked behavior whose available evidence does not yet establish the production result.

| API | Behavior |
|---|---|
|  | Inactive canonical `firebase/database` imports remain the upstream package; the mirror does not create tagged production targets |
|  | `ref(db, path)` returns a tagged `DatabaseReference` carrying `key`, `parent`, `root`, `toString()` |
|  | `ref(db)` with no path returns the root ref (`key === null`, `parent === null`) |
|  | `child(ref, 'a/b')` joins a relative path, including embedded slashes |
|  | `ref.parent` is `null` at root, otherwise the parent ref |
|  | `ref.key` is the final path segment, `null` for root |
|  | Replaces the value at the path entirely; resolves to `undefined` (unlike `setDoc` which resolves to `void`, RTDB's `set` is documented as `Promise<void>`) |
|  | Update path validation — overlapping paths (e.g. `'/a'` and `'/a/x'` in the same call) throws synchronously before any write |
|  | The returned value from `onValue(ref, cb)` is the unsubscribe function (NOT an object); calling it removes the listener |
| off(ref, eventType, callback) | When the same callback is registered more than once, each `off(ref, eventType, callback)` removes one registration without orphaning the others |
|  | Two concurrent `increment` calls interleave correctly (last-write-wins is NOT the contract — both deltas accumulate) |
|  | Concurrent contention — if another client writes between the read and write, the update fn is retried with the new current value (typically up to 25 retries by default) |
