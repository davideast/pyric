import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Database.database(url:)',
  behavior: 'Returns a distinct Database handle for each database URL; production isolates the data and rules of each URL\'s database.',
  featureKeys: ['databaseUrl'],
  status: 'conforms',
  evidence: 'FirebaseDatabase Swift specification. Live-host 11-shard suite (`RtdbLiveHostConformanceTests.swift`) isolates data and rules across default + `shard-00..shard-09` over a single shared bridge connection.',
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
