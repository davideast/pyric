import { row } from './section.ts';

export default row({
  order: 200,
  api: 'Query.getDocuments(source:)',
  behavior: 'Executes query and returns QuerySnapshot from server, cache, or default source.',
  featureKeys: ['getDocuments'],
  flipped: 'unit-backed',
});
