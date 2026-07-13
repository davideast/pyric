# Feature matrix: `pyric/firestore`

The generated [compatibility matrix](../COMPAT.md) is the authoritative list of
supported, diverged, unsupported, and unverified Firestore behaviour. It is
generated from `packages/conformance/registry/firestore.ts`; do not maintain a
second row-by-row status table here.

## Package boundary

| Environment | `firebase/firestore` resolves to | Production access from mirror |
|---|---|---|
| Pyric inactive | Firebase SDK | Not applicable |
| Vite sandbox active | `pyric/firestore` | None |
| Node register active | `pyric/firestore` | None |
| Direct `pyric/firestore` import | `pyric/firestore` | None |

The compiled mirror has no `firebase/firestore` import. A direct mirror call
rejects real Firebase apps and foreign references.

## Major supported families

- App-owned, frozen-identity, live-identity, and rules-bypassing sandbox handles
- Document and collection references, collection-group queries, converters
- Document and query reads
- Set, update, delete, add, transactions, and write batches
- Filters, composite filters, ordering, limits, cursors, and aggregates
- Document and query listeners
- Field-value sentinels and local `Bytes`, `GeoPoint`, `FieldPath`, and
  `VectorValue` classes
- Persistence/network compatibility functions and cache-configuration tokens
- Firestore sandbox controls under `pyric/sandbox/firestore`

The compatibility matrix records the exact caveats and evidence for each
family.

## Intentionally unsupported Firebase exports

The sandbox mirror does not export:

- `CACHE_SIZE_UNLIMITED`
- persistent-cache index managers and index mutation functions
- `setIndexConfiguration`
- `loadBundle`
- `namedQuery`

Production application code still receives these from Firebase whenever the
Pyric activation seam is absent.

## Sandbox-only controls

Rules, fixture seeding, state snapshots, and inspection live under
`pyric/sandbox/firestore`. They are not exported from the Firebase-shaped
`pyric/firestore` entry point and do not belong in production application
bundles.

## Evidence gates

The boundary is guarded by four independent checks:

1. Direct mirror calls reject Firebase-owned inputs.
2. Canonical imports execute a Firestore write/read through Node registration.
3. Canonical imports execute the same operation through real Vite resolution.
4. Clean-built artifacts contain no `firebase/firestore` binding.

Frozen production observations remain unchanged and continue to define the
answer key for behavioural comparison.
