import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FieldValue.serverTimestamp()',
  behavior: 'Encodes sentinel replaced by server commit timestamp during write.',
  featureKeys: ['serverTimestamp'],
  status: 'conforms',
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
