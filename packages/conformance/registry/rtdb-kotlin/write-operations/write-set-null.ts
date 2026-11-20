import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DatabaseReference.setValue(null)',
  behavior: 'Deletes data at the reference path when setValue is called with null.',
  featureKeys: ['setValueNull'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
