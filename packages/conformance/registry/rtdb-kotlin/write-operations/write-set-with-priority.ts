import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DatabaseReference.setValue(value, priority)',
  behavior: 'Atomically writes the node value alongside its ordering priority metadata.',
  featureKeys: ['setValueWithPriority'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
