import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'DatabaseReference.push()',
  behavior: 'Generates a new child DatabaseReference with a chronologically ordered unique push ID.',
  featureKeys: ['push'],
  status: 'conforms',
  oracleObservations: ['rtdb-kotlin-navigation-push-priorities-and-snapshots'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
