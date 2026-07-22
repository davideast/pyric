# RTDB modular climb inventory

Status: CDD graduated, 2026-07-22

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

Graduation was proven by the dedicated blocking suite in
`packages/pyric/test/database/cdd`: all 184 registry rows have one row-keyed
assertion set, and the isolated climb reported 184/184 live-green rows with no
unmapped tests, unkeyed tests, regressions, or unguarded greens. The public
database suites cover the in-process entry path, while the served-application
integration suite exercises the unchanged `firebase/database` import shape
through SharedWorker transport. The surface descriptor therefore drops the
temporary `climb` marker after graduation; the row-keyed suite remains part of
the blocking package test lane.
