import { row } from './section.ts';

export default row({
  order: 70,
  api: 'DocumentReference.snapshots(metadataChanges)',
  behavior: 'Returns a Coroutine Flow emitting DocumentSnapshot on document changes.',
  featureKeys: ['snapshots'],
  flipped: 'unit-backed',
});
