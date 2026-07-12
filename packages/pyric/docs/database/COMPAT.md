<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `@pyric/rtdb` compatibility matrix

**224 of 258 tracked behaviors match production Firebase (87%).**

## Status legend

| Status | Meaning |
|---|---|
| ✓ | Matches Firebase |
| ⚠ | Documented difference |
| — | Not supported yet |
| ? | Not verified yet |

## `RtdbHost` contract + `fetchDatabase`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 1 | `fetchDatabase(host, path)` (no userToken) calls the URL `<databaseUrl><path>?access_token=<adminToken>` | ✓ | `unit:host.test.ts` |
| 2 | `fetchDatabase(host, path, params, userToken)` uses `auth=<userToken>` (NOT `access_token`) and does NOT call `resolveAdminToken()` | ✓ | `unit:host.test.ts` |
| 3 | Extra `params` are merged into the URL query string alongside the auth param | ✓ | `unit:host.test.ts` |
| 4 | `host.databaseUrl` is concatenated as a prefix to the path | ✓ | `unit:host.test.ts` |
| 5 | REST endpoints respond on `<databaseUrl><path>.json` — `.json` suffix is the RTDB REST contract | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-rest-json-suffix-contract.json` — `<path>.json` returned `application/json; charset=utf-8` and round-tripped the seeded payload; the same URL WITHOUT the `.json` suffix returned `text/html; charset=utf-8` (the Google sign-in redirector page). Locks the `.json`-suffix contract every handler that calls `fetchDatabase` depends on. |

## `getRtdbTools(host)` — programmatic surface

| # | Behavior | Status | Probe |
|---|---|---|---|
| 6 | Returns an object with the 11 methods listed in the `RtdbTools` interface (`generateIR`, `simulate`, `writeRules`, `crawlStructure`, `readData`, `setData`, `updateData`, `pushData`, `removeData`, `validatedWrite`) | ✓ | `unit:resolver.test.ts` |
| 7 | `simulate()` returns `IR_NOT_GENERATED` until `generateIR()` has been called and cached the IR | ✓ | `unit:simulation/handler.test.ts` |
| 8 | After a successful `generateIR()`, the resolver caches the IR for subsequent `simulate()` calls | ✓ | `unit:resolver.test.ts` |
| 9 | `crawlStructure({ auth })` resolves the user token via `host.resolveUserToken` before crawling; a token-resolution failure surfaces as `PERMISSION_DENIED` | ✓ | `unit:resolver.test.ts` |

## `rtdb_get` / `readData(path)` — single-path read

| # | Behavior | Status | Probe |
|---|---|---|---|
| 10 | Admin mode returns `{ success: true, data: <value or null> }`; uses `firebase-admin/database` `ref(path).get().val()` | ✓ | `unit:data/handler.test.ts`; oracle: `packages/conformance/observations/rtdb/rtdb-handler-admin-vs-user-returnshape.json` — admin-SDK `ref(path).get().val()` returned the exact seeded payload, wrapped as `{ success: true, data: <value> }`. |
| 11 | User mode returns `{ success: true, data: <value or null> }`; uses `firebase/database` modular `get(ref(db, path)).val()` via `host.getClientForUser(auth)` | ✓ | `unit:data/handler.test.ts`; oracle: `packages/conformance/observations/rtdb/rtdb-handler-admin-vs-user-returnshape.json` — `shapesAgree: true` between admin and modular paths against blockingfun (same `data` value, same `success: true` shape). |
| 12 | `null` at the path (empty / missing) round-trips as `data: null` (NOT a not-found error) — matches `DataSnapshot.val()` returning `null` for absent paths | ✓ | `unit:data/handler.test.ts` ("admin GET returns null for empty path") |
| 13 | Any thrown error in admin mode is wrapped as `{ success: false, error: { code: 'READ_FAILED', recoverable: false } }` | ✓ | `unit:data/handler.test.ts` |
| 14 | Rules-denied user-mode `get`/`set`/`update`/`push`/`remove` surface as `{ success: false, error: { code: 'PERMISSION_DENIED', recoverable: false } }` — the handler inspects the caught error before the generic `READ_FAILED` / `WRITE_FAILED` wrap and preserves the `PERMISSION_DENIED` signal. The inspection matches both `(err.code === 'PERMISSION_DENIED')` and `(err.message.toLowerCase().includes('permission_denied'))` so it covers the uppercase `set/get/remove` shape AND the lowercase `runTransaction` shape from oracle row #15 / M37e. Non-rules errors (network, token mint, etc.) still surface as `READ_FAILED` / `WRITE_FAILED`. | ✓ | `unit:data/handler.test.ts` ("rules-denied GET/SET/REMOVE surfaces as PERMISSION_DENIED", "non-rules error for GET/SET still surfaces as READ_FAILED/WRITE_FAILED", "transaction-shaped rules-denied (lowercase message, no .code) surfaces as PERMISSION_DENIED"); oracles cited: `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` + `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-on-rules-denied-path.json` |
| 15 | Rules-denied read against the real RTDB throws on the modular SDK side with `code: 'PERMISSION_DENIED'` and message `PERMISSION_DENIED: Permission denied`. The thrown value is a **plain `Error`** (not a `FirebaseError`) — `.name === 'Error'`, `.constructor.name === 'Error'` — diverging from Firestore/Auth which throw `FirebaseError`. | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` (`code: 'PERMISSION_DENIED'`, `errorName: 'Error'`, `constructorName: 'Error'`, `isErrorInstance: true` against blockingfun, fb-js-sdk 12.13.0; observed on the `set` path — the `get`/`set` paths share the same error-emit code in firebase/database) |

## `rtdb_set` / `setData(path, data)` — full overwrite

| # | Behavior | Status | Probe |
|---|---|---|---|
| 16 | Admin mode replaces the value at the path entirely; resolves `{ success: true, data: null }` | ✓ | `unit:data/handler.test.ts` |
| 17 | User mode replaces via the modular SDK's `set(ref, data)` | ✓ | `unit:data/handler.test.ts` |
| 18 | Setting `null` at a path is equivalent to removing it (matches RTDB's documented behavior) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` — observed `afterRemove: null === afterSetNull: null` against blockingfun, fb-js-sdk 12.13.0; sandbox-aligned: `unit:modular/sandbox-target.test.ts` ("remove and set(null) produce identical end-state") |
| 19 | Errors on either path wrap as `{ success: false, error: { code: 'WRITE_FAILED', recoverable: false } }` | ✓ | `unit:data/handler.test.ts` |
| 20 | Rules-denied write against the real RTDB throws with `code: 'PERMISSION_DENIED'` (uppercase, snake-case — distinct from Firestore's lowercase-kebab `'permission-denied'`) and message `PERMISSION_DENIED: Permission denied`. The thrown value is a **plain `Error`**, not a `FirebaseError`. | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` (against blockingfun, fb-js-sdk 12.13.0) |

## `rtdb_update` / `updateData(path, data)` — partial / multi-location update

| # | Behavior | Status | Probe |
|---|---|---|---|
| 21 | Admin mode merges top-level keys at the path; resolves `{ success: true, data: null }` | ✓ | `unit:data/handler.test.ts` |
| 22 | User mode merges via the modular SDK's `update(ref, data)` | ✓ | `unit:data/handler.test.ts` |
| 23 | When `path === '/'` and `data` keys are root-relative paths (e.g. `{ '/users/alice/name': 'A', '/posts/p1/author': 'alice' }`), the underlying SDK performs an atomic fan-out write at every listed path | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-multipath-atomic.json` — `update(parentRef, { 'a/x': 1, 'b/y': 2 })` landed both writes; see also `rtdb-modular-update-multipath-rules-denial.json` for the atomic rollback when one path is denied. Sandbox-aligned: `unit:modular/sandbox-target.test.ts` ("writes every listed path atomically" + "rejects the entire update if rules deny any one path") |
| 24 | Update operations are validated for syntax (overlapping paths, invalid characters) by the underlying SDK; surface as `WRITE_FAILED` | ✓ | Sandbox aligned: locked by unit test `packages/pyric/test/database/modular/sandbox-target.test.ts` ("rejects overlapping paths") — descendant-path overlap throws before any path is written |

## `rtdb_push` / `pushData(path, data)` — auto-id append

| # | Behavior | Status | Probe |
|---|---|---|---|
| 25 | Admin mode returns `{ success: true, data: { key: <auto-id> } }` | ✓ | `unit:data/handler.test.ts` |
| 26 | User mode returns `{ success: true, data: { key: <auto-id> } }` via `push(ref, data).key` | ✓ | `unit:data/handler.test.ts` |
| 27 | Auto-id format is RTDB's "push ID": 20 characters, starts with `-`, lexicographically sortable, timestamp-prefixed (encodes the millisecond timestamp at the time of generation) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json` (against blockingfun, fb-js-sdk 12.13.0: 3 sequential `push()` calls returned 20-char keys (`-OsshG1AxGukSGUYn_De`, `-OsshG1GZ2pAt7bveAWv`, `-OsshG1NmrNFxZuwufff`), all starting with `-`. The `push.key` is minted client-side from the millisecond timestamp + randomness — it's available immediately even when the subsequent server write is denied by rules.) |
| 28 | Two `push` calls in quick succession produce monotonically sortable keys (the timestamp prefix guarantees order) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json` (`monotonicallySorted: true` across 3 keys generated ~5ms apart) |

## `rtdb_delete` / `removeData(path)` — delete

| # | Behavior | Status | Probe |
|---|---|---|---|
| 29 | Admin mode removes the value and all children; resolves `{ success: true, data: null }` | ✓ | `unit:data/handler.test.ts` |
| 30 | User mode removes via the modular SDK's `remove(ref)` | ✓ | `unit:data/handler.test.ts` |
| 31 | `remove(ref)` and `set(ref, null)` produce the same end state (no path remains, `get` returns `null`) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` — observed `bothNull: true, equivalent: true` against blockingfun; sandbox-aligned: `unit:modular/sandbox-target.test.ts` ("remove and set(null) produce identical end-state") |
| 32 | Removing a non-existent path is a no-op that resolves successfully (matches RTDB's idempotent delete semantics) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-remove-idempotent.json` — `remove` on a never-written path observed `threw: false, afterExists: false`; sandbox-aligned: `unit:modular/sandbox-target.test.ts` ("removing a non-existent path is a no-op") |

## `rtdb_get_rules` / `generateIR()` — fetch + parse rules

| # | Behavior | Status | Probe |
|---|---|---|---|
| 33 | Fetches `/.settings/rules.json` AND `/.json?shallow=true` in parallel, then maps to an `RtdbIR` tree | ✓ | `unit:ir/handler.test.ts` ("hits both /.settings/rules.json and /.json") |
| 34 | Returns `RULES_FETCH_FAILED` when `/.settings/rules.json` returns 403 (insufficient admin permissions) | ✓ | `unit:ir/handler.test.ts` |
| 35 | Returns `RULES_PARSE_FAILED` when the rules response body is not valid JSON | ✓ | `unit:ir/handler.test.ts` |
| 36 | Returns success even when `/.json?shallow=true` returns 404 (proceeds with `null` shallow data, `rules.exists === false`) | ✓ | `unit:ir/handler.test.ts` |
| 37 | The returned IR has `service === 'realtime-database'` and `databaseUrl === host.databaseUrl` | ✓ | `unit:ir/handler.test.ts` |
| 38 | The IR tree's root node carries `read`/`write`/`validate` expressions parsed via the Ohm grammar; expressions expose `parsed.valid` + error list | ✓ | `unit:ir/handler.test.ts`, `unit:mapper.test.ts` |
| 39 | Top-level rule structure (e.g. `rules` wrapper, `.read`/`.write`/`.validate` keys, path-variable segments `$userId`) is parsed identically to how the REST `rules.json` PUT endpoint accepts it | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-rules-json-roundtrip.json` — PUT a rules subtree containing `$userId` path-variable segments, `.indexOn: ['createdAt', 'name']`, plus `.read`/`.write`/`.validate` expressions; GET-back returned `exactRoundTrip: true` (byte-for-byte JSON equality). Confirms the deploy / fetch shape is identical to what `RtdbMapper.mapToRulesJSON` and `mapToIR` expect. |

## `rtdb_deploy_rules` / `writeRules(ir)` — deploy rules

| # | Behavior | Status | Probe |
|---|---|---|---|
| 40 | Maps the IR to a rules-JSON payload via `RtdbMapper.mapToRulesJSON(ir)` and PUTs to `<databaseUrl>/.settings/rules.json?access_token=<admin>` | ✓ | `unit:write/handler.test.ts` |
| 41 | Returns `{ success: true }` on HTTP 200 | ✓ | `unit:write/handler.test.ts` |
| 42 | Returns `{ success: false, error: { code: 'PERMISSION_DENIED' } }` on HTTP 403 | ✓ | `unit:write/handler.test.ts` |
| 43 | Returns `{ success: false, error: { code: 'INVALID_RULES_JSON', recoverable: true } }` on HTTP 400 (includes the response body in `message`) | ✓ | `unit:write/handler.test.ts` |
| 44 | Returns `{ success: false, error: { code: 'WRITE_FAILED' } }` for any other non-OK status | ✓ | `unit:write/handler.test.ts` |
| 45 | Any thrown exception during fetch is caught and wrapped as `WRITE_FAILED` | ✓ | `unit:write/handler.test.ts` |
| 46 | Live RTDB rules-PUT endpoint takes a few seconds to propagate before subsequent reads/writes are evaluated under the new rules | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-rules-deploy-propagation-timing.json` — deployed a permissive rule then polled writes at 200ms intervals; the FIRST write succeeded at `firstSuccessElapsedMs: 154` (observed once against blockingfun on fb-js-sdk 12.13.0). Both `within5s: true` and `within10s: true`; the harness's current 5s wait is comfortably above the observed bound. Note: a single observation isn't a guaranteed upper bound; propagation can vary with load. |

## `rtdb_crawl_structure` / `crawlStructure(options)` — shape discovery

| # | Behavior | Status | Probe |
|---|---|---|---|
| 47 | Defaults to `path: '/'`, `maxDepth: 10`, `maxChildren: 100`, `maxConcurrency: 5` (from `CRAWL_DEFAULTS`) | ✓ | `unit:crawl/handler.test.ts` |
| 48 | Recursively fetches `<path>.json?shallow=true` at each level; uses `value === true` to identify object children and recurse | ✓ | `unit:crawl/handler.test.ts` ("schema excludes object children (value === true)") |
| 49 | Leaf primitive values (non-true, non-null) populate `node.schema[key]` with their `typeof` | ✓ | `unit:crawl/handler.test.ts` ("schema infers types from leaf primitive values") |
| 50 | A leaf primitive at the crawled path itself sets `node.valueType` rather than recursing | ✓ | `unit:crawl/handler.test.ts` ("leaf primitive node has valueType set") |
| 51 | A child node that returns only true-marked keys (the RTDB shallow representation of a nested object) is recursed; the schema of that child is populated from grandchild leaves | ✓ | `unit:crawl/handler.test.ts` ("schema populated from children that are leaf primitives") |
| 52 | 403 at the root returns `{ success: false, error: { code: 'PERMISSION_DENIED' } }` | ✓ | `unit:crawl/handler.test.ts` |
| 53 | 403 at a child returns an empty node (`childCount: 0`, `children: []`) rather than failing the whole crawl | ✓ | `unit:crawl/handler.test.ts` |
| 54 | A network error mid-crawl at a child returns an empty node for that subtree; the rest of the crawl proceeds | ✓ | `unit:crawl/handler.test.ts` |
| 55 | `maxDepth` truncates: deeper nodes are reported with `childCount` set but `children: []` | ✓ | `unit:crawl/handler.test.ts` |
| 56 | `maxChildren` exceeded → `truncated: true` on that node | ✓ | `unit:crawl/handler.test.ts` |
| 57 | `maxConcurrency` is enforced via a semaphore — concurrent in-flight fetches never exceed the limit | ✓ | `unit:crawl/handler.test.ts` ("concurrency is respected") |
| 58 | Live RTDB `shallow=true` REST response shape: object → object with keys mapped to `true`; leaf primitive → the primitive itself; missing path → `null` | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-shallow-rest-response-shape.json` — seeded `{ obj: { a, b, c }, leaf: 'hello', leafNum: 42, leafBool: true }`, then GET with `?shallow=true` at each path: object node returned `{ a: true, b: true, c: true }` (all keys → `true`), string leaf returned the string `'hello'`, numeric leaf returned `42`, boolean leaf returned `true`, missing path returned `null`. Locks every assumption the `CrawlStructureHandler` depends on. |

## `rtdb_simulate_access` / `simulate(input)` — in-process rule evaluator

| # | Behavior | Status | Probe |
|---|---|---|---|
| 59 | Returns `{ success: false, error: { code: 'IR_NOT_GENERATED' } }` when called before `generateIR()` | ✓ | `unit:simulation/handler.test.ts` |
| 60 | Returns `{ success: false, error: { code: 'INVALID_INPUT' } }` when input doesn't parse against `SimulationInputSchema` (e.g. path missing leading slash, operation not in read / write / validate) | ✓ | `unit:simulation/handler.test.ts` |
| 61 | Walks ancestors from root → target; the first ancestor whose rule expression evaluates to `true` grants access — matches RTDB's documented "rules cascade from root, true at any ancestor grants" semantics | ✓ | `unit:simulation/handler.test.ts` |
| 62 | Path variables (`$userId`) are bound from the URL path and exposed in `pathVariableBindings` (also without the `$` prefix for ergonomic access in expressions) | ✓ | `unit:simulation/handler.test.ts` |
| 63 | `auth` context: when `null`, `auth` is null inside expressions; when present, `auth.uid` and `auth.token.*` are bound | ✓ | `unit:simulation/handler.test.ts`, `unit:grammar/simulator.test.ts` |
| 64 | `mockData` becomes the value of `data` at every path during evaluation; `newData` is the proposed value for write/validate | ✓ | `unit:simulation/handler.test.ts` |
| 65 | `data.child("…")`, `data.parent()`, `data.exists()`, `data.val()` evaluate against the in-process snapshot — matches the documented `DataSnapshot` rule-context surface | ✓ | `unit:grammar/simulator.test.ts` |
| 66 | Cross-path `root.child(…).val()` reads return `null` for paths NOT present in `mockData` — divergence from real prod rules where the engine reads the live database | ⚠ | divergence: the simulator uses ONLY what's in `mockData`. Real rules engine reads from the live RTDB. Documented in `validated.ts` ("simulation uses empty mockData, so cross-path rule lookups … will evaluate as false") |
| 67 | An expression that fails to parse (`parsed.valid === false`) is skipped — the simulator falls through to the next ancestor | ✓ | `unit:simulation/handler.test.ts` |
| 68 | When no ancestor rule allows, the result is `{ allowed: false }` with `matchedPath` set to the deepest matched node | ✓ | `unit:simulation/handler.test.ts` |
| 69 | When NO ancestor has a rule for the operation at all, returns `{ success: false, error: { code: 'NO_MATCHING_RULE' } }` | ✓ | `unit:simulation/handler.test.ts` |
| 70 | Evaluation errors (grammar mismatch, unknown identifier) surface as `EVALUATION_ERROR` | ✓ | `unit:simulation/handler.test.ts` |
| 71 | Simulator's allow/deny decision matches the real RTDB rules engine for the same `{ rules, mockData, auth, operation, path, newData }` tuple, modulo the documented cross-path divergence on row #66 | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-simulator-vs-prod-agreement.json` — 8 test rules × 29 (rule, op) tuples; 28 agreements, 1 disagreement at capture time (`r4-validate-structure`: the simulator did not evaluate `.validate` on writes). The `.validate` walk is now implemented (`src/database/simulation/handler.ts`, reached from all backend write sites; grammar array-literals + `hasChildren(keys)` fixed alongside), closing the recorded disagreement — replayed as prod-conforming denial in `oracle-conformance.test.ts`. The frozen capture documents the historical divergence |

## `rtdb_validated_write` / `validatedWrite(input)` — preflighted write

| # | Behavior | Status | Probe |
|---|---|---|---|
| 72 | Crawls the structure at `path` to infer schema; collects `SchemaWarning[]` for `type_mismatch` (existing key with different type) and `new_field` (key not seen before) | ✓ | `unit:data/validated.test.ts` |
| 73 | Simulates the write against the IR's rules using `mockData: {}` and the supplied `auth` | ✓ | `unit:data/validated.test.ts` |
| 74 | Admin mode (no `auth`): simulation denial returns `{ success: false, error: { code: 'SIMULATION_DENIED', recoverable: true } }` — blocks the live write | ✓ | `unit:data/validated.test.ts` |
| 75 | User mode (`auth` provided): simulation denial is advisory only — the live write still runs because real rules will enforce against the actual database, where cross-path lookups can succeed | ✓ | `unit:data/validated.test.ts` |
| 76 | After preflight, the actual write is dispatched through `DataHandler.execute` with the original `auth` | ✓ | `unit:data/validated.test.ts` |
| 77 | Schema warnings are returned even on success — they're advisory, not blocking | ✓ | `unit:data/validated.test.ts` |
| 78 | A failed crawl is swallowed — the handler proceeds with no schema warnings and an unchecked write | ✓ | `unit:data/validated.test.ts` |

## `rtdb_build_expression` — rule expression authoring

| # | Behavior | Status | Probe |
|---|---|---|---|
| 79 | Returns a `RtdbRuleExpression` with `raw`, `parsed.valid`, `parsed.errors`, `parsed.warnings`, `parsed.referencedIdentifiers` | ✓ | `unit:mapper.test.ts` |
| 80 | A syntactically valid expression sets `parsed.valid === true` and lists referenced identifiers (`auth`, `auth.uid`, `data`, etc.) | ✓ | `unit:mapper.test.ts` |
| 81 | A syntactically invalid expression sets `parsed.valid === false` and populates `parsed.errors` with `{ code, message }` | ✓ | `unit:mapper.test.ts` |
| 82 | Linter warnings (e.g. always-true expressions, missing `auth` checks) populate `parsed.warnings` | ✓ | `unit:grammar/linter.test.ts` |
| 83 | The grammar accepts every documented RTDB rule operator: logical (`&&`, `or`, `!`), equality (`==`, `===`, `!=`), comparison (`<`, `<=`, `>`, `>=`), arithmetic (`+`, `-`, `*`, `/`, `%`), ternary `?:`, member access, function call, string/regex literals | ✓ | `unit:grammar/RtdbExprParser.test.ts` |

## Constraint authoring surface (`atoms` / `policies` / `compose` / `ruleset`)

| # | Behavior | Status | Probe |
|---|---|---|---|
| 84 | `atoms` exports the documented set of primitive predicates (`authenticated`, `ownPath`, `ownField`, `isNew`, `hasChildren`, `hasChild`, `fieldIsString/Number/Boolean`, `fieldEnum`, `immutable`, `immutableSelf`, `rootExists`, `rootEquals`) — each returns an `Expr` | ✓ | `unit:constraints/atoms.test.ts` |
| 85 | `policies` exports composite predicates that compose atoms: `pathOwnerOnly`, `fieldOwnerOnly`, `ownerOrNew`, `hasRole`, `isMember`, `required`, `transition` | ✓ | `unit:constraints/policies.test.ts` |
| 86 | `compose` exports the boolean combinators `all`, `any`, `not`, `deny`, `always`, plus the raw `expr` constructor | ✓ | `unit:constraints/compose.test.ts` |
| 87 | `ruleset(...)` builds an RTDB rules JSON object from a tree of path definitions + expression objects | ✓ | `unit:constraints/ruleset.test.ts` |
| 88 | Game-domain helpers (`turnGuard`, `flip`, `winCheckHelper`) compose into legal rule expressions | ✓ | `unit:constraints/game.test.ts` |

## `RtdbMapper` — IR ↔ rules-JSON

| # | Behavior | Status | Probe |
|---|---|---|---|
| 89 | `mapToIR(rulesJson, shallowData, databaseUrl)` produces an `RtdbIR` tree where each node carries its path, parsed expressions, and child nodes | ✓ | `unit:mapper.test.ts` |
| 90 | `mapToRulesJSON(ir)` is the inverse: produces a rules-JSON payload accepted by the `/.settings/rules.json` PUT endpoint | ✓ | `unit:mapper.test.ts` |
| 91 | Round-trip `mapToIR(mapToRulesJSON(ir))` produces an equivalent IR (locked path/expression-text equality, not object identity) | ✓ | `unit:mapper.test.ts` |
| 92 | Path-variable segments (`$userId`, `$gameId`) preserved across the round-trip | ✓ | `unit:mapper.test.ts` |
| 93 | `.indexOn` arrays preserved across the round-trip | ✓ | `unit:mapper.test.ts` |

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

| # | Behavior | Status | Probe |
|---|---|---|---|
| M1 | `getDatabase(ctx)` builds a sandbox-target `Database`; frozen `ctx.auth` baked in | ✓ | `unit:modular/sandbox-target.test.ts` ("getDatabase(ctx) returns a tagged Database handle") |
| M2 | `getDatabase(sandbox)` builds a sandbox-live target; reads `sandbox.currentUser` per op | ✓ | `unit:modular/sandbox-target.test.ts` ("reads sandbox.currentUser at op time, not at getDatabase time") |
| M3 | `getDatabase(app)` builds a prod target; delegates to `firebase/database.getDatabase(app)` | — | not yet locked by a prod-target integration test (firestore template covers the pattern; rtdb-side defers to Tier 5) |
| M4 | `ref(db, path?)` returns a path-tagged `DatabaseReference`; default is root | ✓ | `unit:modular/sandbox-target.test.ts` ("ref(db) returns a root ref" + "ref(db, ...) returns a path ref") |
| M5 | `child(ref, 'sub/path')` composes paths; result inherits the parent's target | ✓ | `unit:modular/sandbox-target.test.ts` ("child(ref, 'sub') composes paths") |
| M6 | `ref.parent` returns the parent ref; `root.parent === null` | ✓ | `unit:modular/sandbox-target.test.ts` ("ref.parent returns the parent ref; root.parent is null") |
| M7 | `ref.root` returns the root ref of the same target | ✓ | `unit:modular/sandbox-target.test.ts` ("ref.root returns the root ref") |
| M8 | `get(ref)` returns a `DataSnapshot`-shaped object with `val()`, `exists()`, `key`, `child()`, `hasChildren()`, `numChildren()`, `toJSON()` | ✓ | `unit:modular/sandbox-target.test.ts` (snapshot shape tests) |
| M9 | `get` on an absent path resolves to `{ val: null, exists: false }` (matches `DataSnapshot.val()` contract) | ✓ | `unit:modular/sandbox-target.test.ts` ("reads return null for an absent path") |
| M10 | `set(ref, value)` replaces the value at the path | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("round-trips a primitive value" + "round-trips nested objects"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-set-then-get-roundtrip.json` (prod observation blocked on rules; sandbox locks the contract directly) |
| M11 | `set(ref, null)` deletes the subtree at the path | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("set(ref, null) deletes the path"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` |
| M12 | `remove(ref)` is equivalent to `set(ref, null)` (same end state) | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("remove and set(null) produce identical end-state"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` |
| M13 | `update(ref, patch)` shallow-merges top-level keys at the ref's path | ✓ | `unit:modular/sandbox-target.test.ts` ("shallow-merges top-level keys") |
| M14 | `null` value in a shallow update deletes that key | ✓ | `unit:modular/sandbox-target.test.ts` ("null values in a shallow update delete the key") |
| M15 | `update(rootRef, { '/a/x': v1, '/b/y': v2 })` is a multi-path atomic write — all paths land or none do | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("writes every listed path atomically" + "rejects the entire update if rules deny any one path"); matches the matrix #23 prod contract |
| M16 | Overlapping multi-path updates (one path is a descendant of another) reject before any path is written | ✓ | `unit:modular/sandbox-target.test.ts` ("rejects overlapping paths") |
| M17 | `push(ref)` mints a 20-char auto-id key starting with `-`, lexicographically sortable | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("mints 20-char keys starting with \"-\"" + "sequential push keys are lex-sortable"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json` |
| M18 | `push(ref, value)` writes `value` at the new child path | ✓ | `unit:modular/sandbox-target.test.ts` ("push(ref, value) writes the value at the new child path") |
| M19 | `pushKey()` mints a fresh push-shaped key without writing — used by callers building multi-path updates that need the key first | ✓ | `unit:modular/sandbox-target.test.ts` ("pushKey() mints a fresh key without writing") |
| M20 | `serverTimestamp()` returns the `{ ".sv": "timestamp" }` sentinel marker the wire encoder recognises | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("serverTimestamp() returns the documented shape"); matches the prod wire contract |
| M21 | `serverTimestamp()` resolves to a number (epoch ms) on read-back | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("resolves to a number on read-back"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json` (prod observation blocked on rules; sandbox locks the contract directly) |
| M22 | `serverTimestamp()` sentinels resolve when nested inside multi-path update payloads | ✓ | `unit:modular/sandbox-target.test.ts` ("resolves sentinels nested deep inside an update payload") |
| M23 | Rules-denied write throws a plain `Error` (NOT a `FirebaseError`) with `.code === 'PERMISSION_DENIED'` (uppercase snake-case) and `.message === 'PERMISSION_DENIED: Permission denied'` | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("rules-denied set throws a plain Error with PERMISSION_DENIED code"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` (against blockingfun, fb-js-sdk 12.13.0) |
| M24 | Rules-denied read throws the same plain-`Error` `PERMISSION_DENIED` shape as a denied write | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("rules-denied get throws the same plain Error shape"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` |
| M25 | Rules-denied remove throws the same plain-`Error` `PERMISSION_DENIED` shape | ✓ | Sandbox aligned: `unit:modular/sandbox-target.test.ts` ("rules-denied remove throws the same plain Error shape") |
| M26 | `onValue(ref, cb)` fires immediately on subscribe with the current value at the path | ✓ | `unit:modular/sandbox-target.test.ts` ("fires on subscribe with the current value") |
| M27 | `onValue` fires again after every write that CHANGES the value at the watched path; a write that leaves the watched subtree byte-identical (a no-change re-write, or an ancestor/descendant write that doesn't alter this path) is suppressed (DB-B8) | ✓ | `unit:modular/sandbox-target.test.ts` ("fires after every write that touches the watched path") + `unit:modular/no-change-suppression.test.ts` ("re-writing the same value does NOT re-fire" + "ancestor write leaving the subtree unchanged does NOT fire") |
| M28 | `onValue` fires after a descendant write (the listener sees subtree changes) | ✓ | `unit:modular/sandbox-target.test.ts` ("fires on a descendant write") |
| M29 | `onValue` initial-fire for an absent path delivers `val=null, exists=false` (matches matrix expectation locked by oracle for sentinel/listener shape) | ✓ | `unit:modular/sandbox-target.test.ts` ("absent path: initial fire delivers val=null, exists=false") |
| M30 | The `onValue` return value is an unsubscribe function; calling it stops further fires | ✓ | `unit:modular/sandbox-target.test.ts` ("fires after every write that touches the watched path" — checks unsubscribed listener doesn't fire on subsequent write) |
| M31 | `onChildAdded` / `onChildChanged` / `onChildRemoved` / `onChildMoved` — plain-ref subscription surface | ✓ | Tier 2: sandbox aligned with oracle observations under `packages/conformance/observations/rtdb-modular/rtdb-modular-onchild*.json`. See M41–M48 for the per-event behavioral claims. |
| M41 | `onChildAdded` replays each existing direct child of the parent ref on subscribe (one fire per existing key) | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("replays existing direct children on subscribe — one fire per key"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-initial-replay.json` (seeded `{k1,k2,k3}`, observed `firedKeys: ['k1','k2','k3']`). |
| M42 | After subscribe, `onChildAdded` fires exactly once per new direct child write; snapshot carries `{key, val}` of the new child | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("fires exactly once per NEW direct child after subscribe"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-post-subscribe.json` (`postSubscribeFires: 1`, `lastFire: {key:'k3', val:{v:3}}`). |
| M43 | `onChildChanged` has NO initial replay; fires once when an existing direct child's value transitions; snapshot carries the NEW value | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("does NOT fire on subscribe (no initial replay)" + "fires once when an existing child transitions to a new value; snapshot carries NEW val"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildchanged-fires-on-update.json` (`firedOnInitial: 0, firedOnUpdate: 1, lastFire: {key:'k1', val:{v:2}}`). |
| M44 | `onChildChanged` does NOT fire for added or removed children — those go to the other event listeners | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("does NOT fire when a child is added" + "does NOT fire when a child is removed"). |
| M45 | `onChildRemoved` has NO initial replay; fires once when a direct child is deleted (via `remove(child)` or `set(child, null)`); snapshot carries the PRIOR (now-removed) value | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("fires once when a child is deleted via remove(); snapshot carries PRIOR val" + "fires once when a child is deleted via set(child, null); snapshot carries PRIOR val"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildremoved-fires-on-delete.json` (`firedOnInitial: 0, firedOnDelete: 1, removedSnapCarriesPriorValue: true`). |
| M46 | `onChildMoved` on a plain ref (no `query(_, orderBy*)`) NEVER fires — per RTDB docs, child_moved emits only under ordered queries | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("does NOT fire on a plain ref (no ordering)"); matches the upstream contract observed under ordered-query in `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildmoved-with-orderby.json` (where ordered-query did fire — Tier 3 will wire that path; Tier 2 locks the plain-ref no-fire case). |
| M47 | `off(ref)` (no event type) removes ALL listeners at that ref — value + every child event variety | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("off(ref) removes ALL listeners at the ref" + "off(ref) also removes value listeners at the same path"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-off-stops-child-fires.json` (`postOffFires: 0`). |
| M48 | `off(ref, eventType?, callback?)` variants: `off(ref, 'value')` / `off(ref, 'child_added')` / `off(ref, eventType, cb)` remove the targeted subset; returned-unsubscribe from `onChild*` is equivalent to `off(ref, eventType, cb)` | ✓ | Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` ("off(ref, \"child_added\") removes only that event variety" + "off(ref, \"value\") removes only value listeners" + "off(ref, eventType, cb) removes only the matching callback" + "returned-unsubscribe from onChildAdded is functionally equivalent to off()"). |
| M32 | `connectDatabaseEmulator(db, host, port)` is a no-op on sandbox targets (the sandbox IS a local emulator) | ✓ | `unit:modular/sandbox-target.test.ts` ("is a no-op on sandbox handles") |
| M33 | `sandbox.setRules(db, rulesJson)` deploys rules to the in-process simulator; `setRules(db, null)` clears rules (default-allow) | ✓ | `unit:modular/sandbox-target.test.ts` ("sandbox.setRules(db, null) clears rules") |
| M34 | `sandbox.setData(db, { '/path': value })` bulk-loads data, bypassing rules | ✓ | `unit:modular/sandbox-target.test.ts` ("sandbox.setData seeds the tree (rule-bypass)") |
| M35 | `sandbox.snapshotState(db)` dumps the full tree as a plain JSON object | ✓ | `unit:modular/sandbox-target.test.ts` ("sandbox.snapshotState dumps the full tree") |
| M36 | `query(ref, ...constraints)` + ordering/range constraints | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` covers `query(ref, orderByChild/Key/Value, startAt/After, endAt/Before, equalTo, limitToFirst/Last)` against the executor in `packages/pyric/src/database/sandbox/query.ts`; oracle observations under `packages/conformance/observations/rtdb-modular/rtdb-modular-{orderbychild-window,orderbykey-window,orderbyvalue-numeric,equalTo-filter,limittofirst-vs-limittolast,startafter-endbefore-exclusive,onvalue-with-query}.json` lock each constraint's behavior. See M49–M64 below for the per-claim breakdown. |
| M37 | `runTransaction(ref, fn, options?)` resolves to `{ committed: boolean, snapshot: DataSnapshot }` for the happy path — the update fn return value is written, committed is `true`, and `snapshot.val()` reflects the committed value | ✓ | Sandbox aligned: `unit:modular/transaction.test.ts` ("resolves to { committed: boolean, snapshot } with the committed value"); matches oracle observations `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json` + `rtdb-modular-runtransaction-returns-committed-snapshot.json` (against blockingfun, fb-js-sdk 12.13.0) |
| M37a | Returning `undefined` from the update fn ABORTS the transaction — resolves `{ committed: false, snapshot }`; no write performed, no listener fan-out | ✓ | Sandbox aligned: `unit:modular/transaction.test.ts` ("returning undefined aborts — committed: false, no write" + "aborted transaction does NOT fan out to listeners"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-abort-undefined.json` — known divergence: prod's `result.snapshot.val()` reflects the CLIENT's pre-fetch (often `null` even when the server has a value because the speculative invocation runs before the server snap arrives); the sandbox returns the actual pre-transaction value at the path (more useful in single-client harness). The agreed-upon contract callers should rely on is `committed === false` and unchanged server-side data, NOT the snapshot's `.val()` on the abort path. |
| M37b | The update fn receives the CURRENT value at the ref's path; for an absent path the argument is `null` (NOT `undefined`) | ✓ | Sandbox aligned: `unit:modular/transaction.test.ts` ("update fn receives null for an absent path" + "update fn receives the existing value for a seeded path"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-current-value-arg.json` (prod observation showed `missingArgs[0].isNull === true`) — note divergence: prod ALSO speculatively calls the fn with `null` for a seeded path before the server-snap arrives, the sandbox skips that speculative call (single invocation with the real current value) |
| M37c | The update fn arg is a defensive deep clone — mutating it does NOT corrupt the stored tree (matters for code that does `current.count++; return undefined` and expects abort to preserve state) | ✓ | `unit:modular/transaction.test.ts` ("mutating the update-fn arg does NOT corrupt the stored tree") — no separate oracle row (defensive contract; prod behavior is identical because the SDK clones on the wire boundary) |
| M37d | `options.applyLocally` controls whether the in-flight optimistic value fans out to `onValue` listeners — default `true` (apply locally before commit); `false` suppresses intermediate fires so listeners see only the committed value | ✓ | Sandbox aligned: `unit:modular/transaction.test.ts` ("applyLocally: true (default) — listener sees initial + committed value" + "applyLocally: false — listener sees only the committed value"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-options-applylocally.json` (single-client harness: both branches produce 2 fires (initial + commit) — divergence vs prod's documented multi-client suppression would surface under contention, which the sandbox doesn't model) |
| M37e | Rules-denied transaction rejects with a plain `Error` whose `message === 'permission_denied'` (lowercase) and NO `.code` field — DIFFERENT from `set`/`get`'s `'PERMISSION_DENIED: Permission denied'` shape with uppercase `.code`. **Note: the divergence between the two shapes is real at the SDK boundary, but the `DataHandler` layer normalizes both to `error.code === 'PERMISSION_DENIED'` (row #14) so consumer code only needs to branch on one value.** | ✓ | Sandbox aligned: `unit:modular/transaction.test.ts` ("rejects with a plain Error whose message is \"permission_denied\""); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-on-rules-denied-path.json` (against blockingfun: `message: 'permission_denied', code: null, constructorName: 'Error'`). Handler-level unification locked by `unit:data/handler.test.ts` ("transaction-shaped rules-denied (lowercase message, no .code) surfaces as PERMISSION_DENIED"). |
| M37f | Rules-denied transaction does NOT write — pre-transaction value at the path is preserved through the rejection | ✓ | `unit:modular/transaction.test.ts` ("does not write to the path when rules deny") — locked alongside the M37e shape claim |
| M37g | Committed transaction fans out to `onValue` listeners on the watched path with the new value (default applyLocally behavior) | ✓ | `unit:modular/transaction.test.ts` ("committed write fans out to onValue listeners") |
| M37h | Concurrent contention / retry-on-conflict — single-client sandbox doesn't model real concurrency; the documented "up to 25 retries" contract is degenerate (the fn is invoked once) | — | matrix #161 documents the same gap on the spec side; oracle observation hard to obtain from a single client (oracle row stays `?`) |
| M38 | Identity-aware sandbox-live op routing — sign-in/sign-out via `pyric/auth` is observed by the next RTDB op without re-binding | ✓ | `unit:modular/sandbox-target.test.ts` ("reads sandbox.currentUser at op time, not at getDatabase time") |
| M39 | Backend identity is per-`Sandbox` — two `getDatabase(sandbox)` calls on the same sandbox share data, two on different sandboxes don't | ✓ | implicit via the WeakMap binding; tested transitively by `sandbox.setData` + `get` round-trips in the same test suite |
| M40 | Sandbox refs carry a stable `key` (last path segment) and `toString()` returning `sandbox://rtdb/<path>` | ✓ | covered by the `ref` / `child` / `parent` tests |
| M49 | `query(ref, orderByChild(p), startAt(v), endAt(w))` window is BOTH-INCLUSIVE — children whose ordered field === `v` or === `w` are included | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("returns children whose ordered child is within [startAt, endAt] inclusive"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-orderbychild-window.json` (positions `[2,3,4]`, both ends inclusive). |
| M50 | `orderByKey()` orders children by RTDB `nameCompare` — integer-looking keys sort numerically FIRST (so `['1','2','10']`, not the lexicographic `['1','10','2']`), then non-integer keys lexicographically; `startAt`/`endAt` cursors + the optional `key` tie-breaker use the same order (DB-B4) | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("orderByKey + startAt(s) + endAt(e) yields keys in [s,e] inclusive") + `unit:modular/name-compare.test.ts` ("orderByKey sorts integer keys numerically, before non-integer keys" + "numeric-key cursor uses nameCompare bounds"); matches oracle `rtdb-modular-orderbykey-window.json` and upstream `core/util/util.ts:253-276`. |
| M51 | `orderByValue()` orders primitive children by their value; `limitToFirst(N)` returns the N smallest, ascending | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("returns the limitToFirst(N) smallest values, ascending"). Oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-orderbyvalue-numeric.json` shows prod threw `Index not defined` against blockingfun — the sandbox does NOT enforce `.indexOn` (rules-engine integration for query indexes is deferred); the semantic claim (ordering by value) is locked here. |
| M52 | `orderByChild(p) + equalTo(v)` returns ALL children whose field at `p` === `v` — no uniqueness enforced | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("returns ALL children whose ordered field === the supplied value"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-equalTo-filter.json` (both 'b'-grouped children returned). |
| M53 | `equalTo` with no matches returns an empty snapshot (`exists() === false`, `numChildren() === 0`) | ✓ | `unit:modular/queries.test.ts` ("returns an empty snapshot when nothing matches") |
| M54 | `limitToFirst(N)` keeps the lowest-ranked N children (post-ordering, pre-filter) | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("limitToFirst takes the lowest-ranked window"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` (firstPositions `[1,2]`). |
| M55 | `limitToLast(N)` keeps the highest-ranked N children | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("limitToLast takes the highest-ranked window"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` (lastPositions `[4,5]`). |
| M56 | `limitToFirst(N)` larger than the result returns the full window (no padding, no throw) | ✓ | `unit:modular/queries.test.ts` ("limitToFirst(N) larger than the result returns the full window") |
| M57 | `startAfter(v)` and `endBefore(v)` are EXCLUSIVE — the boundary value is dropped from the result | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("startAfter + endBefore drop the boundary values"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json` (positions `[3,4]`, cursors 2 + 5 dropped). |
| M58 | `onValue(query, cb)` only fires when the windowed result changes — writes OUTSIDE the window don't re-fire the listener; writes that displace a member DO | ✓ | Sandbox aligned: `unit:modular/queries.test.ts` ("fires only when the windowed result changes"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-with-query.json` (3 fires: initial + INSIDE-window write + displacing write; OUTSIDE-window write skipped). |
| M59 | `onValue(query)` initial fire delivers an empty window (`numChildren() === 0`) when the path is absent | ✓ | `unit:modular/queries.test.ts` ("initial fire on an empty path delivers an empty window") |
| M60 | `query(query(ref, c1), c2)` composes constraints — chaining folds both into one spec | ✓ | `unit:modular/queries.test.ts` ("query(query(ref, c1), c2) composes constraints") |
| M61 | Snapshot from a query exposes children via `snap.forEach` in the executor-computed order — NOT necessarily the order `Object.entries(val)` would yield | ✓ | `unit:modular/queries.test.ts` ("forEach visits children in ascending order of the child key") |
| M62 | `startAt(value, key)` uses `key` as the tie-breaker when multiple children share the same ordered value — children before `key` are dropped, the row at `key` is included (inclusive cursor) | ✓ | `unit:modular/queries.test.ts` ("startAt with key tie-breaker drops earlier same-value children") |
| M63 | `orderByChild('p')` on children missing the field treats their value as `null` (sorts FIRST per RTDB's type ordering) | ✓ | `unit:modular/queries.test.ts` ("orderByChild on a missing child path treats those children as null") |
| M64 | `query` on a path holding a primitive (or absent path) returns an empty snapshot — no rows to iterate | ✓ | `unit:modular/queries.test.ts` ("query on a path with primitive value returns no rows") |
| M65 | Write-boundary normalization (`nodeFromJSON`-equivalent): a value written as an array is stored as an integer-keyed object — `child(ref, '1')` returns the element, `forEach` iterates `0,1,2…` (DB-B2) | ✓ | Sandbox aligned: `unit:modular/normalization.test.ts` ("array write is addressable by integer-string child key" + "forEach over an array iterates its elements"); upstream `core/snap/nodeFromJSON.ts:118-128`, `core/snap/ChildrenNode.ts:194-230` |
| M66 | Read-side array coercion: a dense integer-keyed object renders back as an array on `snap.val()` (`allIntegerKeys && maxKey < 2 * numKeys`) (DB-B2) | ✓ | Sandbox aligned: `unit:modular/normalization.test.ts` ("a dense integer-keyed object reads back as an array"); upstream `core/snap/ChildrenNode.ts:196-230` |
| M67 | `null` children and empty objects are pruned at the write boundary — `set(ref, {})` is equivalent to `remove(ref)`; nested `null` collapses empty ancestors ("empty nodes don't exist") (DB-B3) | ✓ | Sandbox aligned: `unit:modular/normalization.test.ts` ("set(ref, {}) is equivalent to remove" + "null children are pruned"); upstream `core/snap/nodeFromJSON.ts:78-88,122-126` |
| M68 | Write validation: an `undefined` payload, a non-finite number (`NaN`/`±Infinity`), or a key containing a forbidden char (`.`, `#`, `$`, `/`, `[`, `]`, control chars) is rejected with a plain `Error` (DB-B1) | ✓ | Sandbox aligned: `unit:modular/normalization.test.ts` ("rejects an undefined payload" + "rejects an invalid key" + "rejects a non-finite number"); upstream `core/util/validation.ts:45,58,112-199` |
| M69 | Conflicting query constraints throw synchronously at `query(...)` construction (NOT silent last-win): multiple `orderBy*`, a second `limitToFirst`/`limitToLast`, a second start (`startAt`/`startAfter`/`equalTo`) or end (`endAt`/`endBefore`/`equalTo`) (DB-B5) | ✓ | Sandbox aligned: `unit:modular/constraint-conflicts.test.ts` (5 cases); upstream `api/Reference_impl.ts:160-165,1824-1841,1888-1905,1945-1951,2193-2206` |
| M70 | `push(ref, value?)` returns a `ThenableReference` (a `DatabaseReference` with `.then`/`.catch`). The key + ref are minted CLIENT-SIDE and available synchronously even when the optional value write is rules-denied; the write is deferred onto the promise, so a denial REJECTS the awaited push rather than throwing synchronously and discarding the key (DB-B7) | ✓ | Sandbox aligned: `unit:modular/push-thenable.test.ts` (4 cases); matches oracle `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json` ("available immediately even when the subsequent server write is denied by rules") + upstream `api/Reference_impl.ts:599-630` |
| M71 | `DataSnapshot` shape: `size` (getter), `priority` (always `null` — priority deny-listed), `exportVal()`, `key`, `ref`, `val()`, `exists()`, `child()`, `hasChild()`, `hasChildren()`, `forEach()`, `toJSON()`. It does NOT ship the legacy namespaced `numChildren()` method (DB-B10) | ✓ | Sandbox aligned: `unit:modular/snapshot-shape.test.ts` ("exposes size/priority/exportVal; NOT numChildren()"); matches oracle `packages/conformance/observations/rtdb-modular/rtdb-modular-get-snapshot-shape.json` (`hasSize: true, hasNumChildren: false`) + upstream `api/Reference_impl.ts:288-447`. **Flipped masking tests**: `modular/queries.test.ts` + `modular/sandbox-target.test.ts` asserted `snap.numChildren()` — updated to `snap.size`. |
| M72 | Object-valued children are ORDER-EQUAL — the sort/range tie is broken by key (`nameCompare`), NOT by an invented `JSON.stringify` ordering; a query re-write that only reorders object keys is "no change" and doesn't re-fire (DB-B11) | ✓ | Sandbox aligned: `unit:modular/object-order-equality.test.ts`; upstream `core/snap/ChildrenNode.ts:386-400` |
| M73 | A primitive at the ROOT is legal (`set(ref(db), 'hello')`); a subsequent child write replaces the primitive root ("writes win") (DB-B13) | ✓ | Sandbox aligned: `unit:modular/root-primitive.test.ts` (2 cases) |
| M74 | `onValue(ref, cb, { onlyOnce: true })` fires once then auto-unsubscribes (DB-B12) | ✓ | Sandbox aligned: `unit:modular/onvalue-onlyonce.test.ts`; upstream `api/Reference_impl.ts:975-980` |
| M75 | **Divergence (DB-B12, honest doc):** the onChild* callbacks do NOT receive the `previousChildName` second argument; `onValue`/`onChild*` do NOT accept a `cancelCallback`; `onChildAdded`/`Changed`/`Removed`/`Moved` accept only plain refs (not `Query`); `child_moved` never fires (ordered-query move detection unmodeled). These listener-surface holes are out of scope for the current phase — consumers needing them use `firebase/database` directly. | ⚠ | divergence documented; partial coverage: `{ onlyOnce }` IS implemented (M74). |
| M76 | **Divergence (DB-B9, honest doc):** `.validate` rules are NOT enforced on modular sandbox writes (`set`/`update`/`runTransaction`). The modular write path routes through the same `RulesEvaluator` → `SimulateHandler` as the simulator, which short-circuits on the first ancestor `.write` that grants access without also requiring every ancestor `.validate` to pass (same divergence as row #71). A write the live RTDB rejects via a deeper `.validate` still succeeds in the sandbox. | ⚠ | divergence documented (shared root with row #71). |

## Intentionally not implemented (agent-tool surface)

Parts of `firebase/database` the agent-tool surface does not implement (the modular SDK surface below covers most of them):

| Name | Reason |
|---|---|
| `onValue` / `onChildAdded` / `onChildChanged` / `onChildRemoved` / `onChildMoved` / `onDisconnect` | Long-lived listeners don't fit the request-response tool-call shape; use `firebase/database` directly. |
| `query` + ordering constraints (`orderByChild`, `orderByKey`, `orderByValue`, `equalTo`, `startAt`, `endAt`, `limitToFirst`, `limitToLast`) | The tool surface does whole-path reads only. |
| `runTransaction` | Read-modify-write with retry does not model cleanly as a single tool call. |
| `serverTimestamp()` / `increment(n)` sentinels in the data tools | Not wired through the tool paths. |
| `goOnline` / `goOffline` / `Database.useEmulator` | No persistent client state for the data tools. |
| `connectDatabaseEmulator` | Out of scope; the package targets real RTDB. |
| `Database.app` / `getDatabase()` | Lifecycle is owned by the host. |

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
`packages/conformance/observations/` locks them. The matrix is the spec;
the oracle locks it.

### `getDatabase(target)` — initializer

| # | Behavior | Status | Probe |
|---|---|---|---|
| 94 | `getDatabase(ctx)` returns a tagged sandbox-target handle (frozen identity) | — | Phase 3 |
| 95 | `getDatabase(sandbox)` returns a tagged sandbox-live handle (per-op identity) | — | Phase 3 |
| 96 | `getDatabase(app)` returns a tagged prod target | ? | upstream `firebase/database` contract; not currently probed in isolation |
| 97 | `getDatabase()` (no argument) — wrapped in the playground preview to default to the sandbox; raw call delegates to prod | ✓ (wrap, fixture passing) | Phase 3 Tier 5: virtualized in the playground preview scope. Wired at `packages/playground/src/components/AppPreview.tsx` (slot install with bare-call wrap), `packages/playground/src/lib/preview/virtual-imports-plugin.ts` (alias map), and `packages/playground/src/lib/preview/preview-scope.ts` (type-level slot). Mirrors the `getAuth` / `getFirestore` wrap pattern. Demo fixture: `packages/playground/scripts/fixtures/rtdb-set-get-roundtrip.tsx` (bare `getDatabase()` + `set`/`get`/`remove` round-trip with anon sign-in) — passes end-to-end through the `bun run debug:fixtures` Playwright suite (revived in the playground rtdb-fixture follow-up; the suite previously couldn't load `@pyric/rtdb` in the client because its top-level re-export of `DataHandler` pulled `firebase-admin`, now stubbed via `packages/playground/src/lib/node-shims/firebase-admin.ts`). |
| 98 | Two `getDatabase(sandbox)` calls share state (same underlying `LocalEnvironment`) | — | Phase 3 |
| 99 | Handle dispatch by `TARGET_SYMBOL` brand — refs route to their owning target via a `refToTarget` WeakMap (mirror of firestore's pattern) | — | Phase 3 |

### `ref(db, path)` / `child` / `parent` / `root`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 100 | `ref(db, path)` returns a tagged `DatabaseReference` carrying `key`, `parent`, `root`, `toString()` | ? | upstream `firebase/database` contract |
| 101 | `ref(db)` with no path returns the root ref (`key === null`, `parent === null`) | ? | upstream contract |
| 102 | `child(ref, 'a/b')` joins a relative path, including embedded slashes | ? | upstream contract |
| 103 | `ref.parent` is `null` at root, otherwise the parent ref | ? | upstream contract |
| 104 | `ref.key` is the final path segment, `null` for root | ? | upstream contract |
| 105 | Unknown ref (not produced by this package) → `TypeError` in shim ops | — | Phase 3 |

### `get(ref)` — single read

| # | Behavior | Status | Probe |
|---|---|---|---|
| 106 | Returns a `DataSnapshot` carrying `.val()`, `.exists()`, `.key`, `.ref`, `.size` (getter, returns child count), `.hasChildren()`, `.hasChild(path)`, `.forEach(cb)`. The legacy namespaced-SDK method `.numChildren()` is **NOT** on the modular DataSnapshot — use `.size` instead. Observed: `hasNumChildren: false`, `size: 3` for a `{a,b,c}` object, `forEachKeys: ['a','b','c']` against blockingfun, fb-js-sdk 12.13.0. | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-get-snapshot-shape.json` |
| 107 | `snap.val()` returns `null` for a missing path (NOT a thrown error — RTDB diverges from Firestore here; `getDoc` returns `exists()===false` but `get` on RTDB just returns a `null`-val snapshot) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-get-missing-path.json` — observed `threw: false, val: null, exists: false` on a never-written path against blockingfun. |
| 108 | `snap.exists()` is `false` when `val() === null`, `true` otherwise | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-get-missing-path.json` — observed `exists: false` for `val: null`. |
| 109 | Round-trip: `set(ref, payload)` then `get(ref)` returns the payload (lock the basic write→read invariant) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-set-then-get-roundtrip.json` — the payload round-trips structurally on both sides (this row's claim holds). NOTE — adjacent divergence pinned in `oracle-conformance.test.ts`: prod returns object children in LEXICOGRAPHIC key order (the capture's `roundTripEqual: false` — a `JSON.stringify` round-trip against a non-sorted payload fails), while the sandbox preserves insertion order (stringify round-trip succeeds). Key-order-sensitive consumers behave differently. |
| 110 | Rules-denied read throws a plain `Error` (NOT a `FirebaseError`) with `code: 'PERMISSION_DENIED'` (uppercase snake-case) — matches the agent-tool rows #15/#20 | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` |

### `set(ref, value)` — full write

| # | Behavior | Status | Probe |
|---|---|---|---|
| 111 | Replaces the value at the path entirely; resolves to `undefined` (unlike `setDoc` which resolves to `void`, RTDB's `set` is documented as `Promise<void>`) | ? | upstream contract |
| 112 | `set(ref, null)` removes the path entirely — equivalent to `remove(ref)`, subsequent `get` returns `null`-val snapshot | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-set-null-equals-remove.json` — observed `beforeExists: true → afterExists: false, afterVal: null` after `set(ref, null)`. |
| 113 | Nested objects overwrite — `set(ref, {a: 1})` after `set(ref, {a: 1, b: 2})` leaves `{a: 1}` only, NOT a merge (RTDB `set` is replacement, not merge) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-set-replaces-not-merges.json` — observed `final: {a: 1}` with `b` absent after the second set. |
| 114 | Primitive round-trip — numbers, strings, booleans, arrays all survive a set→get cycle | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-set-then-get-roundtrip.json` — the payload round-trips structurally on both sides (this row's claim holds). NOTE — adjacent divergence pinned in `oracle-conformance.test.ts`: prod returns object children in LEXICOGRAPHIC key order (the capture's `roundTripEqual: false` — a `JSON.stringify` round-trip against a non-sorted payload fails), while the sandbox preserves insertion order (stringify round-trip succeeds). Key-order-sensitive consumers behave differently. |
| 115 | Rules-denied write throws plain `Error` with `code: 'PERMISSION_DENIED'` (same shape as #110) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` |

### `update(ref, values)` — partial / multi-path update

| # | Behavior | Status | Probe |
|---|---|---|---|
| 116 | `update(ref, {a: 1, b: 2})` merges top-level keys at the ref; unspecified keys preserved (in contrast to `set`'s replacement) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-merges-keys.json` — after `set({a:1,b:2})` then `update({a:10})`, observed `final: {a:10, b:2}`. |
| 117 | Multi-path update — `update(parentRef, { 'a/x': 1, 'b/y': 2 })` lands BOTH writes atomically at distinct subtrees (RTDB's most distinctive feature; this is the "fan-out" pattern) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-multipath-atomic.json` — observed `aX: 1, bY: 2` both readable after a single update call. |
| 118 | Multi-path update is atomic: if any path is denied by rules, the entire update rejects and no path is written | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-multipath-rules-denial.json` — observed `threw: true, code: 'PERMISSION_DENIED'` AND `okPathWrittenDespiteDenial: false` (the otherwise-permitted path also rolled back). |
| 119 | Setting a key to `null` inside `update` removes that key — same equivalence as `set(ref, null)` | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-null-removes-key.json` — after `set({a:1,b:2})` then `update({a:null})`, observed `final: {b:2}` with `a` absent. |
| 120 | Update path validation — overlapping paths (e.g. `'/a'` and `'/a/x'` in the same call) throws synchronously before any write | ? | upstream contract — needs targeted probe |

### `remove(ref)` — delete

| # | Behavior | Status | Probe |
|---|---|---|---|
| 121 | Removes the value AND all children; subsequent `get` returns `null`-val snapshot | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` |
| 122 | Idempotent — `remove` on a path that's already absent resolves successfully (no-throw) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-remove-idempotent.json` — `remove` on a never-written path observed `threw: false, afterExists: false`. |
| 123 | `remove(ref)` and `set(ref, null)` produce the same end state — locks the documented RTDB invariant | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` |

### `push(ref, value?)` — auto-id append

| # | Behavior | Status | Probe |
|---|---|---|---|
| 124 | `push(ref).key` is a 20-char string starting with `-`, available **synchronously** (client-side mint, no server round-trip required) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json` |
| 125 | Sequential `push` calls produce monotonically-sortable keys (timestamp-prefixed for chronological ordering via `orderByKey`) | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json` |
| 126 | `push(ref, value)` writes the value AND returns the new child ref (both behaviors in one call); `push(ref)` mints the ref without writing | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-push-with-value.json` — `await push(parent, {hello:'world'})` returned a ref with a 20-char key; subsequent `get(r)` returned `{hello:'world'}`. |
| 127 | The returned ref `r = push(parent, value)` is usable in follow-up ops: `get(r)`, `set(r, …)`, `remove(r)` | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-push-with-value.json` — observed all 4 follow-up ops succeed through the returned ref (`refIsUsableForFollowupOps: true`). |

### `onValue(ref, cb)` — value-level listener

| # | Behavior | Status | Probe |
|---|---|---|---|
| 128 | Subscribing to a path with **existing data** fires the listener once with the current snapshot (the "initial fire") | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-initial-with-data.json` — observed exactly 1 initial fire within ~46ms of subscribe, snapshot.val() === the seeded payload. |
| 129 | Subscribing to a **nonexistent path** still fires the listener once — with a `null`-val snapshot AND `exists() === false`. Matches Firestore's `onSnapshot`-on-missing-doc semantics: prod RTDB does NOT silently skip the initial fire for empty paths. | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-initial-no-data.json` — observed 1 initial fire on a never-written path with `firstFire.val: null, firstFire.exists: false` (~55ms after subscribe). |
| 130 | Subsequent `set(ref, …)` fires the listener with the new value | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-onvalue-fires-on-set.json` — observed 1 fire per `set()` (1+1+1 = 3 total: initial-null, after-first-set, after-second-set). |
| 131 | Unsubscribe — the returned unsubscribe function stops further fires; subsequent writes produce 0 additional fires after `unsub()` | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-unsubscribe.json` — observed `preUnsubFires: 2, postUnsubFires: 2` (a write performed after `unsub()` produced 0 additional fires within a 500ms settle window). |
| 132 | The returned value from `onValue(ref, cb)` is the unsubscribe function (NOT an object); calling it removes the listener | ? | upstream contract — locked indirectly by #131 |

### `onChildAdded` / `onChildChanged` / `onChildRemoved` / `onChildMoved`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 133 | `onChildAdded` replays the existing children on subscribe — one fire per existing child key, in `orderByKey` order by default (unlike `onValue` which fires once with the parent snapshot) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-initial-replay.json` — seeded `{k1, k2, k3}`, observed 3 initial fires with `firedKeys: ['k1', 'k2', 'k3']` in insertion order against blockingfun. |
| 134 | After subscribe, adding a child via `push` or `set(child, …)` fires `onChildAdded` exactly once for that key | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildadded-post-subscribe.json` — seeded `{k1,k2}`, observed `postSubscribeFires: 1, lastFire: {key:'k3', val:{v:3}}` after writing the new child. |
| 135 | `onChildChanged` fires when an existing child's value changes; does NOT fire for added or removed children | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildchanged-fires-on-update.json` — observed `firedOnInitial: 0, firedOnUpdate: 1, lastFire: {key:'k1', val:{v:2}}` (the NEW value, not the prior). |
| 136 | `onChildRemoved` fires when a child is deleted (via `remove(child)` or `set(child, null)`); snapshot carries the PRIOR value | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildremoved-fires-on-delete.json` — observed `firedOnDelete: 1, removedSnapCarriesPriorValue: true` (snapshot.val() was the pre-delete value). |
| 137 | `onChildMoved` under an ordered query. Prod: fires when a child's `orderByChild`/`orderByValue` priority changes — emitted only on ordered queries. Sandbox: **never fires on reorder** — `onChildMoved` supports the plain-ref (no-fire) case only; the ordered-query overload is unimplemented | ⚠ | divergence, oracle-locked by `packages/conformance/observations/rtdb-modular/rtdb-modular-onchildmoved-with-orderby.json`: prod observed `firedOnMove: 1` under `query(ref, orderByChild('priority'))` after bumping a child's priority to a new sort position; the sandbox fires 0 on reorder. Partial alignment landed: all `onChild*` now ACCEPT a `Query` (previously threw a misleading `unrecognized reference` TypeError) with window-aware `child_added`/`child_changed`/`child_removed` diffs (`src/database/sandbox/backend.ts`); the two hold-lifting captures now exist: `rtdb-modular-onchildmoved-previouschildname-sequencing` pins prev-name sequencing (end/middle/front reorders yield prev k3/k2/null, no initial replay) and `rtdb-modular-childchanged-cofire-with-childmoved` pins co-fire semantics (a reorder fires BOTH `child_changed` and `child_moved`; a non-ordered-field change fires neither moved; prod fires `child_moved` on an ordered-field value change EVEN WHEN RANK IS UNCHANGED). Implementation of ordered `child_moved` is unblocked. Both sides pinned in `modular/oracle-conformance.test.ts` and `modular/sandbox-child-events.test.ts`. Sandbox Tier 2 locks the plain-ref no-fire case (M46). |

### `off(ref, eventType?, callback?)` — unsubscribe variants

| # | Behavior | Status | Probe |
|---|---|---|---|
| 138 | `off(ref)` removes ALL listeners at that ref (any event type, any callback) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-off-stops-child-fires.json` — after `off(ref)` with no eventType, a subsequent write produced `postOffFires: 0` against an `onChildAdded` registration. |
| 139 | `off(ref, 'value')` removes only `value` listeners at that ref | ✓ | Sandbox aligned (M48); oracle: `packages/conformance/observations/rtdb/rtdb-off-eventtype-precision.json` — registered TWO `value` listeners + one `child_added` at the same ref; after `off(ref, 'value')` (no callback), `valueListenersStopped: true` (neither value cb fired on subsequent writes) AND `childListenerStillFiringAfterOffValue: true` (the child listener kept firing). `offValueClearsAllValueListeners: true` confirms the no-callback variant removes ALL value listeners at the ref. |
| 140 | `off(ref, 'value', cb)` removes only the specific callback | ✓ | Sandbox aligned (M48); adjacent to #141 — the upstream `off` with the cb argument removes only the matching callback. Same probe (`rtdb-onvalue-unsub-equivalence.json` Case 2) confirms `off(ref, 'value', cb)` stops only that callback. |
| 141 | The returned unsubscribe function from `onValue(ref, cb)` is equivalent to `off(ref, 'value', cb)` | ✓ | Sandbox aligned (M48); oracle: `packages/conformance/observations/rtdb/rtdb-onvalue-unsub-equivalence.json` — `unsubReturnType: 'function'`, `unsubReturnedFnStopsListener: true` (the captured return value halted fires on write), `offRefValueCbStopsListener: true` (the same effect via `off(ref, 'value', cb)`), `bothFormsEquivalent: true`. |

### `query(ref, ...constraints)` + ordering / bounds / limits

| # | Behavior | Status | Probe |
|---|---|---|---|
| 142 | `query(ref, orderByChild('field'), limitToFirst(N))` returns a `Query` whose `get()` resolves a snapshot containing N children ordered by `field` | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-orderbychild-limit.json` — seeded 4 children with positions `[3,1,4,2]`, observed `orderedKeys: [{key:'a',pos:1}, {key:'b',pos:2}]` (first 2 in ascending order). Requires `.indexOn` declared in rules. |
| 143 | `orderByKey()` orders by the auto-id / numeric key | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-orderbykey-window.json` — seeded `{a,b,c,d,e}` in shuffled insertion order, observed `matchedKeys: ['b','c','d']` for `orderByKey() + startAt('b') + endAt('d')` (in key order). |
| 144 | `orderByValue()` orders by the primitive value of each child (for collections of primitives) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-orderbyvalue-numeric.json` — seeded `{alice:30, bob:10, carol:50, dave:20, eve:40}`, the prod call threw `Index not defined, add ".indexOn": ".value"` (so prod enforces an index requirement on `orderByValue()`); semantic ordering claim still holds, sandbox does not enforce indexes. |
| 145 | `equalTo(v)` filters children whose ordered field === v (returns 0, 1, or multiple matches — RTDB does NOT enforce uniqueness) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-equalto.json` — seeded `{red, blue, blue, green}`, observed `matchedKeys: ['k2', 'k3']` for `equalTo('blue')` (both blue children, none of the others). Additional probe: `packages/conformance/observations/rtdb-modular/rtdb-modular-equalTo-filter.json` (a..b..c groups) confirms `equalTo('b')` returns the two `b` children. |
| 146 | `startAt(v)` is **inclusive** (the child whose ordered value === v is included) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-startat-inclusive.json` — seeded positions `[1,2,3,4]`, observed `matched: [2,3,4]` for `startAt(2)` (cursor doc included). |
| 147 | `endAt(v)` is **inclusive** | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-orderbychild-window.json` — `startAt(2) + endAt(4)` matched positions `[2,3,4]` (endAt(4) included its boundary value). |
| 148 | `startAfter(v)` is **exclusive** | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json` — `startAfter(2) + endBefore(5)` matched positions `[3,4]` (cursor `2` dropped). |
| 149 | `endBefore(v)` is **exclusive** | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-startafter-endbefore-exclusive.json` — same probe; cursor `5` dropped. |
| 150 | `limitToFirst(N)` caps the result count from the start of the ordered range | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-orderbychild-limit.json` plus `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` (firstPositions `[1,2]`). |
| 151 | `limitToLast(N)` caps from the end | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` — observed `lastKeys: ['d','e'], lastPositions: [4,5]` for `limitToLast(2)` on a 5-child collection ordered by `pos`. |
| 152 | Listeners on a `Query` (`onValue(q, …)`) emit only the windowed snapshot — NOT the parent ref's full data | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-with-query.json` — seeded 3 children, watched first 2 by `pos`; observed 3 fires total: (1) initial `[a,b]`, (2) OUTSIDE-window write to `c/extra` did NOT fire, (3) INSIDE-window mutation of `a` re-fired, (4) new child `z` displaced `b` and re-fired. Outside-window writes are silent. |

### Sentinels — `serverTimestamp()` / `increment(n)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 153 | `serverTimestamp()` resolves server-side to a **number** (epoch milliseconds) — diverges from Firestore's `Timestamp` instance | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json` — observed `createdAtType: 'number', createdAt: 1779075391118` (i.e. a plain JS number, NOT a `Timestamp` object). |
| 154 | `serverTimestamp()` as a field value in `set` or `update` writes the `{".sv": "timestamp"}` sentinel; the read-back value is the resolved number | ✓ | oracle: `packages/conformance/observations/rtdb/rtdb-servertimestamp-resolves.json` — read-back showed `createdAtSentinelShape: false` (sentinel resolved server-side; client sees the number, not the `.sv` placeholder). |
| 155 | `increment(n)` against a **missing** field starts at 0 (so `increment(5)` lands as `5`) | ✓ | Sandbox aligned (modular `increment` export now present): `unit:modular/increment.test.ts` ("increment against a missing field starts from 0"); matches oracle `packages/conformance/observations/rtdb-modular/rtdb-modular-increment-from-missing.json` — observed `afterFirst: 5` from `increment(5)` against an absent `count` field. |
| 156 | `increment(n)` against an existing numeric field adds atomically; negative deltas subtract | ✓ | Sandbox aligned: `unit:modular/increment.test.ts` ("subsequent increments accumulate (positive then negative)" + "nested inside an update patch resolves per-field"); matches oracle `packages/conformance/observations/rtdb-modular/rtdb-modular-increment-from-missing.json` — observed `afterSecond: 8` (5+3) then `afterNegative: 6` (8-2). |
| 157 | Two concurrent `increment` calls interleave correctly (last-write-wins is NOT the contract — both deltas accumulate) | ? | hard to observe deterministically from a single client; documented contract |

### `runTransaction(ref, transactionUpdate, options?)` — optimistic concurrency

| # | Behavior | Status | Probe |
|---|---|---|---|
| 158 | Basic success — `runTransaction(ref, current => (current ?? 0) + 1)` resolves `{ committed: true, snapshot }` where `snapshot.val()` is the new value | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json` — observed `committed: true, snapVal: 1` after running `current => (current ?? 0) + 1` against an empty ref. |
| 159 | Returning `undefined` from the update fn **aborts** the transaction — resolves `{ committed: false }`, no write performed (RTDB-specific; distinct from Firestore where the only abort path is throwing) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-abort-undefined.json` — seeded `100` then transaction returned `undefined`; observed `committed: false, snapVal: null, afterValOnServer: 100` (existing value preserved). |
| 160 | The update fn is called with the CURRENT server value (may be `null` if the ref is empty); the fn's return value is the proposed new value | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json` — observed `seenCurrentValues: [null]` on first invocation against an empty ref (a single call, no speculative re-runs against `undefined`). NOTE — adjacent divergence pinned in `modular/oracle-conformance.test.ts`: for a SEEDED path, prod speculatively invokes the update fn twice (first with `null`, then the real value; `rtdb-modular-runtransaction-current-value-arg.json` `seededArgs.length: 2`) while the sandbox invokes once with the actual value. The argument-semantics claim of this row holds for the effective invocation on both sides. WARNING for update-fn authors: prod may invoke your fn first with `null` even when data exists — the pattern `if (current === null) return;` (abort-on-empty) silently loses writes on prod while working on the sandbox, and side effects inside the fn can run twice on prod. RESOLVED by the warm-client capture `rtdb-modular-runtransaction-warm-client-speculation`: a warm prod client (active listener + prior get) receives a SINGLE invocation with the cached value, exactly matching the sandbox. The cold-cache speculative double-call is an artifact of an empty client cache, which the always-warm in-process sandbox structurally never has; the sandbox behavior IS the warm-client contract. |
| 161 | Concurrent contention — if another client writes between the read and write, the update fn is retried with the new current value (typically up to 25 retries by default) | ? | hard to observe deterministically from a single client |
| 162 | Result snapshot's `.val()` reflects the committed value (or the existing value if aborted) | ✓ | oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-success.json` — observed `snapVal: 1` matching the committed value. |

### `goOnline` / `goOffline` — connection control

| # | Behavior | Status | Probe |
|---|---|---|---|
| 163 | `goOffline(db)` — accepted no-op on sandbox handles: there is no network connection in the local sandbox to toggle, so nothing is disconnected (we deliberately do NOT simulate a disconnect — pending writes, listeners, and `get()` keep working). Forwards to `firebase/database`'s `goOffline` on prod handles | ⚠ no network connection in the local sandbox to toggle | `unit:modular/fruit-aliases.test.ts` |
| 164 | `goOnline(db)` — accepted no-op on sandbox handles: there is no connection to reopen (see `goOffline`). Forwards to `firebase/database`'s `goOnline` on prod handles | ⚠ no network connection in the local sandbox to toggle | `unit:modular/fruit-aliases.test.ts` |

### `connectDatabaseEmulator` — emulator hook

| # | Behavior | Status | Probe |
|---|---|---|---|
| 165 | No-op on sandbox-target handles (the sandbox IS the local emulator) | — | Phase 3 |
| 166 | Forwards to `firebase/database`'s `connectDatabaseEmulator` on prod-target handles | — | Phase 3 |

### Transport, logging, and URL-reference exports

| # | Behavior | Status | Probe |
|---|---|---|---|
| 171 | `forceLongPolling()` — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (it never opens a real socket). Accepted so init code that calls it compiles + runs. Process-global setter with no `db` handle, so there is no prod handle to forward through | ⚠ transport selection not applicable to the in-process/worker sandbox | `unit:modular/fruit-aliases.test.ts` |
| 172 | `forceWebSockets()` — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (see `forceLongPolling`) | ⚠ transport selection not applicable to the in-process/worker sandbox | `unit:modular/fruit-aliases.test.ts` |
| 173 | `enableLogging(logger?, persistent?)` — accepted no-op: the sandbox has no modular-SDK-style logger to wire a level/sink into (it uses host-level `console` logging directly, matching `pyric/firestore`'s `setLogLevel`). Accepted so init code that calls it compiles + runs | ⚠ accepted no-op; no sandbox logger to wire into | `unit:modular/fruit-aliases.test.ts` |
| 174 | `refFromURL(db, url)` — real alias: parses the path out of the absolute database URL and delegates to `ref(db, path)`, so the returned ref resolves + reads exactly like `ref(db, path)`. Divergence: the sandbox is single-database with no host/namespace, so the URL's HOST is NOT validated against the handle (the real SDK throws if the host doesn't match the db's namespace); only the path is honored | ⚠ path resolves like `ref`; URL host/namespace not validated (single-database sandbox) | `unit:modular/fruit-aliases.test.ts` |

### `sandbox.*` — sandbox-only test driver

| # | Behavior | Status | Probe |
|---|---|---|---|
| 167 | `sandbox.setData(db, {path: value, ...})` bulk-loads data, bypassing rules | — | Phase 3 — mirror of firestore's `sandbox.seedDocuments` |
| 168 | `sandbox.setRules(db, rules)` loads rules into the underlying local environment; returns `LintResult` | — | Phase 3 |
| 169 | `sandbox.snapshotState(db)` dumps every path the local store has stored | — | Phase 3 |
| 170 | All `sandbox.*` methods throw on prod-target handles with `failed-precondition` | — | Phase 3 |

### Intentionally not implemented (modular SDK surface)

These exist in `firebase/database` but Pyric does not implement them:

| Name | Reason |
|---|---|
| IndexedDB persistence APIs | Persistence is owned by `pyric/sandbox`. |
| `.info/connected` reads | The sandbox has no real connection state to model. |
| `onDisconnect(ref).set(...)` / `.update(...)` / `.remove(...)` / `.cancel()` | Disconnect handlers require a real network channel. |
| `orderByPriority()` / `setPriority(ref, p)` / `setWithPriority(ref, v, p)` and the `.priority` model | Not modeled; default child ordering is `orderByKey`. Consumers needing priority use `firebase/database` directly. |


## Not supported yet

Tracked but not implemented yet. Each flips to ✓ as support lands.

| # | Behavior |
|---|---|
| M3 | `getDatabase(app)` builds a prod target; delegates to `firebase/database.getDatabase(app)` |
| M37h | Concurrent contention / retry-on-conflict — single-client sandbox doesn't model real concurrency; the documented "up to 25 retries" contract is degenerate (the fn is invoked once) |
| 94 | `getDatabase(ctx)` returns a tagged sandbox-target handle (frozen identity) |
| 95 | `getDatabase(sandbox)` returns a tagged sandbox-live handle (per-op identity) |
| 98 | Two `getDatabase(sandbox)` calls share state (same underlying `LocalEnvironment`) |
| 99 | Handle dispatch by `TARGET_SYMBOL` brand — refs route to their owning target via a `refToTarget` WeakMap (mirror of firestore's pattern) |
| 105 | Unknown ref (not produced by this package) → `TypeError` in shim ops |
| 165 | No-op on sandbox-target handles (the sandbox IS the local emulator) |
| 166 | Forwards to `firebase/database`'s `connectDatabaseEmulator` on prod-target handles |
| 167 | `sandbox.setData(db, {path: value, ...})` bulk-loads data, bypassing rules |
| 168 | `sandbox.setRules(db, rules)` loads rules into the underlying local environment; returns `LintResult` |
| 169 | `sandbox.snapshotState(db)` dumps every path the local store has stored |
| 170 | All `sandbox.*` methods throw on prod-target handles with `failed-precondition` |
