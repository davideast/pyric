import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 5,
  kind: 'mirror',
  // Shares the rtdb registry (and its COMPAT.md doc) but keeps a distinct
  // observation prefix and its own matrix rows. Since classic `rtdb` is now a
  // native surface (no upstream), rtdb-modular is the SOLE owner of the
  // `database` export census — the modular shim IS the `firebase/database`
  // mirror.
  registry: 'rtdb',
  censusSurface: 'database',
  upstream: 'firebase/database',
  mirrors: ['pyric/database/modular', 'pyric/database'],
  observationPrefixes: ['rtdb-modular-'],
  coverage: true,
  scopeNote: 'out of scope: internal plumbing only. Sole owner of the `database` export census (the `firebase/database` modular mirror).',
  captureRigs: ['oracle-run'],
};
