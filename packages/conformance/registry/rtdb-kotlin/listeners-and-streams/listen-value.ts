import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Query.snapshots / addValueEventListener',
  behavior: 'Emits DataSnapshot initially and upon any data change at the path via Kotlin Flow or listener.',
  featureKeys: ['snapshots', 'addValueEventListener'],
});
