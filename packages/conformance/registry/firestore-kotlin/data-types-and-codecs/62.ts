import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DocumentReference codec',
  behavior: 'Encodes and decodes DocumentReference values stored within document fields.',
  featureKeys: ['DocumentReference'],
  status: 'conforms',
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
