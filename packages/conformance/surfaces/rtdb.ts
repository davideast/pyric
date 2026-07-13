import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 4,
  // The pure RTDB rules engine has no `firebase/*` upstream to mirror (the
  // modular `firebase/database` shim is the `rtdb-modular` surface), so it is
  // NATIVE: its claimable universe is its own simulator, mapper, grammar,
  // replay, and constraints API under the unstable rules-internal seam.
  kind: 'native',
  registry: 'rtdb',
  symbolSource: 'pyric/rules/internal/rtdb',
  // The `rules-rtdb-` prefix has moved off this surface: its deploy-observe-
  // restore oracle chain landed, so rtdb-rules is now a native surface in its
  // own right (surfaces/rtdb-rules.ts) hosting its rows in the shared `rules`
  // registry alongside firestore-rules and storage-rules. This surface keeps
  // only the SDK-plane `rtdb-` observations.
  observationPrefixes: ['rtdb-'],
  coverage: true,
  scopeNote:
    'native (no upstream): pure RTDB rules engine under the unstable rules-internal seam. Production data access and deployment are intentionally absent.',
  captureRigs: ['oracle-run'],
};
