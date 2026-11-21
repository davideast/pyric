import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Database.database()',
  behavior: 'Returns the default Database instance bound to the active bridge connection.',
  featureKeys: ['database'],
  status: 'conforms',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
  oracleObservations: ['rtdb-swift-navigation-push-priorities-and-snapshots'],
});
