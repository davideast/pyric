import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_CORE_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Nested Map and List collections',
  behavior: 'Deeply encodes and revives recursive nested Maps and Lists containing mixed primitives and sentinels.',
  featureKeys: ['data'],
  status: 'conforms',
  tests: [LIVE_HOST_CORE_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
