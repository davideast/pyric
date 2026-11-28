# Shared Policy-Oracle Adapter Helper (`_shared/v1`)

Reusable fixture, runtime-loading, scoring, and evidence-verification helpers for
new Storage, RTDB, Firestore, and standalone probes under
`experiments/policy-oracle/suites/`.

Existing SHA-256-pinned adapters, claims, observations, and baselines are
untouched; new probes can import `@oracle/adapters/_shared/v1/index.mjs` (or
individual submodules) and pin those files in `recipe.json`.

## Modules

- `runtime.mjs`: Resolves `@pyric/rules` subpaths from
  `ORACLE_ROOT/arcade/runtime/package.json` and provides `tryCompile` /
  `unsupportedOutcomes` for graceful fallback on older packed rule engines.
- `fixture.mjs`: `sha256`, `canonicalJson`, `computeInputDigest`,
  `defineProbeFixtures`, `buildStorageCase`, `buildRtdbCase`, `computePinMap`.
- `score.mjs`: `scoreStorageProbe`, `scoreRtdbProbe`, `scoreFirestoreProbe`,
  `scoreStandaloneProbe`, `assertProbeOutput`, `emitProbeOutput`.
- `verify.mjs`: `verifyRtdbReceipt`, `verifyStorageReceipt`,
  `verifyNativeTraceReceipt`, `createMonotonicClock`, `assertAnonymousIdentity`,
  `runVerifierCli`.
- `index.mjs`: Barrel re-exporting all helpers.

## Pinning in `recipe.json`

Because `offline_runtime.py` mounts only paths declared in `recipe.json`'s
`pins` map, include every imported `_shared/v1/*.mjs` file as an
`@oracle/adapters/_shared/v1/<file>.mjs` pin.

## Tests

```sh
bun test experiments/policy-oracle/adapters/_shared/v1/shared.test.mjs
```
