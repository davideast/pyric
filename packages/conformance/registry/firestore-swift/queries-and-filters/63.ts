import { row } from './section.ts';

export default row({
  order: 230,
  api: 'Query.addSnapshotListener(options:listener:)',
  behavior: 'Attaches real-time query listener configured with SnapshotListenOptions.',
  featureKeys: ['addQuerySnapshotListenerOptions'],
  flipped: 'unit-backed',
});
