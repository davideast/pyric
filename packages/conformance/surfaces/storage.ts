import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 6,
  registry: 'storage',
  censusSurface: 'storage',
  upstream: 'firebase/storage',
  mirrors: ['pyric/storage'],
  // `rules-storage-` observations are Rules-Test-API replay captures that reuse
  // the storage registry; storage owns the prefix.
  observationPrefixes: ['storage-', 'rules-storage-'],
  coverage: true,
  scopeNote:
    'out of scope: internal plumbing only. Deferred: uploadBytesResumable, getStream, list, getDownloadURL.',
  captureRigs: ['oracle-run', 'rules-storage'],
};
