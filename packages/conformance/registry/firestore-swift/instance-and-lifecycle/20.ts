import { row } from './section.ts';

export default row({
  order: 200,
  api: 'Firestore.loadBundle(_:)',
  behavior: 'Loads serialized Firestore bundle data into the local cache.',
  featureKeys: ['loadBundle'],
});
