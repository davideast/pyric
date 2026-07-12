import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 7,
  maturity: 'Experimental, not yet in the published packages',
  kind: 'mirror',
  registry: 'messaging',
  censusSurface: 'messaging',
  upstream: 'firebase/messaging',
  mirrors: ['pyric/messaging'],
  observationPrefixes: ['messaging-web-'],
  coverage: true,
  scopeNote:
    'born unverified: every row is authored under Conformance Driven Development and starts unverified, so behavior conformance is ~0 by design — the receive-plane conformance suite is climb-gated (on-demand) and no row has been reviewed and flipped to conforms yet. Surface coverage reflects the client entry point (firebase/messaging); the service-worker entry (messaging-sw census) and admin send plane (messaging-admin registry) are tracked separately.',
  conformanceSuite: 'packages/pyric/test/messaging/oracle-conformance.test.ts',
  captureRigs: ['messaging-web'],
  climb: true,
};
