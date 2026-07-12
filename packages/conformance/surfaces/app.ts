import type { SurfaceDescriptorRecord } from './types.ts';

/**
 * `pyric/app` — the client app-management surface, and the initialization path
 * every user hits first. A MIRROR surface: the export census diffs
 * `firebase/app`'s runtime exports against `pyric/app`'s. Formerly census-only
 * (no COMPAT matrix); it now has a full registry (registry/app.ts), a capture
 * rig (rigs/app-registry.ts → `app-registry-*` observations), and a replay
 * suite (packages/pyric/test/app/oracle-conformance.test.ts), so it publishes
 * both surface and behavior coverage.
 */
export const surface: SurfaceDescriptorRecord = {
  order: 1,
  maturity: 'Shipped, initialization surface',
  kind: 'mirror',
  registry: 'app',
  censusSurface: 'app',
  upstream: 'firebase/app',
  mirrors: ['pyric/app'],
  observationPrefixes: ['app-registry-'],
  coverage: true,
  scopeNote:
    'out of scope: firebase-internal underscore plumbing (deny-listed). Deferred: initializeServerApp (SSR server-app semantics, no decided sandbox mirror). Handle shape beyond `name` (options / automaticDataCollectionEnabled) is prod-only and not claimed — the sandbox app handle is opaque by design.',
  conformanceSuite: 'packages/pyric/test/app/oracle-conformance.test.ts',
  captureRigs: ['app-registry'],
};
