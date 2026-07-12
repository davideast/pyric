import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 4,
  registry: 'rtdb',
  censusSurface: 'database',
  upstream: 'firebase/database',
  mirrors: ['pyric/database/modular', 'pyric/database'],
  // `rules-rtdb-` observations are deploy-observe-restore rules captures (RTDB
  // has no server-side rules test API) that reuse the rtdb registry; rtdb owns
  // the prefix, exactly as firestore owns `rules-firestore-`.
  observationPrefixes: ['rtdb-', 'rules-rtdb-'],
  coverage: true,
  scopeNote:
    'out of scope: internal plumbing only. Deferred: onDisconnect (no live socket in an in-memory sandbox today), legacy priority ordering.',
  captureRigs: ['oracle-run', 'rtdb-rules'],
};
