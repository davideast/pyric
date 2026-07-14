import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 7,
  kind: 'mirror',
  registry: 'messaging',
  censusSurface: 'messaging',
  upstream: 'firebase/messaging',
  mirrors: ['pyric/messaging'],
  observationPrefixes: ['messaging-web-'],
  coverage: true,
  scopeNote:
    'the client and service-worker receive-plane rows are reviewed and run in the blocking pyric test suite; each bare service factory is exercised after standard default-app initialization. Surface coverage reflects the client entry point (firebase/messaging); the service-worker entry (messaging-sw census) and admin send plane (messaging-admin registry) are tracked separately.',
  conformanceSuite: 'packages/pyric/test/messaging/oracle-conformance.test.ts',
  captureRigs: ['messaging-web'],
  climb: true,
};
