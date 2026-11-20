import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  api: 'FirebaseFirestore.batch()',
  behavior: 'Instantiates a WriteBatch for atomic batched mutations.',
  featureKeys: ['batch'],
  status: 'conforms',
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
