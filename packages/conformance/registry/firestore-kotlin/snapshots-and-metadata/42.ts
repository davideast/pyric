import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DocumentSnapshot.toObject<T>()',
  behavior: 'Deserializes snapshot into typed data object via reified extension function.',
  featureKeys: ['toObject'],
  flipped: 'unit-backed',
});
