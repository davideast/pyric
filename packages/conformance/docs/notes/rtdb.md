# `pyric/database` (RTDB) — maintainer notes

Moved verbatim out of `registry/rtdb.ts`. Not part of the site.


### Deferred mirror behaviors

- Ordered-query `onChildMoved` is accepted but does not yet fire on reorder.

Public runtime deferrals are rendered from the machine-readable surface contract below, not authored here.

The playground and `pyric dev` map canonical `firebase/database` imports to `pyric/database` before the mirror loads. A bare preview `getDatabase()` call is wrapped to receive the active sandbox. Production bundling leaves `firebase/database` unchanged.

Simulation and structure crawling are sandbox/CLI operations; rules authoring and analysis remain on the internal RTDB rules-engine seam until their later package relocation.

---



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

- #106 `DataSnapshot` shape — `size` is a getter, `numChildren()` is not on the modular SDK (was the legacy namespaced API).
- #107/#108 `get()` on missing path → `{ val: null, exists: false }`, no throw.
- #112 `set(ref, null)` removes the path (subsequent `get` returns `null`).
- #113 `set` replaces (not merges) at the parent ref.
- #116 `update` merges top-level keys; unspecified keys preserved.
- #117 multi-path update — `update(parentRef, { 'a/x': 1, 'b/y': 2 })` lands both writes.
- #118 multi-path update atomicity — one path denied → entire update rejects, no partial application.
- #119 `update` with `null` value removes a key.
- #122 `remove` on absent path is idempotent (no-throw).
- #126/#127 `push(ref, value)` writes the value and returns a ref usable for follow-up ops.
- #128 `onValue` initial fire with existing data — exactly 1 fire.
- #129 `onValue` initial fire on a nonexistent path — fires once with `val: null, exists: false` (matches Firestore semantics; RTDB does not silently skip the empty-path initial fire).
- #130 `onValue` fires on subsequent `set`.
- #131 unsubscribe stops further fires (`postUnsubFires === preUnsubFires`).
- #133 `onChildAdded` replays existing children on subscribe — one fire per existing key.
- #134 `onChildAdded` post-subscribe — exactly one fire per new direct child write.
- #135 `onChildChanged` — no initial replay, fires once when an existing child transitions, snapshot carries the new value.
- #136 `onChildRemoved` — no initial replay, fires once on delete, snapshot carries the prior (now-removed) value.
- #137 `onChildMoved` — fires under ordered queries (`query(ref, orderByChild(...))`) when a child's ordering value moves it to a new sort position; the Tier 2 sandbox locks the plain-ref no-fire case, Tier 3 wires the ordered-query path.
- #138/#139 `off(ref)` (no event type) stops further fires — locked against an `onChildAdded` registration; covers the off() variants by extension.
- #142/#150 `query(ref, orderByChild('pos'), limitToFirst(2))` returns the first 2 ordered children.
- #145 `equalTo(v)` filters to exactly the matching children.
- #146 `startAt(v)` is inclusive.
- #153/#154 `serverTimestamp()` resolves to a JS `number` (epoch ms), not a `Timestamp` instance.
- #155/#156 `increment(n)` starts at 0 on missing fields and accumulates (incl. negative deltas).
- #158/#160/#162 `runTransaction` happy path — committed: true, snapshot.val() is the new value, update fn sees `null` for empty refs.
- #159 `runTransaction` abort by returning `undefined` — committed: false, existing server value preserved.
- #160 (extended) `runTransaction` current-value arg shape — `null` for absent paths (`isNull: true`); prod speculatively invokes the fn once with `null` for a seeded path before the server-snap arrives (sandbox skips that speculative call — single invocation with the real current value).
- #162 (extended) `runTransaction` result shape — `{ committed: boolean, snapshot: DataSnapshot }`; snapshot responds to `.val()`, `.exists()`, `.key`.
- M37d `runTransaction` `options.applyLocally` — both branches commit; single-client harness produces 2 fires (initial + commit) on both, confirming the option doesn't break the contract (the suppression difference would only surface under contention).
- M37e `runTransaction` rules-denied error shape — plain `Error`, `message: 'permission_denied'` (lowercase), no `.code` field — **distinct from `set`/`get`'s `'PERMISSION_DENIED: Permission denied'` shape with uppercase `.code`**.

### Modular SDK surface — Phase 3 Tier 3 (query semantics) oracle observations

7 new oracle probes locked the full query-pipeline behavior against `blockingfun`, fb-js-sdk 12.13.0:

- #142/#146/#147 `rtdb-modular-orderbychild-window.json` — `orderByChild('pos') + startAt(2) + endAt(4)` matched positions `[2,3,4]` (both-inclusive window).
- #143/#146/#147 `rtdb-modular-orderbykey-window.json` — `orderByKey() + startAt('b') + endAt('d')` matched keys `[b,c,d]` in key order.
- #144/#150 `rtdb-modular-orderbyvalue-numeric.json` — `orderByValue() + limitToFirst(3)` threw `Index not defined, add ".indexOn": ".value"` against blockingfun — prod enforces a value-index requirement. (Sandbox does not enforce indexes; the semantic ordering claim is locked by unit test in `unit:modular/queries.test.ts`.)
- #145 `rtdb-modular-equalTo-filter.json` — `orderByChild('group') + equalTo('b')` returned `[k2,k4]` (both 'b'-grouped children); no uniqueness enforced.
- #150/#151 `rtdb-modular-limittofirst-vs-limittolast.json` — `limitToFirst(2)` returned `[a,b]` (positions `[1,2]`); `limitToLast(2)` returned `[d,e]` (positions `[4,5]`) on the same 5-child ordered query.
- #148/#149 `rtdb-modular-startafter-endbefore-exclusive.json` — `startAfter(2) + endBefore(5)` returned positions `[3,4]` (cursors `2` and `5` dropped — both bounds are exclusive).
- #152 `rtdb-modular-onvalue-with-query.json` — listener on `query(ref, orderByChild('pos'), limitToFirst(2))` fired 3 times: initial `[a,b]`, then on an inside-window mutation (`a` value change), then when a new child `z` displaced `b`. The outside-window write to `c/extra` did not fire the listener.

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
not accepted by the per-database rules endpoint) and `PUT`s to
`<databaseUrl>/.settings/rules.json?print=silent` with marker-based
idempotency: if `pyric_oracle` is already a top-level key and the
shape matches `ORACLE_RTDB_RULES_BODY`, the deploy is a no-op;
otherwise the namespace is merged (preserving any other top-level
keys) and a 5s propagation wait runs before the probes start. The
`.indexOn` inside `$run/$probe/list` is what lets the
`orderByChild`/`equalTo`/`startAt` probes run without per-probe
rule modifications.

## Historical simulator-vs-production capture

The frozen `rtdb-simulator-vs-prod-agreement.json` observation recorded 28 agreements and one historical `.validate` disagreement. The current in-process RTDB rules engine evaluates descendant validation rules on writes; row #71 and the simulator tests cover the repaired behavior without editing the frozen observation.


