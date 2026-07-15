import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 5,
  kind: 'mirror',
  // Shares the rtdb registry (and its COMPAT.md doc) but keeps a distinct
  // observation prefix and its own matrix rows. Since classic `rtdb` is now a
  // native surface (no upstream), rtdb-modular is the SOLE owner of the
  // `database` export census — `pyric/database` IS the `firebase/database`
  // mirror.
  registry: 'rtdb',
  censusSurface: 'database',
  upstream: 'firebase/database',
  mirrors: ['pyric/database'],
  observationPrefixes: ['rtdb-modular-'],
  coverage: true,
  scopeNote: 'Firebase-internal underscore plumbing is private and excluded from public coverage by rule. Public runtime and type gaps stay in the denominator. This surface is the sole owner of the `database` census.',
  captureRigs: ['oracle-run'],
};
