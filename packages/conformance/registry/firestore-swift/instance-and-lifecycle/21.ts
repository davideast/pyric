import { row } from './section.ts';

export default row({
  order: 210,
  api: 'Firestore.getQuery(named:completion:)',
  behavior: 'Retrieves a named query from a previously loaded Firestore bundle.',
  featureKeys: ['getQuery'],
});
