import { LIVE_HOST_CONFORMANCE_TEST, LIVE_HOST_SNAPSHOTS_SUITE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 60,
  api: 'QuerySnapshot.documents / documentChanges',
  behavior: 'Provides ordered List<DocumentSnapshot> and List<DocumentChange> detailing change types.',
  featureKeys: ['documents', 'documentChanges'],
  status: 'conforms',
  oracleObservations: ['firestore-kotlin-queries-cursors-listeners-and-aggregations'],
  tests: [LIVE_HOST_SNAPSHOTS_SUITE],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
