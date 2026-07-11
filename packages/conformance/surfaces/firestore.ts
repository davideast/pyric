import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 3,
  registry: 'firestore',
  censusSurface: 'firestore',
  upstream: 'firebase/firestore',
  mirrors: ['pyric/firestore'],
  // `rules-firestore-` observations are Rules-Test-API replay captures that reuse
  // the firestore registry; firestore owns the prefix.
  observationPrefixes: ['firestore-', 'rules-firestore-'],
  coverage: true,
  scopeNote: 'out of scope: internal plumbing only. Deferred: bundle-loading, cache index-tuning knobs.',
  captureRigs: ['oracle-run', 'rules-firestore'],
};
