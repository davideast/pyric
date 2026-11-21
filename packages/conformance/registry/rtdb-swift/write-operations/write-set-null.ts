import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DatabaseReference.setValue(nil)',
  behavior: 'Deletes data at the reference path when setValue is called with nil.',
  featureKeys: ['setValueNil'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: ['rtdb-swift-navigation-push-priorities-and-snapshots'],
});
