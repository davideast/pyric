import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 11,
  maturity: 'v1, conformance-held',
  // Native surface: there is no `firebase/rules` module to mirror. The contract
  // is the in-process RTDB rules simulator (`RtdbMapper` + `SimulateHandler` on
  // `pyric/database`) measured against production, replayed verdict-for-verdict
  // from the `rules-rtdb-` corpus. Shares the `rules` registry (one COMPAT doc)
  // with `firestore-rules` and `storage-rules`.
  //
  // Unlike those two, RTDB has NO server-side rules test API, so production
  // truth is not read from an endpoint: it is captured by DEPLOYING each corpus
  // ruleset to the dedicated oracle database, executing the ops against the live
  // service, recording allow/deny, and restoring. That deploy-observe-restore
  // chain landed with the `rules-rtdb-` captures, which is what admits this as a
  // surface in its own right; before it existed the `rtdb` surface held the
  // prefix on an interim basis.
  kind: 'native',
  registry: 'rules',
  symbolSource: 'pyric/database',
  observationPrefixes: ['rules-rtdb-'],
  coverage: true,
  scopeNote:
    'native (no upstream): the RTDB rules simulator, measured against production by deploy-observe-restore (RTDB has no server-side rules test API). The simulator agrees with production on every captured corpus case.',
  conformanceSuite: 'packages/pyric/test/database/rules-conformance.test.ts',
  captureRigs: ['rtdb-rules'],
};
