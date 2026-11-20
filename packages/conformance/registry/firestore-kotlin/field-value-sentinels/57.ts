import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FieldValue.arrayUnion(elements)',
  behavior: 'Encodes transformation adding elements to array field if absent.',
  featureKeys: ['arrayUnion'],
  status: 'conforms',
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
