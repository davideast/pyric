import type { SurfaceDescriptorRecord } from './types.ts';

/**
 * `pyric/app` — the client app-management surface, and the initialization path
 * every user hits first. A MIRROR surface: the export census diffs
 * `firebase/app`'s runtime exports against `pyric/app`'s. Formerly census-only
 * (no COMPAT matrix); it now has a full registry (registry/app.ts), a capture
 * rig (rigs/app-registry.ts → `app-registry-*` observations), and a replay
 * suite (packages/pyric/test/app/oracle-conformance.test.ts), plus a real-browser
 * production multi-app topology rig and twin replay, so it publishes
 * both surface and behavior coverage.
 */
export const surface: SurfaceDescriptorRecord = {
  order: 1,
  kind: 'mirror',
  registry: 'app',
  censusSurface: 'app',
  upstream: 'firebase/app',
  mirrors: ['pyric/app'],
  observationPrefixes: ['app-registry-', 'app-production-'],
  coverage: true,
  scopeNote:
    'out of scope: firebase-internal underscore plumbing (deny-listed). Deferred: initializeServerApp (SSR server-app semantics, no decided sandbox mirror). Client app handles, settings, named registries, and per-app service containers are mirrored. Intentional limit: one FirebaseOptions configuration per runtime because every app container connects to one sandbox backend.',
  conformanceSuite: 'packages/pyric/test/app/oracle-conformance.test.ts',
  captureRigs: ['app-registry', 'app-production'],
};
