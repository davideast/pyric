import { row } from './section.ts';

export default row({
  order: 110,
  api: 'Query.whereFilter(_:)',
  behavior: 'Applies composite boolean Filter using andFilter or orFilter disjunctions.',
  featureKeys: ['whereFilter'],
  flipped: 'unit-backed',
});
