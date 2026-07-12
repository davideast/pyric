<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/firestore` compatibility matrix

**146 of 166 tracked behaviors match production Firebase (88%).**

## Status legend

| Status | Meaning |
|---|---|
| ✓ | Matches Firebase |
| ⚠ | Documented difference |
| — | Not supported yet |
| ? | Not verified yet |

## `getFirestore(target)` — initializer

| # | Behavior | Status | Probe |
|---|---|---|---|
| 1 | `getFirestore(ctx)` returns a tagged sandbox-target handle (frozen identity) | ✓ | `unit:sandbox-target.test.ts` |
| 2 | `getFirestore(sandbox)` returns a tagged sandbox-live handle (per-op identity) | ✓ | `unit:sandbox-live-identity.test.ts` |
| 3 | `getFirestore(app)` returns a tagged prod target | ✓ | `unit:prod-target.test.ts` |
| 4 | `getFirestore(undefined)` — wrapped in the playground preview to default to the sandbox; raw call delegates to prod which throws `app/no-app` | ✓ (wrap) | `playground:firestore-bare-getfirestore` — fix from PR #397 + oracle: `packages/conformance/observations/firestore/firestore-bare-getfirestore-no-default-app.json` (`code: 'app/no-app'` against blockingfun, fb-js-sdk 12.13.0 — confirms prod throw shape) |
| 5 | Two `getFirestore(sandbox)` calls share state (same underlying `LocalEnvironment`) | ✓ | `unit:sandbox-live-identity.test.ts` ("two handles share the same sandbox") |
| 6 | Handle dispatch by `TARGET_SYMBOL` brand — refs/queries route to their owning target via `refToTarget` WeakMap | ✓ | `unit:sandbox-target.test.ts` ("throws TypeError for refs not produced by this package") |

## Path constructors — `doc` / `collection` / `collectionGroup`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 7 | `doc(db, path)` returns a tagged `DocumentReference` with `id` / `path` | ✓ | `unit:sandbox-target.test.ts` |
| 8 | `doc(db, 'a', 'b', 'c', 'd')` joins variadic path segments | ✓ | `unit:sandbox-target.test.ts` |
| 9 | `collection(db, path)` returns a tagged `CollectionReference` | ✓ | `unit:sandbox-target.test.ts` |
| 10 | `doc(coll, id)` appends under a collection ref | ✓ | `unit:sandbox-target.test.ts` |
| 11 | `doc(coll)` (no id) mints an auto-id `DocumentReference` | ✓ | `unit:sandbox-target.test.ts` |
| 12 | `collection(docRef, name)` builds a subcollection ref | ✓ | `unit:sandbox-target.test.ts` |
| 13 | `collectionGroup(db, id)` returns a query spanning every collection with that id | ✓ | `unit:sandbox-target.test.ts` ("gathers documents across every parent collection") |
| 14 | Unknown ref (not produced by this package) → `TypeError` with "unrecognized reference" | ✓ | `unit:sandbox-target.test.ts` |
| 15 | Held doc/coll ref under `sandbox-live` re-resolves to the chainable under the current user at op time (via rebuild closure) | ✓ | `unit:sandbox-live-identity.test.ts` ("held doc ref re-resolves under the current user") |

## `getDoc(ref)` — single-doc read

| # | Behavior | Status | Probe |
|---|---|---|---|
| 16 | Returns `DocumentSnapshot` with `id`, `exists` (method form), `data()` | ✓ | `unit:sandbox-target.test.ts` |
| 17 | `snap.exists` is normalized to method form (`snap.exists()` returns boolean) to match the modular SDK | ✓ | `playground:firestore-onsnapshot` (bundled, assertion-shape compat) + `playground:firestore-row-17-snap-exists-method` (one-claim) |
| 18 | `snap.data()` returns `undefined` for missing doc | ✓ | `unit:sandbox-target.test.ts` |
| 19 | `snap.ref` is tagged so it routes through `targetOf` in follow-up ops | ✓ | `unit:sandbox-target.test.ts` |
| 20 | Re-evaluates rules under current user on every call (sandbox-live) — read denied throws `permission-denied` | ✓ | `unit:sandbox-live-identity.test.ts` ("doc read denied when current user lacks read access"), oracle: `packages/conformance/observations/firestore/firestore-read-denied-error-code.json` (prod `getDoc` on a denied path throws a `FirebaseError` with `.code === 'permission-denied'`, `.message === 'Missing or insufficient permissions.'`, `instanceof Error`) |
| 21 | Rules denial throws `SandboxError('permission-denied', …)` on sandbox; `FirebaseError('permission-denied')` on prod | ⚠ | divergence: same code, different class — both expose `.code === 'permission-denied'`. Oracle-locked: `packages/conformance/observations/firestore/firestore-rules-denied-error.json` — prod throws a `FirebaseError` (name + constructor name both `FirebaseError`), `.code === 'permission-denied'`, `.message === '7 PERMISSION_DENIED: Missing or insufficient permissions.'`, and the value is an `instanceof Error`. |

## `getDocs(query)` — bulk read

| # | Behavior | Status | Probe |
|---|---|---|---|
| 22 | Returns `QuerySnapshot` with `size`, `empty`, `docs` (`QueryDocumentSnapshot[]`) | ✓ | `unit:sandbox-target.test.ts`, `playground:firestore-query` |
| 23 | Each `snap.docs[i].ref` is tagged for follow-up ops | ✓ | `unit:sandbox-target.test.ts` |
| 24 | Sandbox-live: re-evaluates filters under the current user (different docs visible per identity) | ✓ | `unit:sandbox-live-identity.test.ts` ("query results re-evaluate under the current user") |
| 24a | **Query reads enforce security rules (FS-B1)** — a deny-all / auth-gated rule set throws `permission-denied`. Pre-FS-B1 query reads went through the rules-bypassing `listDocuments` and returned the whole collection. | ✓ | `unit:admin-compat/query-rules-enforcement.test.ts` (deny-all + auth-gated `getDocs`/aggregate), `unit:admin-compat/per-op-auth.test.ts` ("Query.get enforces rules") |
| 24b | **Enforcement follows production's QUERY-PROOF model (RULES-B11)** — "rules are not filters": a doc-data-dependent `list` rule (`resource.data.visibility == 'public'`, `resource.data.owner == request.auth.uid`) is ALLOWED when the query's `where()` equalities discharge it and the whole query is `permission-denied` otherwise — never silently truncated to the readable subset. Per-doc `get` rules do NOT filter query results (the `list` rule alone governs queries — granular-operations docs). Applies to `getDocs`, aggregates, and `onSnapshot` alike. Pre-fix: rules-as-filters (per-doc `get` omission) + blanket denial of every doc-data-dependent list, even provable ones. | ✓ | `unit:firestore/query-proof-enforcement.test.ts` (provable/unprovable getDocs + onSnapshot, owner-pinned uid, get-rules-don't-filter, request.query.limit; verified failing pre-fix), `unit:simulator/local-environment.test.ts` (Slice 6 — flipped from per-doc-filter assertions); prod truth: firebase.google.com/docs/firestore/security/rules-query |
| 24c | Query-proof **prover scope is conservative** — only top-level AND-conjunct `resource.data.<field> == <literal>` predicates (with `request.auth.uid` pinned to the caller) are dischargeable by `where(field, '==', value)`. Disjunctions over doc data, inequality/range proofs (`resource.data.score > 10` + `where('score','>',10)`), `in`-operand proofs, and nested-path predicates conservatively DENY the whole query where production's prover may allow it. Never a false ALLOW — the conservative direction prod also takes for unprovable queries. | ⚠ | `unit:rules/simulator/query-proof.test.ts` (conservative-reject cases); divergence is deny-only (no rule-violating doc can leak) |
| 25 | Empty result for a collection with no docs (`size === 0`, `empty === true`) | ✓ | `unit:sandbox-target.test.ts` |

## `setDoc(ref, data[, options])` — full write

| # | Behavior | Status | Probe |
|---|---|---|---|
| 26 | No options → replaces the existing document entirely | ✓ | `unit:sandbox-target.test.ts` ("setDoc default replaces") |
| 27 | `{ merge: true }` → **deep-merges nested maps** (FS-B6), preserving unspecified fields at every level: `setDoc({a:{b:2}}, {merge:true})` over `{a:{c:1}}` yields `{a:{b:2,c:1}}`. Pre-FS-B6 the wrapper shallow-replaced the whole `a` map. | ✓ | `unit:sandbox-target.test.ts`, `unit:admin-compat/field-path-merge.test.ts` (FS-B6 nested deep-merge; verified failing pre-fix) |
| 28 | `{ mergeFields: [...] }` → writes only the listed **dot-separated field paths** into the existing doc (FS-B6); other keys in `data` are ignored, other fields in the existing doc preserved. `mergeFields: ['a.b']` reaches into a nested map. | ✓ | `unit:sandbox-target.test.ts`, `unit:admin-compat/field-path-merge.test.ts` (dotted mergeField) |
| 29 | Passing both `merge` and `mergeFields` — `mergeFields` wins on sandbox (matches JS SDK effective behavior) | ✓ | `unit:sandbox-target.test.ts` |
| 30 | Sentinels (`serverTimestamp`, `increment`, `arrayUnion`, `arrayRemove`, `deleteField`) resolve in the same call | ✓ | `unit:sandbox-target.test.ts`, `playground:firestore-sentinels`, oracle: `packages/conformance/observations/firestore/firestore-row-30-sentinels-in-setdoc.json` — `setDoc({createdAt: serverTimestamp(), count: 5, tags: ['a']})` followed by `getDoc` returns `createdAt` as a `Timestamp` instance (constructor name `Timestamp`, has `seconds` + `nanoseconds`), `count === 5` (number), `tags === ['a']`. Sentinels resolve server-side and the follow-up read sees concrete values, not the sentinel placeholders. |
| 31 | Converter (via `withConverter`) runs `toFirestore(data)` before the write | ✓ | `unit:sandbox-target.test.ts` ("withConverter on a DocumentReference round-trips") |
| 32 | Rules-denied write throws `permission-denied` (sandbox) / `FirebaseError` (prod) | ✓ | `unit:sandbox-target.test.ts` ("getDoc denies when rules reject"), `playground:rules-data-validation`, oracle: `packages/conformance/observations/firestore/firestore-write-denied-error-code.json` (prod `setDoc` on a denied path throws a `FirebaseError` with `.code === 'permission-denied'`, `.message === '7 PERMISSION_DENIED: Missing or insufficient permissions.'`, `instanceof Error`) |

## `updateDoc(ref, data)` — partial write

| # | Behavior | Status | Probe |
|---|---|---|---|
| 33 | Merges `data` into the existing doc; missing fields preserved. **Top-level keys are dot-separated FieldPaths** (FS-B5): `updateDoc({'a.b': 2})` sets the nested leaf `a.b` (preserving `a.c`), not a literal `"a.b"` key; a single-segment map value replaces that field wholesale; `deleteField()` at a dotted path removes the nested leaf. | ✓ | `unit:sandbox-target.test.ts`, `unit:admin-compat/field-path-merge.test.ts` (FS-B5 dot-path nested write + delete; verified failing pre-fix) |
| 34 | Throws `not-found` (sandbox) / `FirebaseError('not-found')` (prod) on missing doc | ✓ | `unit:sandbox-target.test.ts` (implicit in writes-fail-on-missing tests), oracle: `packages/conformance/observations/firestore/firestore-updatedoc-missing-error.json` (prod throws `FirebaseError` with `code: 'not-found'`, message `"5 NOT_FOUND: No document to update: …"`) |
| 35 | Does NOT run a converter — partial updates don't have a typed home (matches JS SDK) | ✓ | (documented in `withConverter` block) |
| 36 | Sentinels resolve mid-update (`increment(1)` against an existing numeric field, etc.) | ✓ | `unit:sandbox-target.test.ts`, `playground:firestore-sentinels`, oracle: `packages/conformance/observations/firestore/firestore-row-36-sentinels-in-updatedoc.json` — after `setDoc({count: 5, tags: ['a'], oldField: 'keep-then-remove'})` then `updateDoc({count: increment(3), tags: arrayUnion('b'), oldField: deleteField()})`, the follow-up `getDoc` returns `count: 8`, `tags: ['a', 'b']`, and `oldField` absent from the doc (the deleteField sentinel actually removes the key). All three sentinels apply in one mid-update commit. |
| 37 | Sandbox-live: each call re-evaluates auth (alice → bob between writes uses bob's auth) | ✓ | `unit:sandbox-live-identity.test.ts` ("updateDoc re-evaluates auth per call") |

## `deleteDoc(ref)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 38 | Removes the document; subsequent `getDoc` returns `exists()===false` | ✓ | `unit:sandbox-target.test.ts` |
| 39 | Idempotent — `deleteDoc` on missing doc resolves without throwing (matches JS SDK) | ✓ | `unit:deletedoc-missing.test.ts`, `playground:firestore-deletedoc-missing`, oracle: `packages/conformance/observations/firestore/firestore-deletedoc-missing.json` |
| 40 | Rules-denied delete throws `permission-denied` | ✓ | `unit:sandbox-target.test.ts` (rules-reject branch), oracle: `packages/conformance/observations/firestore/firestore-delete-denied-error-code.json` (prod `deleteDoc` on a denied path throws a `FirebaseError` with `.code === 'permission-denied'`, `.message === '7 PERMISSION_DENIED: Missing or insufficient permissions.'`, `instanceof Error`) |

## `addDoc(coll, data)` — auto-id write

| # | Behavior | Status | Probe |
|---|---|---|---|
| 41 | Returns a tagged `DocumentReference` with auto-id | ✓ | `unit:sandbox-target.test.ts` |
| 42 | Returned ref is usable in subsequent ops (`getDoc`, `setDoc`, `onSnapshot`) | ✓ | `unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-row-42-adddoc-returned-ref-usable.json` — `addDoc(coll, {v:1})` returned a ref whose `.id` is a 20-char auto-id; `getDoc(ref)` returned `{v:1}` (round-trip), `setDoc(ref, {v:2})` overwrote without error, follow-up `getDoc` returned `{v:2}`, and `onSnapshot(ref, cb)` registered cleanly and fired once with `{exists:true, v:2}`. All four follow-up ops succeed on the returned ref without re-tagging. |
| 43 | Sandbox-live: returned ref is a *live* ref (rebuild closure recorded) so follow-ups re-resolve auth | ✓ | `unit:sandbox-live-identity.test.ts` ("addDoc result is a tagged live ref") |
| 44 | Converter on the parent collection propagates onto the returned ref | ✓ | `unit:sandbox-target.test.ts` ("addDoc through a converted collection") |
| 45 | Auto-id format — prod uses 20-char base64-ish IDs; sandbox uses `pyric-admin`'s auto-id (also opaque, distinct format) | ⚠ format | divergence: IDs are opaque on both sides; format differs but consumer code never parses them. Oracle-locked: `packages/conformance/observations/firestore/firestore-adddoc-autoid-format.json` — prod auto-ids are 20 characters, all alphanumeric (mixed upper, lower, digits; no other chars). Example: `S3PJENMPOk4qcDXol8Ez`. |

## `withConverter` — typed refs

| # | Behavior | Status | Probe |
|---|---|---|---|
| 46 | `withConverter(docRef, converter)` returns a shell that runs `toFirestore` on writes, `fromFirestore` on reads | ✓ | `unit:sandbox-target.test.ts` |
| 47 | `withConverter(collRef, converter)` propagates onto `doc(typedColl, id)` | ✓ | `unit:sandbox-target.test.ts` |
| 48 | `withConverter(collRef, converter)` propagates through `query(typedColl, …)` + `getDocs()` | ✓ | `unit:sandbox-target.test.ts` |
| 49 | `withConverter(ref, null)` strips the converter, returns the underlying untyped view | ✓ | `unit:sandbox-target.test.ts` |
| 50 | Original untyped ref keeps its identity after `withConverter(ref, c)` (two views, one path) | ✓ | `unit:sandbox-target.test.ts` |
| 51 | `setDoc` through a converted ref invokes `toFirestore(data)` | ✓ | `unit:sandbox-target.test.ts` |
| 52 | `getDoc` through a converted ref invokes `fromFirestore(snapshot)`; `.data()` returns the typed model | ✓ | `unit:sandbox-target.test.ts` |
| 53 | `updateDoc` through a converted ref does NOT invoke the converter | ✓ | (documented constraint; matches JS SDK) |

## Query construction — `query` / `where` / `or` / `and` / `orderBy` / `limit`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 54 | `query(coll, where(…), orderBy(…), limit(…))` composes constraints in order | ✓ | `unit:sandbox-target.test.ts`, `playground:firestore-query` |
| 55 | `where(field, op, value)` — all 10 ops: `<`, `<=`, `==`, `>=`, `>`, `!=`, `in`, `not-in`, `array-contains`, `array-contains-any` | ✓ | `unit:sandbox-target.test.ts` (canonical query test) |
| 55a | **Existence + null filter guards (FS-B7)** — a doc missing the filter field is never returned by `==`/`<`/`<=`/`>`/`>=`/`in`/`!=`/`not-in`; `!=` and `not-in` additionally exclude null-valued docs and require the field to exist; a `null` in a `not-in` operand list matches nothing. Pre-FS-B7, `!=`/`not-in` matched missing-field and null docs. | ✓ | `unit:admin-compat/inequality-existence-guards.test.ts` (verified failing pre-fix) |
| 56 | `or(...)` composite — at least one sub-filter matches | ✓ | `unit:sandbox-target.test.ts` ("or() matches docs where any sub-filter matches"), oracle: `packages/conformance/observations/firestore/firestore-or-composite.json` (4 seeded docs; `or(where('x','==',1), where('y','==',2))` returned the exact union `{match-both, match-x, match-y}` — no implicit index required against cloud Firestore) |
| 57 | `and(...)` composite — every sub-filter matches | ✓ | `unit:sandbox-target.test.ts` ("and() requires every sub-filter"), oracle: `packages/conformance/observations/firestore/firestore-and-composite.json` (4 seeded docs; `and(where('x','==',1), where('y','==',2))` returned only the intersection `{match-both}`) |
| 58 | Nested `or` / `and` — full composite tree | ✓ | `unit:sandbox-target.test.ts` ("nested or/and — the canonical composite pattern"), oracle: `packages/conformance/observations/firestore/firestore-nested-or-and-composite.json` (6 seeded docs; `or(and(where('x','==',1), where('y','==',2)), where('z','==',3))` returned `{inner-and-match, outer-z-match, both-branches}` — exact boolean union as predicted) |
| 59 | `orderBy(field, 'asc'\|'desc')` — direction parameter | ✓ | `unit:sandbox-target.test.ts` |
| 59a | **Canonical type-order comparison (FS-B3)** — orderBy + range filters compare by Firestore's canonical type order (`null < bool < number < timestamp < string < bytes < ref < geopoint < array < map`), then within-type; numbers sort numerically (not lexicographically), NaN sorts as the smallest number, and range filters (`<`/`<=`/`>`/`>=`) only match same-type values. Pre-FS-B3 the comparator fell back to `String(a).localeCompare(String(b))`. | ✓ | `unit:admin-compat/canonical-type-order.test.ts` (cross-type ranking, numeric sort, NaN, timestamps, arrays; verified failing pre-fix) |
| 59b | **orderBy excludes missing-field docs (FS-B3)** — a doc lacking an orderBy field is omitted from the result (matches prod); pre-fix it was sorted in via `compareValues(undefined, …)`. | ✓ | `unit:admin-compat/canonical-type-order.test.ts` ("excludes the missing-field doc") |
| 59c | **Implicit orderBy + `__name__` tiebreak (FS-B8)** — the query's sort is normalized to: explicit orderBy clauses, then an implicit order on each inequality-filtered field, then a final document-key (`__name__`) clause. Equal-valued docs sort deterministically by key; a `where('x','>',v)` with no explicit orderBy returns docs ordered by `x`. Mirrors `clones/.../core/query.ts:queryNormalizedOrderBy`. Pre-FS-B8 equal-valued docs were nondeterministic and inequality results came back in insertion order. | ✓ | `unit:admin-compat/implicit-order-name.test.ts` (key tiebreak, snapshot-cursor disambiguation, implicit inequality order; verified failing pre-fix) |
| 60 | `limit(n)` — caps result count | ✓ | `unit:sandbox-target.test.ts` |
| 61 | `limitToLast(n)` — trailing n in ordered result (requires `orderBy`). Sandbox: the no-orderBy precondition throws a `FirestoreError` with `.code === 'invalid-argument'` (FS-B16; pre-fix plain `Error`s). Prod: the same precondition throws `.code === 'unimplemented'` | ⚠ | divergence, oracle-locked by `packages/conformance/observations/firestore/firestore-limittolast-preconditions.json`: prod's no-orderBy `limitToLast` throws code `unimplemented`, the sandbox throws `invalid-argument`. Trailing-window semantics with `orderBy` conform (observed `["b"]` matches). Both sides pinned in `oracle-conformance.test.ts`. Cursor/empty-snapshot precondition codes remain per `unit:sandbox-target.test.ts` + `unit:admin-compat/cursors.test.ts` (verified failing pre-fix) |
| 62 | Composite filters AND with other constraints — `query(coll, or(...), orderBy(...), limit(...))` | ✓ | `unit:sandbox-target.test.ts` |
| 63 | Passing `orderBy` / `limit` into `or()` / `and()` → `TypeError` | ✓ | `unit:sandbox-target.test.ts` |
| 64 | Zero-arg `or()` / `and()` → `TypeError` | ✓ | `unit:sandbox-target.test.ts` |
| 65 | Chained queries re-tag for further constraints (`query(query(coll, where), orderBy)`) | ✓ | `unit:sandbox-target.test.ts` ("chained queries are taggable") |
| 66 | Index validation against `firestore.indexes.json` — sandbox uses `LocalEnvironment`'s lint pass; prod has its own server-side validation | ⚠ | divergence: sandbox can mis-pass a query that prod would reject at the server with `failed-precondition` if no index exists |

## Cursor pagination — `startAt` / `startAfter` / `endAt` / `endBefore`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 67 | `startAt(...values)` — inclusive value cursor (one positional per `orderBy` clause) | ✓ | `unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-cursor-startat-inclusive.json` (5 seeded docs at pos=[1..5]; `query(c, orderBy('pos'), startAt(3))` returned exactly `[pos-3, pos-4, pos-5]` — the cursor doc IS included) |
| 68 | `startAfter(...values)` — exclusive value cursor | ✓ | `unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-cursor-startafter-exclusive.json` (5 seeded docs at pos=[1..5]; `query(c, orderBy('pos'), startAfter(3))` returned exactly `[pos-4, pos-5]` — the cursor doc is EXCLUDED) |
| 69 | `endAt(...values)` — inclusive end cursor | ✓ | `unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-cursor-endat-inclusive.json` (5 seeded docs at pos=[1..5]; `query(c, orderBy('pos'), endAt(3))` returned exactly `[pos-1, pos-2, pos-3]` — the cursor doc IS included) |
| 70 | `endBefore(...values)` — exclusive end cursor | ✓ | `unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-cursor-endbefore-exclusive.json` (5 seeded docs at pos=[1..5]; `query(c, orderBy('pos'), endBefore(3))` returned exactly `[pos-1, pos-2]` — the cursor doc is EXCLUDED) |
| 71 | `startAt(snapshot)` overload — extracts orderBy field values from the snapshot, positioning against the NORMALIZED orderBy (implicit `__name__`), so it disambiguates equal-valued docs and is **legal without an explicit orderBy** (FS-B8). A VALUE cursor with more values than explicit orderBy clauses throws `invalid-argument` ("Too many arguments"). | ✓ | `unit:sandbox-target.test.ts`, `unit:admin-compat/implicit-order-name.test.ts` (snapshot cursor w/o orderBy), `unit:admin-compat/cursors.test.ts` (value-cursor too-many-args throws with `.code`) |
| 72 | `endAt(snapshot)` overload | ✓ | `unit:sandbox-target.test.ts` ("endAt(snapshot) trims to-and-including the anchor") |
| 73 | `startAfter + limit` — canonical pagination pattern | ✓ | `unit:sandbox-target.test.ts` |

## Aggregates — `getCountFromServer` / `getAggregateFromServer` / `count` / `sum` / `average`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 74 | `getCountFromServer(query)` returns `{ data: () => ({ count: N }) }` | ✓ | `unit:sandbox-target.test.ts` |
| 75 | `getCountFromServer` honors `where` filters | ✓ | `unit:sandbox-target.test.ts` |
| 76 | `getAggregateFromServer(query, spec)` returns `{ data: () => Record<alias, number\|null> }` | ✓ | `unit:sandbox-target.test.ts` |
| 77 | `count()` / `sum(field)` / `average(field)` compose under one spec | ✓ | `unit:sandbox-target.test.ts` |
| 78 | `average` returns `null` on empty input (matches JS SDK) | ✓ | `unit:sandbox-target.test.ts` |
| 79 | Aggregates count documents server-side without paying read cost per doc in prod; sandbox computes locally (no cost model) | ⚠ | divergence: cost behavior differs, observable shape identical. Oracle-locked: `packages/conformance/observations/firestore/firestore-count-aggregate-shape.json` — `getCountFromServer().data()` returns `{ count: <number> }` (single key, no other fields). Empty query returns `count: 0` (not `null`/`undefined`); seeded 3 docs returns `count: 3`; filtered query honors the `where` constraint (`count: 2`). |

## `onSnapshot(refOrQuery, …)` — listeners

| # | Behavior | Status | Probe |
|---|---|---|---|
| 80 | `onSnapshot(docRef, cb)` fires the initial snapshot **asynchronously** — never synchronously during the registering call. Prod empirically lands after a `setTimeout(0)` macrotask (the fire travels the network listener channel); the sandbox defers through its delivery scheduler (microtask). The matrix contract is "asynchronous, never during register", not "exactly the next microtask" | ✓ | Aligned via the listener delivery scheduler (`src/sandbox/firestore/local-environment.ts`): the initial fire is enqueued and delivered on a microtask, never during register — closing the divergence this row previously documented (the sandbox used to fire synchronously during registration; the sync-body tests were migrated to the flush/await idiom). Machine-checked against `packages/conformance/observations/firestore/firestore-row-80-onsnapshot-fires-initial.json` (`firstFireSyncDuringRegister: false`, fire count + contents) in `oracle-conformance.test.ts`; also `unit:sandbox-target.test.ts`, `playground:firestore-onsnapshot` (bundled) + `playground:firestore-row-80-onsnapshot-fires-initial` (one-claim). |
| 81 | `onSnapshot(query, cb)` fires on collection writes | ✓ | `unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-row-81-onsnapshot-query-fires-on-write.json` — listener on `query(coll)` saw 1 initial fire (empty, `size:0`), then one fire per write: `addDoc` → `size:1`, `setDoc(coll, 'known-id')` → `size:2`, `deleteDoc(addedRef)` → `size:1`. Total 4 fires, each reflecting the current collection state. Every collection-level write produces a distinct fire. (Note: this oracle used a *filterless* `query(coll)`, which masked FS-B2 — see row 81a.) |
| 81a | **Filtered listeners honor `where` / `orderBy` / `limit` (FS-B2)** — `onSnapshot(query(coll, where(…), orderBy(…), limit(…)), cb)` delivers the same membership as `getDocs(sameQuery)`: non-matching docs are excluded on the initial fire and on writes; ordering + limit are applied. Pre-FS-B2 the `SnapshotTarget` dropped all constraints and delivered the whole collection. | ✓ | `unit:onsnapshot-query-constraints.test.ts` (filtered/ordered/limited listeners; verified failing pre-fix) |
| 81b | **Listener `.data()` matches `getDoc` shape (FS-B10)** — the `onSnapshot` doc + query snapshot path runs the same read-path translation as `getDoc`/`getDocs`, so `snap.data().createdAt` is a compat `Timestamp` (`{seconds, nanoseconds}`), not the rules-internal wrapper (`{seconds, nanos}` + `typeName`, no `nanoseconds`). Pre-FS-B10 a listener leaked the internal shape while the single-doc read returned the compat shape. | ✓ | `unit:simulator/listener-read-translation.test.ts` (doc + query listener Timestamp shape; verified failing pre-fix) |
| 82 | Initial fire for a missing doc has `exists() === false` and `data() === undefined` | ✓ | `playground:firestore-onsnapshot` (bundled) + `playground:firestore-row-82-onsnapshot-missing-initial` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-82-onsnapshot-missing-initial.json` — single initial fire with `snap.exists() === false`, `snap.data() === undefined`, `hasPendingWrites: false`, `fromCache: false`. The missing-doc fire is server-confirmed, not a cache speculation. |
| 83 | Returned `Unsubscribe` stops further fires | ✓ | `unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-row-83-unsubscribe-stops-fires.json` — pre-unsubscribe write fired the listener (initial fire + write fire = 2 fires); after `unsub()`, a subsequent `setDoc` produced 0 additional fires (`postUnsubFireCount: 0`). Unsubscribe is durable; no fires arrive on the released callback after a 1.5s settle window. |
| 84 | Observer object form `{next, error, complete}` works alongside the function form. **Partial observers are accepted — `{ error: fn }` with no `next` registers and routes denials to `error` (FS-B14, `isPartialObserver` semantics from upstream `api/observer.ts`); pre-fix it was misrouted as `SnapshotListenOptions` and threw "missing next handler".** | ✓ | oracle: `packages/conformance/observations/firestore/firestore-row-84-observer-object-form.json` — registered two listeners on the same doc: one as a bare function `(snap) => …`, one as `{next, error, complete}`. Both fired once on initial (`{v:0}`) and again after a write (`{v:1}`), capturing identical data. `error` never fired (no rule denial), `complete` never fired on `unsub()` (Firebase treats unsubscribe as a teardown, not a "complete" signal — the observer's `complete` callback is reserved for terminal stream end, which `onSnapshot` does not produce). The two registration shapes are interchangeable for fire dispatch. `unit:onsnapshot-observer-discriminator.test.ts` (error-only observer; verified failing pre-fix) |
| 85 | `SnapshotListenOptions.includeMetadataChanges` — one write yields the pending-write local echo (`hasPendingWrites: true`) then, for metadata listeners, the settled ack fire: default listener 2 fires, metadata listener 3 | ✓ | Aligned via the listener delivery scheduler (`src/sandbox/firestore/local-environment.ts` + `snapshot-listeners.ts`): the write echo carries `hasPendingWrites: true` and `includeMetadataChanges` listeners receive the settled metadata-only ack, reproducing prod's recorded 2/3-fire sequences exactly. Machine-checked against `packages/conformance/observations/firestore/firestore-include-metadata-changes.json` in `oracle-conformance.test.ts` (fire counts and per-fire `hasPendingWrites` sequence asserted from the capture) |
| 86 | Snapshot's `.ref` / `.docs[i].ref` are tagged so consumer code can pass them to follow-up ops | ✓ | `unit:sandbox-target.test.ts` |
| 87 | Sandbox-live: listener registered as alice keeps emitting alice's view after `setUser → bob` (identity frozen at subscribe) | ✓ | `unit:sandbox-live-identity.test.ts` ("listener registered as alice keeps emitting alice's view") |
| 88 | Sandbox-live: listener registered as anonymous keeps firing after sign-in (anonymous → signed-in identity persists per listener) | ✓ | `unit:sandbox-live-identity.test.ts` ("listener registered as anonymous on /public keeps firing after sign-in") |
| 89 | Snapshot's ref is usable in follow-up ops under the new user (the ref is live, the listener identity is frozen — distinct) | ✓ | `unit:sandbox-live-identity.test.ts` ("snapshot ref is usable in subsequent ops under the new user"), oracle: `packages/conformance/observations/firestore/firestore-row-89-snapshot-ref-usable.json` — captured `snap.ref` from a docRef listener's first fire and `snap.docs[0].ref` from a query listener's first fire; both refs round-trip via `getDoc` (returning the same data) and `setDoc` (writes succeed and a follow-up `getDoc` confirms the new payload). `snap.ref.path` equals the original `doc(coll, id).path`. Both snap-ref shapes are first-class refs in prod, matching sandbox's tagged-ref guarantee. |
| 90 | Preview tree mounts the user's component exactly once per session load — no observer subscriptions leak across parallel `AppPreview` instances. Root cause: `PlaygroundPage` rendered both `WorkspacePanel`'s and the mobile `AppPanel`'s `AppPreview` unconditionally (the latter `md:hidden` on desktop but still mounted), producing two live preview trees subscribing in parallel. Fixed by gating `AppPanel` on `useIsMobile() && mobileTab === 'app'`. | ✓ | `playground:preview-single-mount` |

## `runTransaction(db, fn)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 91 | Atomic read-write — all reads in `fn` see a consistent snapshot, writes commit together | ✓ | `unit:sandbox-target.test.ts`, `playground:firestore-transaction` |
| 92 | Identity is frozen at `runTransaction` start — mid-transaction `setUser` does NOT re-auth in-flight reads | ✓ | (documented invariant) |
| 93 | Retry behavior — prod retries on contention up to 5 times; sandbox is single-threaded, no contention possible | ⚠ | divergence: contention story not modeled; sandbox just runs once |
| 94 | Throws `FirebaseError('permission-denied')` on rule denial inside the transaction (the inner write's denial — not a generic `aborted`). Sandbox throws `FirestoreCompatError` with the same `code: 'permission-denied'` | ✓ | `unit:sandbox-target.test.ts` (writes-reject branch), oracle: `packages/conformance/observations/firestore/firestore-transaction-rules-denied-error.json` (prod throws `FirebaseError` with `code: 'permission-denied'`, NOT `aborted`; the inner callback ran once and the rules-rejected write surfaces as a regular permission-denied at commit) |

## `writeBatch(db)`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 95 | `batch.set` / `batch.update` / `batch.delete` queue mutations | ✓ | `unit:sandbox-target.test.ts`, `playground:firestore-batch` |
| 96 | `batch.commit()` applies all queued writes atomically — success path commits all queued mutations together; failure path (one write violating rules) rejects the **whole** batch with no partial application | ✓ | `unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-row-96-batch-commit-atomic.json` — success path: a batch with `set` (fresh doc), `update` (existing doc), and `delete` (existing doc) all land in a single commit (`allApplied: true`). Failure path: a batch with one write targeting a path **outside** `pyric_oracle/*` rejects with `code: 'permission-denied'` and leaves the would-have-set doc absent and the would-have-updated doc at its original value (`noPartialApply: true`) — atomicity verified end-to-end. |
| 97 | Batch is tagged on construction — passing a prod-target batch into a sandbox op (or vice-versa) is a type error | ✓ | (route table consistency) |
| 98 | Batch identity is frozen at construction (per current implementation) | ✓ | (documented invariant) |

## Sentinels — `serverTimestamp` / `increment` / `arrayUnion` / `arrayRemove` / `deleteField` / `FieldValue` / `Timestamp`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 99 | `serverTimestamp()` resolves to a `Timestamp` after the write commits | ✓ | `unit:sandbox-target.test.ts`, `playground:firestore-sentinels` (bundled) + `playground:firestore-row-99-servertimestamp-resolves` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-99-servertimestamp-resolves-to-timestamp.json` — `setDoc({at: serverTimestamp()})` then `getDoc` yields `at instanceof Timestamp === true`, `constructor.name === 'Timestamp'`, with both `.seconds` (number) and `.nanoseconds` (number) present. |
| 100 | `increment(n)` atomically bumps a numeric field; `null`/missing field starts from 0 | ✓ | `unit:sandbox-target.test.ts`, `playground:firestore-sentinels` (bundled) + `playground:firestore-row-100-increment-bumps-numeric` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-100-increment-bumps-numeric.json` — `setDoc` with no `count` field then `updateDoc({count: increment(5)})` yields `count === 5` (starts from 0). Follow-up `increment(3)` → 8, then `increment(-2)` → 6 (negative deltas apply, increments accumulate). |
| 101 | `arrayUnion(...values)` de-dupes against existing members **and** against duplicate args within the same call | ✓ | `unit:sandbox-target.test.ts`, `playground:firestore-sentinels` (bundled) + `playground:firestore-row-101-arrayunion-dedupes` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-101-arrayunion-dedupes.json` — `setDoc({tags: ['a','b']})` then `updateDoc({tags: arrayUnion('b','c')})` yields `['a','b','c']` (single `b`, not double). Follow-up `updateDoc({tags: arrayUnion('d','d','a')})` yields `['a','b','c','d']` — both inline duplicate args and existing-member duplicates are de-duped. |
| 102 | `arrayRemove(...values)` strips matching members; values not present in the array are silent no-ops | ✓ | `unit:sandbox-target.test.ts`, `playground:firestore-sentinels` (bundled) + `playground:firestore-row-102-arrayremove-strips` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-102-arrayremove-strips.json` — `setDoc({tags: ['a','b','c']})` then `updateDoc({tags: arrayRemove('b','d')})` yields `['a','c']`: `'b'` removed, `'d'` (absent) was a silent no-op (no error). |
| 103 | `deleteField()` removes a field on update — the field is fully absent from the returned data, not merely undefined-valued. Legal at the top level or via a **dot-path** (`{'a.b': deleteField()}` removes the nested leaf — FS-B5). **Nested inside a map literal (`{a: {b: deleteField()}}`) it throws `invalid-argument` (FS-B13)** instead of destroying the sibling map. | ✓ | `playground:firestore-sentinels` (bundled) + `playground:firestore-row-103-deletefield-removes-field` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-103-deletefield-removes-field.json` — `setDoc({keep:1, remove:2})` then `updateDoc({remove: deleteField()})` yields a doc whose `data()` has keys `['keep']` only, `keep === 1` preserved; `unit:admin-compat/nested-delete-field.test.ts` (nested → invalid-argument; dot-path + top-level still valid; verified failing pre-fix) |
| 104 | `Timestamp` shape (`{seconds, nanoseconds}`) is identical between prod and sandbox — round-trips cleanly | ✓ | `unit:sandbox-target.test.ts` |
| 104b | **`Timestamp` nanos normalization + value API (FS-B12)** — `fromMillis`/`fromDate`/`now` derive `nanoseconds` as `floor((ms - seconds*1000) * 1e6)` so it is always non-negative; `fromMillis(-500).toMillis()` round-trips to -500 (was -1500). The class ships `isEqual` / `toString` / `toJSON` / `valueOf`, mirroring `clones/.../lite-api/timestamp.ts`. | ✓ | `unit:admin-compat/timestamp-api.test.ts` (negative-millis round-trip + value API; pre-fix lacked the methods and mis-normalized) |
| 104a | **Unified Timestamp storage (FS-B4)** — a `Timestamp` written directly via the modular SDK (`setDoc({createdAt: Timestamp.now()})`) is stored as the same rules-internal `Timestamp` that `serverTimestamp()`/`Date` resolve to. Pre-FS-B4 a user-written `Timestamp` was the compat class only (not a `RulesValue`), so `request.resource.data.createdAt is timestamp` returned **false** for it while a `serverTimestamp()` write passed the same rule, and the two paths stored two different classes. A write-boundary converter now normalizes both. | ✓ | `unit:firestore/sandbox-converters/user-timestamp.test.ts` (`is timestamp` passes for a user Timestamp; unified storage class; range-filter regression guard — verified failing pre-fix by removing the converter registration) |
| 105 | `FieldValue` re-exported from `pyric-admin` (alias of `ChainFieldValue`) | ✓ | type-only smoke |
| 105a | **Sentinel overwrite on type mismatch (FS-B11)** — `increment(n)` on a non-numeric (or absent) prior OVERWRITES using a base value of 0 (result `n`); `arrayUnion`/`arrayRemove` on a non-array prior coerce the base to `[]`. Pre-FS-B11 these threw and surfaced as `invalid-argument` denials. Mirrors `clones/.../model/transform_operation.ts` (`computeTransformOperationBaseValue`, `coercedFieldValuesArray`). | ✓ | `unit:simulator/converters/fieldvalue.test.ts` (FS-B11 overwrite block + flipped unit/integration/batch cases; verified failing pre-fix) |

## Scalar types — `Bytes` / `GeoPoint` / `FieldPath` / `documentId`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 106 | Constructors are re-exported from `firebase/firestore` — `new Bytes(…)`, `new GeoPoint(lat, lng)`, `new FieldPath(...)`, `documentId()` | ✓ | `unit:sandbox-target.test.ts` ("Bytes / GeoPoint / FieldPath / documentId are re-exported") |
| 107 | `documentId()` works in `where(documentId(), 'in', [...])` against the sandbox | ✓ | (chainable adapter recognizes the FieldPath sentinel) |
| 108 | `FieldPath` (nested) works in queries against sandbox | ✓ | `unit:sandbox-target.test.ts` |
| 109 | `Bytes` round-trip through the sandbox wire encoder — `Bytes` written via `setDoc` reads back as a `Bytes` instance with the same base64 representation | ✓ | `unit:packages/pyric/test/sandbox/firestore/wire-encoder-bytes-geopoint.test.ts` + `unit:packages/pyric/test/firestore/sandbox-target.test.ts` ("Bytes + GeoPoint round-trip"), oracle: `packages/conformance/observations/firestore/firestore-row-109-bytes-roundtrip.json` — `setDoc({payload: Bytes.fromUint8Array([1,2,3,4])})` then `getDoc` yields `payload instanceof Bytes === true`, `payload.constructor.name === 'Bytes'`, `payload.toBase64() === 'AQIDBA=='`, and `payload.toUint8Array()` returns `[1,2,3,4]` against blockingfun. Sandbox converters at `packages/pyric/src/sandbox/firestore/converters/bytes-geopoint.ts` duck-type-detect `fb.Bytes` and store as the rules `Bytes` wrapper; `pyric/firestore` finalizes the read back to `fb.Bytes` so consumer code matches prod's `instanceof` semantics. |
| 110 | `GeoPoint` round-trip through the sandbox wire encoder — `GeoPoint` written via `setDoc` reads back as a `GeoPoint` instance with the same latitude / longitude | ✓ | `unit:packages/pyric/test/sandbox/firestore/wire-encoder-bytes-geopoint.test.ts` + `unit:packages/pyric/test/firestore/sandbox-target.test.ts` ("Bytes + GeoPoint round-trip"), oracle: `packages/conformance/observations/firestore/firestore-row-110-geopoint-roundtrip.json` — `setDoc({loc: new GeoPoint(37.7749, -122.4194)})` then `getDoc` yields `loc instanceof GeoPoint === true`, `loc.constructor.name === 'GeoPoint'`, `loc.latitude === 37.7749`, `loc.longitude === -122.4194` against blockingfun. Sandbox storage uses the rules `LatLng` wrapper; `pyric/firestore` finalizes the read back to `fb.GeoPoint`. |
| 111 | Vector value type (`vector()` + `VectorValue`) round-trip: a vector written via `setDoc` reads back as a `VectorValue` with the same components | ✓ | `unit:sandbox-target.test.ts` ("Bytes + GeoPoint + VectorValue round-trip", top-level + nested). `vector()` / `VectorValue` re-exported from `firebase/firestore`; the sandbox converter at `converters/vector.ts` duck-types the VectorValue and stores the rules `Vector` wrapper; `pyric/firestore` finalizes the read back to `fb.VectorValue`. Oracle observation to follow (cf. #109/#110). **CLIENT surface only:** the web SDK exposes `vector()` + `VectorValue` (read/write) but has NO `findNearest` and NO `FieldValue.vector`; vector SEARCH is admin/server-only (`firebase-admin` `Query`/`CollectionReference.findNearest` + `FieldValue.vector()`), out of scope for this client matrix; the admin surface is tracked in the design rationale. |

## Equality helpers — `refEqual` / `queryEqual` / `snapshotEqual`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 112 | `refEqual(a, b)` — true when paths match under the same target | ✓ | `unit:sandbox-target.test.ts` |
| 113 | `refEqual` is `true` for cross-flavor sandbox vs sandbox-live refs at the same path | ✓ | `unit:sandbox-live-identity.test.ts` ("refEqual returns true for live and frozen refs at the same path") |
| 114 | `refEqual` is `false` for refs at different paths | ✓ | `unit:sandbox-live-identity.test.ts` |
| 115 | `refEqual(sandboxRef, prodRef)` throws `TypeError` — crossing targets is a programming error | ✓ | (documented invariant in `targetMatch`) |
| 116 | `queryEqual(a, b)` — true on identity for sandbox; structural for prod via `fb.queryEqual` | ⚠ | divergence: sandbox does identity-only; prod does deep structural. Oracle-locked: `packages/conformance/observations/firestore/firestore-queryequal-structural.json` — two independently-built queries with the same `where('x','==',1)` constraint compare equal in prod (`sameQueryBuiltTwice: true`), confirming structural semantics. Common use case (caching the same returned query) works on both. |
| 117 | `snapshotEqual(a, b)`. Prod: returns a boolean — true on identity, false even for two fetches of the same data. Sandbox: **throws** (`unrecognized reference`) for sandbox-target snapshots instead of returning a boolean | ⚠ | divergence, oracle-locked by `packages/conformance/observations/firestore/firestore-snapshotequal-structural.json` (`identity: true`, `twoFetchesSameData: false` — prod is identity-only, NOT structural; an earlier structural guess was corrected by the oracle). The sandbox routes both args through the ref-tagging path, which does not recognize sandbox `QuerySnapshot`s, so `snapshotEqual` throws rather than comparing. Both sides pinned in `oracle-conformance.test.ts`. Fix candidate: identity-compare sandbox snapshots before the ref-tagging dispatch. |
| 118 | Cross-flavor `refEqual` via `QuerySnapshot.docs[i].ref` works | ✓ | `unit:sandbox-live-identity.test.ts` ("cross-flavor refEqual via QuerySnapshot doc refs") |

## `connectFirestoreEmulator`

| # | Behavior | Status | Probe |
|---|---|---|---|
| 119 | No-op on sandbox-target handles (the sandbox already IS a local emulator) | ✓ | `unit:sandbox-target.test.ts` |
| 120 | Forwards to `fb.connectFirestoreEmulator` on prod-target handles | ✓ | `unit:prod-target.test.ts` |
| 121 | `mockUserToken` option pass-through on prod | ✓ | type-only smoke |

## Offline / persistence / network family

The backend runs locally, so there is no separate cache to enable and no network to toggle. Each function resolves by doing what it promises, or resolves as a documented no-op when there is nothing local for it to mean.


| # | Behavior | Status | Probe |
|---|---|---|---|
| 140 | Resolves on sandbox targets — persistence is already the default; does not reject with `'failed-precondition'` when called after other ops (deliberately more lenient than the real SDK — no cache-init race to protect). Forwards to `fb.enableIndexedDbPersistence` on prod targets | ⚠ no failed-precondition | `unit:firestore/persistence-network.test.ts` |
| 141 | Resolves on sandbox targets — the SharedWorker path already is the one shared store every tab talks to. Forwards to `fb.enableMultiTabIndexedDbPersistence` on prod targets | ⚠ no failed-precondition | `unit:firestore/persistence-network.test.ts` |
| 142 | Maps to `Sandbox.clearPersistence()` on sandbox targets — actually wipes the persisted blob (honest, not a no-op); already a no-op when persistence was never enabled. Forwards to `fb.clearIndexedDbPersistence` on prod targets | ✓ | `unit:firestore/persistence-network.test.ts` |
| 143 | Resolve on sandbox targets — no network exists to toggle; writes issued while "disabled" still commit immediately (no offline queue is simulated). Forward to `fb.enableNetwork` / `fb.disableNetwork` on prod targets | ⚠ no offline queue | `unit:firestore/persistence-network.test.ts` |
| 144 | Resolves immediately on sandbox targets — every accepted write is already committed locally by the time its own promise resolves, so there are never writes still pending a server round-trip. Forwards to `fb.waitForPendingWrites` on prod targets | ⚠ always resolves; prod can hang offline | `unit:firestore/persistence-network.test.ts` |
| 152 | Genuinely tears the target down on sandbox targets — calls `Sandbox.dispose()`, which tears down listener registries on the sandbox's environment (idempotent, doesn't touch data). This differs from the real SDK in scope: `dispose()` operates on the whole `Sandbox`, not a Firestore-only slice, so if `pyric/database`/`pyric/storage` share the same `Sandbox` their listener registries are torn down too. Forwards to `fb.terminate` on prod targets, which only tears down the one Firestore instance | ⚠ tears down the whole Sandbox, not a Firestore-only slice | `unit:firestore/terminate.test.ts` |

## Tier-1 cache-init + get-from-* family

The local store is always the fresh, authoritative source, so there is no cache to configure or to read separately from a server. These functions alias the normal read and init path, or resolve as documented no-ops.


| # | Behavior | Status | Probe |
|---|---|---|---|
| 145 | Delegates to `getFirestore(app)` and returns the same handle. Accepts the `settings` argument (so the explicit-init pattern doesn't crash at import) but no-ops the cache/network settings — persistence is always on. Prod path forwards only to `getFirestore(app)`; a real settings pass-through for prod is out of scope for this tier-1 pass | ⚠ settings accepted but cache/network settings are no-ops | `unit:firestore/tier1-cache-init-align.test.ts` |
| 146 | Config token accepted, inert — each returns a small tagged object so identity/usage doesn't crash. Persistence is the sandbox default; there is no cache tier left to configure | ⚠ inert config tokens; no cache tier to configure | `unit:firestore/tier1-cache-init-align.test.ts` |
| 147 | Delegates to `getDoc` / `getDocs` on sandbox targets — the sandbox store IS the authoritative source, so there is no separate server round-trip to force and no observable divergence from the default read. Forwards to `fb.getDocFromServer` / `fb.getDocsFromServer` on prod targets | ✓ | `unit:firestore/tier1-cache-init-align.test.ts` |
| 148 | Delegates to `getDoc` / `getDocs` on sandbox targets. Real Firebase THROWS `'unavailable'` here on a genuine cache miss; pyric never misses — the local store always has the answer (or a non-existent snapshot) — so it never throws for that reason. Forwards to `fb.getDocFromCache` / `fb.getDocsFromCache` on prod targets, which DO throw on a real cache miss | ⚠ never throws unavailable; sandbox has no cache miss | `unit:firestore/tier1-cache-init-align.test.ts` |
| 149 | Accepted no-op — the sandbox has no modular-SDK-style logger to wire a level into; it uses host-level `console` logging directly, gated by `pyric dev`'s own flags, not this call | ⚠ accepted no-op; no sandbox logger wired | `unit:firestore/tier1-cache-init-align.test.ts` |
| 150 | Fires the callback once the current snapshot-delivery microtask queue settles — the closest honest approximation of "every active listener has delivered its latest state" available without a true cross-listener sync signal. Not scoped to real server round-trips like the real SDK's guarantee; scoped to local delivery only. Forwards to `fb.onSnapshotsInSync` on prod targets | ⚠ approximated from local snapshot-delivery settle, not a true global in-sync signal | `unit:firestore/tier1-cache-init-align.test.ts` |

## `sandbox.*` — sandbox-only ops

| # | Behavior | Status | Probe |
|---|---|---|---|
| 122 | `sandbox.setRules(db, rules)` loads rules into the underlying `LocalEnvironment`; returns `LintResult` | ✓ | `unit:sandbox-target.test.ts`, `playground:rules-data-validation`, `playground:rules-cross-doc-get` |
| 123 | `sandbox.seedDocuments(db, {path: data, ...})` bulk-loads bypassing rules | ✓ | `unit:sandbox-target.test.ts` |
| 124 | `sandbox.snapshotState(db)` dumps every document the LocalEnvironment has stored | ✓ | `unit:sandbox-target.test.ts` |
| 125 | All `sandbox.*` methods throw `SandboxError('failed-precondition')` on prod-target handles | ✓ | `unit:sandbox-target.test.ts` |
| 126 | All `sandbox.*` methods work on a sandbox-live handle (route through `sandboxDb`) | ✓ | `unit:sandbox-live-identity.test.ts` ("sandboxOps.setRules + seedDocuments + snapshotState work on a live handle") |

## Rules engine (via `sandbox.setRules`)

Rules-engine behavior is technically `pyric-admin`'s `LocalEnvironment`,
but it's the most-tested surface for divergence — `request.auth`,
cross-doc reads via `get()`, data validation. These rows pin the
shape consumer code depends on.

| # | Behavior | Status | Probe |
|---|---|---|---|
| 127 | `request.auth.uid` reads through to `sandbox.currentUser?.uid` on sandbox-live | ✓ | `playground:auth-anonymous`, `playground:rules-cross-doc-get` |
| 128 | `request.auth == null` when sandbox.currentUser is null (anonymous path) | ✓ | `unit:sandbox-live-identity.test.ts` ("anonymous fallback") |
| 129 | Cross-doc `get(/databases/$(database)/documents/...)` in rules works under sandbox; `get()` of a **missing** doc ERRORS (guard with `exists()`), and `get(p).id` / `get(p).__name__` expose the doc identity (RULES-B8) | ✓ | `playground:rules-cross-doc-get`, `unit:rules/simulator/evaluator.test.ts` (RULES-B8 block) |
| 130 | `request.resource.data.<field>` field validation in rules works under sandbox; an **undefined** field read ERRORS (deny), it does NOT read as null (RULES-B2) — guard with `'f' in data` / `data.get('f', d)` | ✓ | `playground:rules-data-validation`, `unit:rules/simulator/evaluator.test.ts` (RULES-B2 block) |
| 131 | `resource.data.<field>` (existing doc on writes) works under sandbox; undefined-field reads ERROR (RULES-B2) | ✓ | `playground:rules-resource-data-field`, `unit:rules/simulator/evaluator.test.ts` (RULES-B2 block) |
| 132 | Custom claims in `request.auth.token.<claim>` | ✓ | `playground:rules-custom-claims` |
| 133 | Tri-state error semantics: DOTTED field access of a missing key (`resource.data.typo`), access on null/undefined, undefined variables, and `get()`-of-missing ERROR → deny; `&&`/`\|\|` absorb operand errors **commutatively** (CEL: `error \|\| true` → true, `error && false` → false). NOTE: DYNAMIC index access `data[expr]` stays null-on-miss (the documented may-be-absent-lookup idiom; only dotted access is doc-confirmed to error). (RULES-B2/B3/B8) | ✓ | `unit:rules/simulator/evaluator.test.ts` (RULES-B2 / RULES-B3 / RULES-B8 blocks) |
| 134 | `matches()` is a **full-string** anchored RE2 test; `replace()`/`split()` take regexes (`replace` = all occurrences) (RULES-B4) | ✓ | `unit:rules/simulator/evaluator.test.ts` (RULES-B4 block) |
| 135 | No JS prototype-chain leakage: `'toString' in data` → false, `data.constructor` errors; `in`/`hasAll`/`get` use own keys only (RULES-B7) | ✓ | `unit:rules/simulator/evaluator.test.ts` (RULES-B7 block) |
| 136 | Type-strict operators: `+` requires matching operand types (`'a' + 1` errors; `[1]+[2]` concatenates); ordered compares (`< > <= >=`) error across types; list membership uses value equality; `is map` excludes MapDiff/Set (RULES-B6 partial / B9 / B12 partial) | ✓ | `unit:rules/simulator/evaluator.test.ts` (RULES-B6 / B9 / B12 blocks) |
| 136b | `FirestoreSet` VALUE equality: `diff.addedKeys() == [uid].toSet()` compares set contents (order-insensitive); `set == list` is false, not an error (RULES-B13). Pre-fix, ANY two sets compared EQUAL (generic-object deep-equals saw no enumerable keys) — a false-PERMISSIVE divergence found by joining validation | ✓ | `unit:rules/simulator/set-equality.test.ts`; live validation: 10/10 both engines |
| 137 | `update` exposes `request.resource.data` / `getAfter()` as the existing doc **merged** with the payload via the `writeMode: { kind: 'update' }` path (the agent-facing `simulate()` opt-in); a sparse no-writeMode payload that drops a field now ERRORS on that field (RULES-B2) rather than silently reading null (RULES-B10) | ✓ | `unit:rules/simulator/handler.test.ts` (RULES-B10 block) |
| 138 | Int/float distinction (`1.5 is int`→false, `1 is float`→false, `1.0 is float`→true) + integer division (`10 / 4 == 2`) + int div/mod-by-zero ERRORS (RULES-B5); strict `int('12abc')`/`float('abc')`/`bool('false')`/`bool('yes')` parsing (RULES-B6 rest); `string(1.0)`→"1.0" (RULES-B12 rest) | ✓ | `unit:rules/simulator/evaluator.test.ts` (RULES-B5 + "RULES-B6 remainder" blocks); `unit:rules/simulator/handler.test.ts` ("RULES-B5 end-to-end" block) |
| 138a | DEFERRED sub-items of row 138: strict bool in `&&`/`\|\|`/ternary (`1 && true` should error) — corpus-coupled, needs emulator; a FLOAT stored in JSON test-data reads as int (`data.x is float`→false; prod uses the stored Firestore type tag) — needs a `__type:'float'` test-data revive marker; `resource`-null-on-create (RULES-B12 rest) | ⚠ | DEFERRED — see the design rationale (limitation + sub-items); strict-bool also in `step-07`. |
| 139 | Query-proof EVALUATION — the rules-side decision ("rules are not filters"): given a `list` rule + query constraints, decide provable-or-reject (a doc-dependent rule like `resource.data.visibility == 'public'` is provable ONLY with a matching `where('visibility','==','public')`; otherwise the whole query is rejected) (RULES-B11 rules-side) | ✓ | `unit:rules/simulator/query-proof.test.ts` |
| 139a | Query-proof ENFORCEMENT wiring — `silentReadCollection` + `readQueryCandidates` call `evaluateQueryProof` (via `sandbox/firestore/list-query-proof.ts`) instead of the per-doc silent-omission filter; structured `where`/`limit`/`orderBy` constraints are threaded from `QueryImpl.structuredConstraints()` through both the one-shot (`getDocs`/aggregate) and listener (`SnapshotTarget` applier `.structured`) paths, and `request.query.{limit,offset,orderBy}` is populated on list test cases (RULES-B11 cross-file) | ✓ | `unit:firestore/query-proof-enforcement.test.ts` (both paths; verified failing pre-fix); prover scope caveat: row 24c |

## Deny-list (intentionally not shimmed)

These exist in `firebase/firestore` but the sandbox does not shim them.

| Name | Reason |
|---|---|
| `CACHE_SIZE_UNLIMITED` / `PersistentCacheIndexManager` / `getPersistentCacheIndexManager` / `deleteAllPersistentCacheIndexes` / `enablePersistentCacheIndexAutoCreation` / `disablePersistentCacheIndexAutoCreation` / `setIndexConfiguration` | Index-tuning / GC-policy admin surface; no sandbox equivalent. |
| `terminate` | `Sandbox.dispose()` covers teardown at the host level. |
| `loadBundle` / `namedQuery` | Bundle-loading depends on server-side packaging not modeled in the sandbox. |
