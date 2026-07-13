import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 4,
  // The legacy RTDB toolkit is the agent-tools / host surface — the
  // `createRtdbAdminTools` / `getRtdbTools` factories, the `RtdbHost` contract
  // and `fetchDatabase` REST helper, and the constraint-authoring DSL. It has
  // no `firebase/*` upstream to mirror (the modular `firebase/database` shim is
  // the `rtdb-modular` surface), so it is NATIVE: its claimable universe is its
  // own internal API, not an upstream export set. The public `pyric/database`
  // entry is now exclusively the `firebase/database` mirror; this descriptor
  // remains temporarily attached to the legacy toolkit until its retirement.
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
    'native (no upstream): transitional legacy RTDB toolkit under the unstable rules-internal seam. Deferred: onDisconnect (no live socket in an in-memory sandbox today), legacy priority ordering.',
  captureRigs: ['oracle-run'],
};
