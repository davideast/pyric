import { row } from './section.ts';

export default row({
  order: 10,
  api: 'DocumentReference.get(source)',
  behavior: 'Reads a single document snapshot from server or cache based on Source.',
  featureKeys: ['get'],
  flipped: 'unit-backed',
});
