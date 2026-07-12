import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 4,
  // Classic `@pyric/rtdb` is the agent-tools / host surface — the
  // `createRtdbAdminTools` / `getRtdbTools` factories, the `RtdbHost` contract
  // and `fetchDatabase` REST helper, and the constraint-authoring DSL. It has
  // no `firebase/*` upstream to mirror (the modular `firebase/database` shim is
  // the `rtdb-modular` surface), so it is NATIVE: its claimable universe is its
  // own public API on `pyric/database`, not an upstream export set.
  kind: 'native',
  registry: 'rtdb',
  symbolSource: 'pyric/database',
  // `rules-rtdb-` observations are deploy-observe-restore rules captures (RTDB
  // has no server-side rules test API). Until rtdb-rules is admitted as its own
  // native surface (its oracle chain is still landing), the rtdb surface owns
  // the prefix and its rules rows live in registry/rtdb.ts.
  observationPrefixes: ['rtdb-', 'rules-rtdb-'],
  coverage: true,
  scopeNote:
    'native (no upstream): the agent-tools / host surface, measured against its own public API. Deferred: onDisconnect (no live socket in an in-memory sandbox today), legacy priority ordering.',
  captureRigs: ['oracle-run', 'rtdb-rules'],
};
