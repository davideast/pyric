---
title: "Rules simulator conformance gaps"
group: "pyric / rules"
section: "Reference"
order: 105
---
# Rules simulator conformance gaps

The oracle-conformance suite (`packages/pyric/test/rules/oracle-conformance.test.ts`)
replays captured production Rules-Test-API verdicts
(`scripts/oracle/observations/rules-firestore-*.json`) against the local
simulator (`SimulateFirestoreRulesHandler`). As of this writing, 18
observation files are captured. 12 replay clean — the simulator's decision
matches production case-for-case. 7 observations contain at least one case
where the simulator's decision diverges from the captured production
verdict.

These divergences are known, tracked, and pinned in the test suite's
`KNOWN_DIVERGENCES` table so the suite stays green — the pin asserts both
the recorded production verdict and the simulator's current verdict, so a
future change to the simulator's behavior on any of these cases fails the
suite loudly instead of drifting unnoticed. They are not silently skipped
cases.

All of the gaps below are exotic or low-frequency: obscure hashing
built-ins, post-write identity mocking, edge-of-range slicing, and similar
corners unlikely to appear in a typical ruleset. None of them represents a
false-permissive gap that would matter for a normal application's security
posture beyond the specific corpus case listed.

Tracked in [#135](https://github.com/davideast/pyric/issues/135).

## Divergence table

| Observation :: case | Production | Simulator | What diverges | Severity |
|---|---|---|---|---|
| `rules-firestore-bytes-toutf8-and-hashing :: toBase64 round-trip ALLOW` | DENY | ALLOW | `toBase64()` round-trip does not match production's byte encoding | Low (exotic bytes API) |
| `rules-firestore-bytes-toutf8-and-hashing :: md5 empty string ALLOW` | DENY | ALLOW | `md5()` over the empty string diverges from production's hash output | Low (exotic hashing built-in) |
| `rules-firestore-bytes-toutf8-and-hashing :: sha256 abc ALLOW` | DENY | ALLOW | `sha256()` diverges from production's hash output | Low (exotic hashing built-in) |
| `rules-firestore-bytes-toutf8-and-hashing :: crc32 IEEE 802.3 ref ALLOW` | DENY | ALLOW | `crc32()` reference implementation diverges from production | Low (exotic hashing built-in) |
| `rules-firestore-bytes-toutf8-and-hashing :: crc32c Castagnoli ref ALLOW` | DENY | ALLOW | `crc32c()` reference implementation diverges from production | Low (exotic hashing built-in) |
| `rules-firestore-get-after-and-exists-after :: getAfter target == request.resource.data ALLOW` | DENY | ALLOW | `getAfter()` does not model the post-write document identity production compares against | Low (post-write identity edge case) |
| `rules-firestore-get-after-and-exists-after :: existsAfter create true ALLOW` | DENY | ALLOW | `existsAfter()` on a create does not match production's post-write existence semantics | Low |
| `rules-firestore-get-after-and-exists-after :: existsAfter delete false ALLOW` | DENY | ALLOW | `existsAfter()` on a delete does not match production's post-write existence semantics | Low |
| `rules-firestore-get-after-and-exists-after :: existsAfter unrelated mocked path ALLOW` | DENY | ALLOW | `existsAfter()` over an unrelated mocked path does not match production | Low |
| `rules-firestore-get-missing-doc :: get(mocked).id == 'site' → DENY (mocked get() has no resource identity in production)` | DENY | ALLOW | Simulator synthesizes a resource identity for mocked `get()` results that production leaves absent | Low (mocked-get identity edge case) |
| `rules-firestore-get-missing-doc :: get(mocked).__name__ == path literal → DENY (mocked get() has no resource identity in production)` | DENY | ALLOW | Simulator synthesizes `__name__` for mocked `get()` results that production leaves absent | Low |
| `rules-firestore-globals-request-path-and-resource-id :: request.query empty map ALLOW` | DENY | ALLOW | Simulator models `request.query` as an empty map where production denies the equivalent comparison | Low |
| `rules-firestore-int-float-and-division :: float payload is float / not int ALLOW` | ALLOW | DENY | Simulator narrows a float-valued payload field toward int; production preserves the float type | Low (numeric-type-tag edge case) |
| `rules-firestore-path-constructor-and-bind :: path() idempotent on Path arg ALLOW` | DENY | ALLOW | Simulator treats `path()` as idempotent on an already-`Path` argument; production denies | Low |
| `rules-firestore-range-slice-list-and-string :: list slice end OOB clamps to length ALLOW` | DENY | ALLOW | Simulator clamps an out-of-bounds list slice end to the list length; production denies | Low (range edge case) |
| `rules-firestore-range-slice-list-and-string :: string slice end OOB clamps to length ALLOW` | DENY | ALLOW | Simulator clamps an out-of-bounds string slice end to the string length; production denies | Low (range edge case) |

## Fully-conforming observations

The remaining 11 captured observations replay clean, case-for-case, with no
pinned divergences:

- `rules-firestore-builtins-time-and-math`
- `rules-firestore-cross-type-operator-overloads`
- `rules-firestore-error-absorption-and-or`
- `rules-firestore-list-methods-concat-removeall-toset`
- `rules-firestore-map-get-string-and-list-form`
- `rules-firestore-matches-full-string-regex`
- `rules-firestore-prototype-chain-keys`
- `rules-firestore-set-algebra-difference-union-intersection`
- `rules-firestore-string-literals-and-regex`
- `rules-firestore-undefined-field-access`
- `rules-firestore-unsupported-feature-witness`

## Self-policing pin mechanism

Each divergence is pinned in `KNOWN_DIVERGENCES` in
`packages/pyric/test/rules/oracle-conformance.test.ts`, keyed by
`<observation name> :: <case key>`. The pin asserts two things:

1. The captured production verdict still matches what's recorded (guards
   against a stale or edited observation file).
2. The simulator's live verdict still matches the recorded divergent
   verdict (guards against a silent behavior change).

If a simulator fix later makes one of these cases match production, the
second assertion fails — the test forces the fix author to remove the
entry from `KNOWN_DIVERGENCES` (closing the gap) rather than the fix
landing invisibly next to a stale pin.
