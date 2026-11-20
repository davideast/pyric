import { row } from './section.ts';

export default row({
  order: 20,
  api: 'DatabaseReference.set(null)',
  behavior: 'Deletes data at the reference path when set is called with null.',
  featureKeys: ['setNull'],
});
