import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 10,
  // Native surface: there is no `firebase/rules` module to mirror. The contract
  // is the in-process `parseStorageRules` / `evaluateStorageRules` engine
  // measured against the production Storage Rules Test API engine, replayed
  // verdict-for-verdict from the `rules-storage-` corpus. Shares the `rules`
  // registry (one COMPAT doc) with `firestore-rules`. The `storage/unauthorized`
  // op-level enforcement rows stay on the `storage` SDK surface.
  kind: 'native',
  registry: 'rules',
  symbolSource: 'pyric/storage',
  observationPrefixes: ['rules-storage-'],
  coverage: true,
  scopeNote:
    'native (no upstream): the Storage rules engine (parseStorageRules / evaluateStorageRules), measured against the production Rules Test API engine.',
  conformanceSuite: 'packages/pyric/test/storage/rules-oracle-conformance.test.ts',
  captureRigs: ['rules-storage'],
};
