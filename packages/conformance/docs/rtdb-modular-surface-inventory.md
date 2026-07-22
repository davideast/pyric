# RTDB modular climb inventory

Status: CDD retrofit graduated, 2026-07-22

This inventory defines the `firebase/database` compatibility obligations for
the RTDB modular CDD climb. The public export census remains authoritative for
module-level runtime and type names; this document closes the behavior universe
that a name-only census cannot see.

## Public shape

- Every non-private runtime export from `firebase/database` is implemented or
  has a structured disposition in `surfaces/rtdb-modular.json`.
- Every public exported type is assignable at the supported call boundary.
- Runtime class values preserve observable constructor identity, prototypes,
  `instanceof`, and documented methods for `Database`, `DataSnapshot`,
  `QueryConstraint`, and `TransactionResult`.
- References and snapshots cover their public properties, navigation methods,
  iteration contract, string form, and URL validation.

## Behavioral families

- Database selection, reference construction, reads, writes, multi-location
  updates, removal, push IDs, sentinels, and emulator hooks.
- Value and child listeners, including observer/function overloads,
  cancellation callbacks, `previousChildName`, query windows, duplicate
  registrations, `off`, and unsubscribe behavior.
- Query ordering, bounds, equality, limits, key tie-breaking, and priority
  metadata/order.
- Transactions and atomic increments, including contention and retry behavior.
- Per-client connection state, offline optimistic writes, reconnect, rules
  rejection rollback, disconnect registration/draining, app deletion, and
  abrupt-loss boundaries.
- Logging, transport-selection functions, URL references, and all stable error
  timing/shape observable through the public API.

## Graduation boundary

RTDB predates the repository's CDD process. The legacy rows therefore use a
CDD retrofit: their row-keyed assertions are executable regression evidence,
but they are not presented as historical proof that tests preceded the old
implementation. Rows introduced by this climb follow the red-before-green
ordering; the distinction is preserved in commit history instead of being
papered over as if the whole mature surface had been born under CDD.

The climb graduates with no unverified rows, no unmapped census symbols, no
orphan `rtdb-modular-` observations, one assertion set per registry row, and an
unchanged served application running through both in-process and SharedWorker
entry paths. Network transport selection and total loss of every local host may
remain documented divergences; they may not be removed from the denominator to
improve the score.

Graduation was proven by the dedicated blocking suite in
`packages/pyric/test/database/cdd`: all 184 registry rows have one row-keyed
assertion set, and the isolated climb reported 184/184 live-green rows with no
unmapped tests, unkeyed tests, regressions, or unguarded greens. Those row
assertions are executable behavior proof, not a claim that every legacy row
was developed test-first. A completeness gate discovers
the committed `rtdb-modular` observation corpus, parses the suite's literal
row-keyed test registrations, and requires every registry row exactly once. It
then joins every capture through its authored row IDs and the registry's
reciprocal citation to one of those executable assertions; an excluded capture
instead requires a named `NOT_APPLICABLE` entry with a written reason. The gate
has no separately maintained capture list, so a new observation fails closed.
The focused oracle-replay suites cited by the
registry remain complementary, higher-detail witnesses and stay blocking. The
public database suites cover the in-process entry path. The worker integration
suite covers the served entry implementation, the bundle gate checks its
complete runtime export shape, and `app-multi-app.pw.ts` runs the unchanged
`firebase/database` import through the real served module and SharedWorker.
The surface descriptor therefore drops the temporary `climb` marker after
graduation; all of those layers remain in blocking lanes.

The committed census ratchet before this branch was stale: it recorded 35/44
runtime exports and 8/15 types, while a fresh census at the branch fixed point
already found 37/44 and 9/15. The implementation credit in this climb is
therefore **+7 runtime exports and +6 types**, with the remaining +2/+1 in the
baseline diff explicitly classified as stale-baseline correction. The terminal
surface is 44/44 runtime and 15/15 types either way; the distinction prevents
the PR from claiming work it did not perform.
