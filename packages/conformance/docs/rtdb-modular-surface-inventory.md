# RTDB modular climb inventory

Status: behavior universe approved; CDD graduation held, 2026-07-22

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

The climb graduates with no unverified rows, no unmapped census symbols, no
orphan `rtdb-modular-` observations, one assertion set per registry row, and an
unchanged served application running through both in-process and SharedWorker
entry paths. Network transport selection and total loss of every local host may
remain documented divergences; they may not be removed from the denominator to
improve the score.

The surface is not currently opted into the global `compat:climb` lane. Its
legacy conformance tests predate the row-ID convention, so that reporter cannot
yet prove one assertion set per row or reconcile its live-green count with the
registry. The production observations and ordinary blocking suites remain
authoritative for this score movement. Re-enable `climb: true` only after the
existing behavioral tests are mapped to every row; descriptor-only assertions
do not satisfy this boundary.
