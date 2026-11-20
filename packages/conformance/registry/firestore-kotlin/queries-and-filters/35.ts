import { row } from './section.ts';

export default row({
  order: 150,
  api: 'Query.get(source)',
  behavior: 'Executes query and returns QuerySnapshot containing matched documents.',
  featureKeys: ['get'],
  flipped: 'unit-backed',
});
