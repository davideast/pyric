<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/rules` compatibility matrix

Rules is a NATIVE conformance surface: there is no `firebase/rules` module to
mirror, so this contract is NOT measured against an upstream SDK. It is measured
two ways. The claimable API is the public export set of `pyric/rules` (and the
Storage rules exports on `pyric/storage`); the fidelity is the in-process rules
simulators replayed verdict-for-verdict against the production Firestore and
Storage **Rules Test API** engines. There is no export-breadth percentage here
(no upstream denominator); completeness is measured against the surface's own
public API.

The two engines share this one document because `pyric/rules` is one package
front door: its engine-agnostic exports (`lint`, `eachCase`, `assertCase`,
`explainCase`, the value helpers) cannot be partitioned across per-engine
registries. Firestore rules and Storage rules each carry their own engine table
below, partitioned by observation prefix (`rules-firestore-` / `rules-storage-`).

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — the simulator matches the production Rules Test API verdict, locked by a replayed observation |
| ⚠ | **Diverged (documented)** — a known simulator divergence from production with a written reason |
| ✗ | **Bug** — should match production but doesn't; a failing replay pins it |
| — | **Unsupported** — not modeled yet (deliberately or pending) |
| ? | **Unverified** — a claim we haven't yet observed against the production engine |

Oracle references: `oracle:rules-firestore-<pack>` / `oracle:rules-storage-<pack>` cite
an observation captured by `packages/conformance/src/run-rules.ts` /
`run-rules-storage.ts` against the production Rules Test API and replayed by the
rules oracle-conformance suites. The corpus lives at
`packages/conformance/rules-corpus/{firestore,storage}/`.

---

## Firestore rules engine — production simulator conformance (rules-firestore corpus)

| # | Behavior | Status | Probe |
|---|---|---|---|
| 160 | CEL builtins `math.*`/`timestamp.*`/`duration.*` (FM3) — arithmetic, date, and duration comparisons in rules | ✓ | `oracle:rules-firestore-builtins-time-and-math` — production Firestore Rules Test API verdicts for corpus pack "builtins-time-and-math", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. |
| 161 | `Bytes`, `String.toUtf8()`, and `hashing.{md5,sha256,crc32,crc32c}()` (Item 5.3) in rules | ⚠ | `oracle:rules-firestore-bytes-toutf8-and-hashing` — production Firestore Rules Test API verdicts for corpus pack "bytes-toutf8-and-hashing", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`. simulator's toUtf8/md5/sha256/crc32/crc32c byte-encoding and reference-hash implementations diverge from production on all 5 pack cases, so a rule that should DENY on hash mismatch ALLOWs locally — pinned KNOWN_DIVERGENCE |
| 162 | Typed cross-type operator overloads for `Timestamp`/`Duration` (Item 2) in rules — no silent numeric coercion / type-identity loss | ✓ | `oracle:rules-firestore-cross-type-operator-overloads` — production Firestore Rules Test API verdicts for corpus pack "cross-type-operator-overloads", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. |
| 163 | CEL tri-state error absorption in `\|\|`/`&&` (RULES-B3) — `error \|\| true` → ALLOW, `error && false` → DENY, commutative absorption (not JS left-to-right short-circuit) | ✓ | `oracle:rules-firestore-error-absorption-and-or` — production Firestore Rules Test API verdicts for corpus pack "error-absorption-and-or", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. |
| 164 | `getAfter()`/`existsAfter()` (Item 7) in rules — post-write document identity and existence semantics | ⚠ | `oracle:rules-firestore-get-after-and-exists-after` — production Firestore Rules Test API verdicts for corpus pack "get-after-and-exists-after", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`. simulator does not model the post-write document identity/existence production compares against on 4 pack cases (getAfter target identity, existsAfter on create/delete, existsAfter over an unrelated mocked path) — pinned KNOWN_DIVERGENCE |
| 165 | `get()` of a missing document (RULES-B8) in rules — resource identity (`id`/`__name__`) exposure on a mocked/missing get() result | ⚠ | `oracle:rules-firestore-get-missing-doc` — production Firestore Rules Test API verdicts for corpus pack "get-missing-doc", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`. simulator synthesizes a resource identity (`id`, `__name__`) for mocked get() results that production leaves absent, on 2 pack cases — pinned KNOWN_DIVERGENCE |
| 166 | `request.path`/`request.query`/`resource.id`/`resource.__name__` globals (Item 6) in rules | ⚠ | `oracle:rules-firestore-globals-request-path-and-resource-id` — production Firestore Rules Test API verdicts for corpus pack "globals-request-path-and-resource-id", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`. simulator models `request.query` as an empty map on the empty-query case where production denies the equivalent comparison — pinned KNOWN_DIVERGENCE |
| 167 | `int`/`float` division and type distinction (RULES-B5) in rules — truncating int÷int, float division stays float, div-by-zero denies, `is int`/`is float` distinct | ⚠ | `oracle:rules-firestore-int-float-and-division` — production Firestore Rules Test API verdicts for corpus pack "int-float-and-division", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`. simulator narrows a float-valued payload field toward int on the float-payload case, unlike production which preserves the float type — pinned KNOWN_DIVERGENCE |
| 168 | `List.concat()`/`removeAll()`/`toSet()` (Item 5.2) in rules | ✓ | `oracle:rules-firestore-list-methods-concat-removeall-toset` — production Firestore Rules Test API verdicts for corpus pack "list-methods-concat-removeall-toset", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. |
| 169 | `Map.get(key, default)`, including list-form nested-path traversal (Item 3), in rules | ✓ | `oracle:rules-firestore-map-get-string-and-list-form` — production Firestore Rules Test API verdicts for corpus pack "map-get-string-and-list-form", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. |
| 170 | `matches()` as an anchored full-string RE2 match (RULES-B4) in rules — a pattern matching only a substring is `false` | ✓ | `oracle:rules-firestore-matches-full-string-regex` — production Firestore Rules Test API verdicts for corpus pack "matches-full-string-regex", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. |
| 171 | `Path` wrapper, `path()` constructor, and `Path.bind()` (Item 5.4) in rules | ⚠ | `oracle:rules-firestore-path-constructor-and-bind` — production Firestore Rules Test API verdicts for corpus pack "path-constructor-and-bind", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`. simulator treats `path()` as idempotent on an already-Path argument where production denies — pinned KNOWN_DIVERGENCE |
| 172 | Own-keys-only map membership and constructor-access denial (RULES-B7) in rules — `'toString' in map` is `false`, `.constructor` access errors (no JS prototype-chain leakage) | ✓ | `oracle:rules-firestore-prototype-chain-keys` — production Firestore Rules Test API verdicts for corpus pack "prototype-chain-keys", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. |
| 173 | Range-slice `[i:j]` syntax for `List` and `String` (Item 4) in rules | ⚠ | `oracle:rules-firestore-range-slice-list-and-string` — production Firestore Rules Test API verdicts for corpus pack "range-slice-list-and-string", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`. simulator clamps an out-of-bounds slice end to the collection length on both the list and string OOB-slice cases; production denies — pinned KNOWN_DIVERGENCE |
| 174 | `Set.difference()`/`union()`/`intersection()` (Item 5.1) in rules | ✓ | `oracle:rules-firestore-set-algebra-difference-union-intersection` — production Firestore Rules Test API verdicts for corpus pack "set-algebra-difference-union-intersection", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. |
| 175 | String-literal escape handling feeding `matches()` (Class B) in rules — `\\.` is unescaped before RE2 compilation, not forwarded raw to a JS `RegExp` | ✓ | `oracle:rules-firestore-string-literals-and-regex` — production Firestore Rules Test API verdicts for corpus pack "string-literals-and-regex", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. |
| 176 | Missing-field access as a runtime error (RULES-B2) in rules — `typo == null` denies (missing access is not null); `!(key in map)` is the real absence check | ✓ | `oracle:rules-firestore-undefined-field-access` — production Firestore Rules Test API verdicts for corpus pack "undefined-field-access", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. |
| 177 | Explicit `UNSUPPORTED` reporting for unimplemented built-ins (Item 0.A) in rules — an unimplemented built-in abstains rather than silently DENYing | ✓ | `oracle:rules-firestore-unsupported-feature-witness` — production Firestore Rules Test API verdicts for corpus pack "unsupported-feature-witness", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. |

## Storage rules engine — `parseStorageRules` / `evaluateStorageRules` (rules-storage corpus)

| # | Behavior | Status | Probe |
|---|---|---|---|
| 94 | `parseStorageRules(source)` returns an opaque handle | ✓ | `unit:rules.test.ts` ("parses the canonical session-archive ruleset") |
| 95 | `parseStorageRules` rejects non-`firebase.storage` service headers | ✓ | `unit:rules.test.ts` ("rejects unknown service header") |
| 96 | `evaluateStorageRules` supports granular verbs (`get`/`list`/`create`/`update`/`delete`) alongside `read`/`write` umbrella expansion, comma-separated verb lists, and per-verb default-deny | ✓ | STALE ROW, corrected 2026-07-10: production capture proves the evaluator already supports the full six-verb grant surface (umbrella read→{get,list}, write→{create,update,delete}, single granular grants, comma-separated grants, per-verb deny-by-default), matching production verdict-for-verdict on 12 of the pack's 13 non-existence cases. `oracle:rules-storage-verbs-umbrella-granular` (all `read`/`write`/`get`/comma-verb cases). One related existence-semantics case in the same pack diverges — pinned separately as a KNOWN_DIVERGENCE, not a granular-verb gap. |
| 97 | `parseStorageRules` rejects unterminated string literals with `SyntaxError` | ✓ | `unit:rules.test.ts` ("rejects unterminated strings") |
| 98 | `evaluateStorageRules` matches `match /sessions/{id} { allow read: if request.auth != null; }` for an authed read | ✓ | `unit:rules.test.ts` ("allows authenticated reads of /sessions/{id}") |
| 99 | `evaluateStorageRules` denies anonymous reads when the rule requires `request.auth != null` | ✓ | `unit:rules.test.ts` ("denies anonymous reads") |
| 100 | `evaluateStorageRules` supports `request.resource.size < N` constraints (with arithmetic literals like `10 * 1024 * 1024`) | ✓ | `unit:rules.test.ts` ("allows JSON writes under 10MB") |
| 101 | `evaluateStorageRules` supports `request.resource.contentType == '<mime>'` constraints | ✓ | `unit:rules.test.ts` (mime constraint inside the session-archive ruleset) |
| 102 | Multi-segment wildcard `{allPaths=**}` matches zero-or-more remaining segments | ✓ | `unit:rules.test.ts` (parser + evaluator both honor the `**` form) |
| 103 | Path-parameter binding (`{sessionId}`) accessible inside the `if` expression | ✓ | `unit:rules.test.ts` |
| 104 | User-defined `function` definitions — `let` bindings, functions calling functions, and match-block-scoped helper functions (lexical scoping) | ✓ | STALE ROW, corrected 2026-07-10: production capture proves the evaluator supports user-defined functions with `let` bindings, nested function calls, and block-scoped helpers. `oracle:rules-storage-functions-let-scope` matches production verdict-for-verdict on all 5 cases. Same-name shadowing and undefined-function calls are compile-time rejections in production and are covered by evaluator unit tests instead (they cannot be captured as a clean production verdict). |
| 112 | `request.time` compared against `timestamp.date(y,m,d)` and `timestamp.value(ms)` constructors | ✓ | NEW ROW, 2026-07-10: production capture proves the evaluator supports `request.time` comparisons against both timestamp constructors. `oracle:rules-storage-request-time-timestamp` matches production verdict-for-verdict on all 4 cases (deadline-before/after via `timestamp.date()`, epoch-bound before/after via `timestamp.value()`). |
| 113 | `string.matches(regex)` with whole-string anchoring (a partial match denies) | ✓ | NEW ROW, 2026-07-10: production capture proves `matches()` is whole-string anchored, matching a RE2 pattern only when it covers the entire string. `oracle:rules-storage-matches-regex` matches production verdict-for-verdict on all 3 cases. RE2-inexpressible patterns are rejected at ruleset compile time by production and are covered by evaluator unit tests instead. |
| 114 | `resource.metadata.<key>` custom-metadata access in dotted (`resource.metadata.owner`) and bracket (`resource.metadata['owner']`) form, including missing-key deny | ✓ | NEW ROW, 2026-07-10: production capture proves dotted and bracket metadata access resolve identically, and a missing key denies. `oracle:rules-storage-metadata-access` matches production verdict-for-verdict on all 5 cases. |
| 115 | Cross-service `firestore.get()` / `firestore.exists()` lookups from a Storage ruleset, with `$(expr)` path interpolation and qualified function-mock names | ✓ | NEW ROW, 2026-07-10: production capture proves the evaluator resolves cross-service Firestore lookups from Storage rules, including interpolated document paths and both the map-returning `get()` and bool-returning `exists()` forms. `oracle:rules-storage-firestore-lookup` matches production verdict-for-verdict on all 4 cases. |
| 116 | `resource.timeCreated` / `resource.updated` — server-populated object timestamps | ⚠ | NEW ROW, 2026-07-10: witness capture confirms the evaluator's resource model carries only size/contentType/metadata, so `resource.timeCreated`/`resource.updated` read `undefined` and any comparison denies in-process, while production evaluates a real server timestamp. `oracle:rules-storage-resource-timestamp-witness` records production's DENY verdict on both cases; the evaluator's DENY happens to match here because both operands are non-comparable rather than because the field is modeled — the underlying field is still unsupported. |
