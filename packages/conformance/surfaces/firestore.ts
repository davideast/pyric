import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 3,
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
  scopeNote: 'Firebase-internal underscore plumbing is private and excluded from public coverage by rule. Public gaps include bundle-loading, cache index-tuning knobs, and exported types that are not yet mirrored.',
  captureRigs: ['oracle-run'],
};
