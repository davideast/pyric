import { row } from './section.ts';

export default row({
  order: 210,
  api: 'Query.addSnapshotListener(_:)',
  behavior: 'Attaches real-time query listener returning ListenerRegistration handle.',
  featureKeys: ['addQuerySnapshotListener'],
  flipped: 'unit-backed',
});
