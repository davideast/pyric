import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 5,
  // Shares the rtdb registry (and its COMPAT.md doc) but keeps a distinct
  // observation prefix and its own matrix rows.
  registry: 'rtdb',
  censusSurface: 'database',
  upstream: 'firebase/database',
  mirrors: ['pyric/database/modular', 'pyric/database'],
  observationPrefixes: ['rtdb-modular-'],
  coverage: true,
  scopeNote: 'out of scope: same as rtdb — shares the `database` census measurement.',
  captureRigs: ['oracle-run'],
};
