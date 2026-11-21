import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseDatabase.getInstance(url) / Firebase.database(url)',
  behavior: 'Returns a distinct FirebaseDatabase handle for each database URL; production isolates the data and rules of each URL\'s database.',
  featureKeys: ['getInstanceUrl'],
  status: 'conforms',
  evidence: 'com.google.firebase:firebase-database specification. Live-host 11-shard suite (`LiveHostConformanceTest.kt`) isolates data, listeners, and rules across default + `shard-00..shard-09` over a single shared bridge connection.',
  oracleObservations: ['rtdb-kotlin-dedicated-crud-and-query-order'],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
