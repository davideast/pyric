import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_LIFECYCLE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 180,
  api: 'Firestore.waitForPendingWrites()',
  behavior: 'Awaits backend acknowledgment of all pending local writes.',
  featureKeys: ['waitForPendingWrites'],
  status: 'conforms',
  tests: [LIVE_HOST_LIFECYCLE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
