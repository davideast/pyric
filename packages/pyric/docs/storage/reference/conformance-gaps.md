# Storage rules evaluator conformance gaps

The oracle-conformance suite (`packages/pyric/test/storage/rules-oracle-conformance.test.ts`)
replays captured production Rules-Test-API verdicts
(`scripts/oracle/observations/rules-storage-*.json`) against the local
evaluator (`evaluateStorageRules`). 7 observation files are captured. 6
replay clean — the evaluator's decision matches production case-for-case.
1 observation contains a case where the evaluator's decision diverges from
the captured production verdict, and it is pinned rather than silently
skipped.

This capture also resolved a stale claim: the compatibility registry rows
[`storage-rules#96`](../../rules/COMPAT.md) and [`storage-rules#104`](../../rules/COMPAT.md)
(moved to the native rules surface) previously
marked granular verbs, user-defined functions, `request.time`, and
`matches()` as unsupported. Production capture proves the evaluator already
supports all of them; those rows — plus new rows for `matches()`,
`resource.metadata` access, and cross-service `firestore.get()`/`exists()`
lookups — are now `conforms`, cited by the observations below.

## Divergence

| Observation :: case | Production | Evaluator | What diverges | Severity |
|---|---|---|---|---|
| `rules-storage-verbs-umbrella-granular :: create allowed when object does not exist (resource == null)` | DENY | ALLOW | Production throws a "Null value error" referencing `resource` on a create where no object exists yet, instead of evaluating `resource == null` as documented | Low (edge case on the existence check idiom) |

This was live-probed before pinning: a minimal ruleset
(`allow create: if resource == null;`) was posted to the production Rules
Test API with two request shapes — an omitted `resource` field, and an
explicit `resource: null` — to rule out a capture-harness bug. Both shapes
are the harness's correct wire encoding of "no existing object"
(`buildStorageApiTestCase` only sets the outer `resource` when
`existingResource` is truthy). Both denied identically with a "Null value
error" at the `resource == null` comparison, so this is not a wire-shape
bug — it is production's actual behavior. The evaluator's `resource ==
null` on create evaluates true and allows, matching the documented,
intuitive semantics but not what production does today.

Not a false-permissive gap for real rulesets: the mirrored companion case
in the same pack (`create denied when object already exists`) matches
production exactly, so a ruleset guarding writes with `resource == null` /
`resource != null` still denies unauthorized writes correctly on the
evaluator; only the specific "genuinely-new-object create" case is
over-permissive relative to production's null-reference-error quirk.

## Fully-conforming observations

The remaining 6 captured observations replay clean, case-for-case, with no
pinned divergences:

- `rules-storage-firestore-lookup`
- `rules-storage-functions-let-scope`
- `rules-storage-matches-regex`
- `rules-storage-metadata-access`
- `rules-storage-request-time-timestamp`
- `rules-storage-resource-timestamp-witness` (a witness pack: both cases
  correctly DENY on both sides, but the evaluator's DENY is coincidental —
  `resource.timeCreated` / `resource.updated` are not modeled, so any
  comparison denies. See [Storage rules subset](./rules-subset.md#out-of-scope).)

## Self-policing pin mechanism

The divergence is pinned in `KNOWN_DIVERGENCES` in
`packages/pyric/test/storage/rules-oracle-conformance.test.ts`, keyed by
`<observation name> :: <case key>`. The pin asserts two things:

1. The captured production verdict still matches what's recorded (guards
   against a stale or edited observation file).
2. The evaluator's live verdict still matches the recorded divergent
   verdict (guards against a silent behavior change).

If an evaluator change later makes this case match production, the second
assertion fails — the test forces the fix author to remove the entry from
`KNOWN_DIVERGENCES` (closing the gap) rather than the fix landing invisibly
next to a stale pin.

## Where to look next

- [Storage rules subset](./rules-subset.md) for the supported grammar.
- [Implementation scope and deferred features](../explanation/implementation-scope.md)
  for `resource.timeCreated` / `resource.updated`.
- [Compatibility matrix](../COMPAT.md) for the full row-by-row registry.
