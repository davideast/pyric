import { row } from './section.ts';

export default row({
  order: 160,
  api: 'Query.snapshots(metadataChanges)',
  behavior: 'Returns a Coroutine Flow emitting QuerySnapshot upon matching changes.',
  featureKeys: ['snapshots'],
  flipped: 'unit-backed',
});
