import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 4,
  maturity: 'Experimental',
  // Classic `@pyric/rtdb` is the agent-tools / host surface — the
  // `createRtdbAdminTools` / `getRtdbTools` factories, the `RtdbHost` contract
  // and `fetchDatabase` REST helper, and the constraint-authoring DSL. It has
  // no `firebase/*` upstream to mirror (the modular `firebase/database` shim is
  // the `rtdb-modular` surface), so it is NATIVE: its claimable universe is its
  // own public API on `pyric/database`, not an upstream export set.
  kind: 'native',
  registry: 'rtdb',
  symbolSource: 'pyric/database',
  // The `rules-rtdb-` prefix has moved off this surface: its deploy-observe-
  // restore oracle chain landed, so rtdb-rules is now a native surface in its
  // own right (surfaces/rtdb-rules.ts) hosting its rows in the shared `rules`
  // registry alongside firestore-rules and storage-rules. This surface keeps
  // only the SDK-plane `rtdb-` observations.
  observationPrefixes: ['rtdb-'],
  coverage: true,
  scopeNote:
    'native (no upstream): the agent-tools / host surface, measured against its own public API. Deferred: onDisconnect (no live socket in an in-memory sandbox today), legacy priority ordering.',
  captureRigs: ['oracle-run'],
};
