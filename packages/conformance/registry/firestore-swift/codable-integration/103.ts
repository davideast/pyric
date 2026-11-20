import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 10,
  api: '@DocumentID',
  behavior: 'Property wrapper populating document ID on decoding; omitted from write payloads.',
  featureKeys: ['documentIDPropertyWrapper'],
  status: 'conforms',
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
