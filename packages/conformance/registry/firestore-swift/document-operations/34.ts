import { row } from './section.ts';

export default row({
  order: 130,
  api: 'DocumentReference.addSnapshotListener(options:listener:)',
  behavior: 'Listens to document updates configured with SnapshotListenOptions.',
  featureKeys: ['addSnapshotListenerOptions'],
  flipped: 'unit-backed',
});
