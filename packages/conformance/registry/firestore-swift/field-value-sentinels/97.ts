import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { LIVE_HOST_TYPES_SUITE, row } from './section.ts';

export default row({
  order: 60,
  api: 'FieldValue.vector(_:)',
  behavior: 'Constructs dense vector embedding from Double or Float array.',
  featureKeys: ['vector'],
  status: 'conforms',
  oracleObservations: ['firestore-swift-instance-snapshots-inSync-and-codable'],
  tests: [LIVE_HOST_TYPES_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
