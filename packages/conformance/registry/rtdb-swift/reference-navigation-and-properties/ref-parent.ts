import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DatabaseReference.parent',
  behavior: 'Returns the parent DatabaseReference, or nil when called on the root reference.',
  featureKeys: ['parent'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
