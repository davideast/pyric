import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 3,
  maturity: 'v1, conformance-held',
  kind: 'mirror',
  registry: 'firestore',
  censusSurface: 'firestore',
  upstream: 'firebase/firestore',
  mirrors: ['pyric/firestore'],
  // The `rules-firestore-` prefix and its rules-engine fidelity rows moved to the
  // native `firestore-rules` surface (registry/rules.ts); firestore keeps only
  // the SDK export census and its own SDK-behavior rows.
  observationPrefixes: ['firestore-'],
  coverage: true,
  scopeNote: 'out of scope: internal plumbing only. Deferred: bundle-loading, cache index-tuning knobs.',
  captureRigs: ['oracle-run'],
};
