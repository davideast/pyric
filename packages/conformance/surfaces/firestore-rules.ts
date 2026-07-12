import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 9,
  maturity: 'v1, conformance-held',
  // Native surface: there is no `firebase/rules` module to mirror. The
  // contract is the in-process Firestore rules simulator measured against the
  // production Firestore Rules Test API engine, replayed verdict-for-verdict
  // from the `rules-firestore-` corpus. Shares the `rules` registry (one COMPAT
  // doc) with `storage-rules`.
  kind: 'native',
  registry: 'rules',
  symbolSource: 'pyric/rules',
  observationPrefixes: ['rules-firestore-'],
  coverage: true,
  scopeNote:
    'native (no upstream): the Firestore rules simulator, measured against the production Rules Test API engine. Seven documented simulator divergences are the founding diverged-documented rows of this surface.',
  conformanceSuite: 'packages/pyric/test/rules/oracle-conformance.test.ts',
  captureRigs: ['rules-firestore'],
};
