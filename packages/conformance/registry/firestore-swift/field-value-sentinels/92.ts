import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 10,
  api: 'FieldValue.serverTimestamp()',
  behavior: 'Sentinel replaced by server commit timestamp during write processing.',
  featureKeys: ['serverTimestamp'],
  status: 'conforms',
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
