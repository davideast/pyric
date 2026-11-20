import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DatabaseReference.get()',
  behavior: 'Fetches a one-shot DataSnapshot of the current data at the reference path.',
  featureKeys: ['get'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
