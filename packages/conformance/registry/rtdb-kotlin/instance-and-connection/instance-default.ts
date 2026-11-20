import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseDatabase.getInstance() / Firebase.database',
  behavior: 'Returns the default FirebaseDatabase instance bound to the active bridge connection.',
  featureKeys: ['getInstance'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
