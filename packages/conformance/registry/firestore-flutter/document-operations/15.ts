import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DocumentReferencePlatform.set(data)',
  behavior: 'Overwrites target document completely with provided map payload.',
  featureKeys: ['set'],
  flipped: 'unit-backed',
});
