import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DocumentReference.set(data)',
  behavior: 'Overwrites target document completely with provided map or POJO payload.',
  featureKeys: ['set'],
  flipped: 'unit-backed',
});
