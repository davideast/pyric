import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 70,
  api: 'DataSnapshot.priority',
  behavior: 'Returns the priority value (String, Number, or null) associated with the snapshot node.',
  featureKeys: ['priority'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
