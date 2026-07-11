import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 4,
  registry: 'rtdb',
  censusSurface: 'database',
  upstream: 'firebase/database',
  mirrors: ['pyric/database/modular', 'pyric/database'],
  observationPrefixes: ['rtdb-'],
  coverage: true,
  scopeNote:
    'out of scope: internal plumbing only. Deferred: onDisconnect (no live socket in an in-memory sandbox today), legacy priority ordering.',
  captureRigs: ['oracle-run'],
};
