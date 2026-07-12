import type { SurfaceDescriptorRecord } from './types.ts';

export const surface: SurfaceDescriptorRecord = {
  order: 8,
  maturity: 'Experimental, not yet in the published packages',
  kind: 'mirror',
  // Shares the messaging registry file and COMPAT doc; the admin send plane
  // (pyric-admin) captures under the `messaging-send-` prefix.
  registry: 'messaging',
  // Inert census mapping — messaging-admin is not published in coverage
  // (coverage: false), so this census surface is never read for it; it only
  // satisfies the descriptor shape.
  censusSurface: 'messaging',
  upstream: 'firebase/messaging',
  mirrors: ['pyric/messaging'],
  observationPrefixes: ['messaging-send-'],
  coverage: false,
  scopeNote:
    'not published here — the admin send plane mirrors firebase-admin, which has no runtime export census in this report; its rows are born unverified (behavior ~0). This entry is inert (messaging-admin is not in SERVICES).',
  conformanceSuite: 'packages/pyric-admin/test/messaging/oracle-conformance.test.ts',
  captureRigs: ['messaging-send'],
  climb: true,
};
