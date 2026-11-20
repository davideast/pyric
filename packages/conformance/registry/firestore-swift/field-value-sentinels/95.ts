import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 40,
  api: 'FieldValue.arrayUnion(_:)',
  behavior: 'Transformation adding unique elements to array field if absent.',
  featureKeys: ['arrayUnion'],
  status: 'conforms',
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
