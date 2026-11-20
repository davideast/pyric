import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 20,
  api: '@ServerTimestamp',
  behavior: 'Property wrapper encoding nil as serverTimestamp sentinel on write.',
  featureKeys: ['serverTimestampPropertyWrapper'],
  status: 'conforms',
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
