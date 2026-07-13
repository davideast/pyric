import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 6,
  kind: 'mirror',
  registry: 'storage',
  censusSurface: 'storage',
  upstream: 'firebase/storage',
  mirrors: ['pyric/storage'],
  // The `rules-storage-` prefix and its rules-engine fidelity rows moved to the
  // native `storage-rules` surface (registry/rules.ts); storage keeps only the
  // SDK export census, its own SDK-behavior rows, and the op-level enforcement
  // rows (a denied op throws `storage/unauthorized`), which are SDK behavior.
  observationPrefixes: ['storage-'],
  coverage: true,
  scopeNote:
    'out of scope: internal plumbing only. Deferred: uploadBytesResumable, getStream, list.',
  captureRigs: ['oracle-run'],
};
