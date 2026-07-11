# @pyric/conformance

Private workspace package (not published to npm). It holds the compatibility
registry, the per-surface descriptors, the oracle capture rigs and their frozen
observations, and the gates and reports that turn them into the published compat
coverage number. Consumed only by the root `package.json` `compat:*` / `oracle:plan`
scripts and by CI (`.github/workflows/build.yml`).

## Layout

The convention is one record per file, the filename is the key (and exists
nowhere else), the directory is the index, and aggregation is computed by a
loader — never a hand-maintained barrel.

```
packages/conformance/
  src/            runnable code: gates, reports, runners, loaders that are not
                  co-located with a data directory (coverage, report,
                  generate-docs, ledger, census-gate, lint-terminology,
                  validate-registry, climb, surface-census, surface-denylist,
                  print-fb-tag, the oracle capture runners, and the package tests)
  registry/       one CompatibilitySurfaceRegistry record per COMPAT.md doc
                  (ai, auth, firestore, rtdb, storage, messaging) + index.ts
                  (registriesByKey / surfaceRegistries / allCompatibilityRows)
  surfaces/       one SurfaceDescriptorRecord per surface (ai, auth, firestore,
                  rtdb, rtdb-modular, storage, messaging, messaging-admin);
                  load.ts derives the key from the filename and resolves the
                  registry; census-only.ts holds the export-census surfaces with
                  no COMPAT matrix (app, messaging-sw)
  exceptions/     one <observation-name>.md per excepted observation; the file
                  body is the reason; load.ts builds the record
  observations/   frozen prod-behavior captures (one .json per observation)
  rigs/           one RigManifestRecord per capture rig + load.ts
  probes/         individual capture probes (admin app-registry) + helpers
  rules-corpus/   Firestore/Storage Rules conformance corpus
  messaging-web/  the FCM web receive-plane capture harness
  baselines/      committed ratchet baselines (coverage, census, audit)
```

Only code that moved into `src/` had its paths recomputed; the data directories
keep the depth they had under `scripts/`, so their internal relative paths and
their references into `packages/pyric` are unchanged.

## Surface descriptors

Each `surfaces/<key>.ts` exports one `SurfaceDescriptorRecord` — the single
source of truth for one compatibility surface. The record carries no `surface`
field: the filename is the key, and `surfaces/load.ts` injects it. Fields:

- `order` — ordinal for stable output ordering (coverage table, report list).
- `registry` — key string resolved to the registry object (`rtdb-modular` → `rtdb`,
  `messaging-admin` → `messaging`).
- `censusSurface`, `upstream`, `mirrors` — the export-census mirror pair.
- `observationPrefixes` — the observation filename prefixes this surface owns
  (auth owns `auth-` and `admin-app-`; firestore `firestore-` and `rules-firestore-`;
  storage `storage-` and `rules-storage-`).
- `coverage` — whether the surface is published in `compat:coverage`.
- `scopeNote` — the one-line coverage scope statement.
- `conformanceSuite`, `captureRigs`, `climb` — suite path, capturing rig ids, CDD marker.

The consumers derive everything from the loaded descriptors: `surface-census.ts`
builds its mirror pairs (descriptors deduped by census surface, plus the two
census-only surfaces), `coverage.ts` derives `SERVICES` / `CENSUS_SURFACE_FOR` /
`SCOPE_NOTES`, `report.ts` and `ledger.ts` iterate them, `generate-docs.ts`
reads the climb marker, and `validate-registry.ts` validates their integrity
(registry resolves, prefixes unique across surfaces, capture-rig ids exist,
suite paths exist).

## Running

All gates run from the repo root via the `compat:*` and `oracle:plan` scripts
(e.g. `bun run compat:check`, `bun run compat:coverage`, `bun run oracle:plan`).
The package's own tests join the root test chain (`bun test --cwd packages/conformance`).
