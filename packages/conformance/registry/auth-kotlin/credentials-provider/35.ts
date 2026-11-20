import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseFirestore actAs stamping',
  behavior: 'FirebaseFirestore automatically stamps the CredentialsProvider effective AuthLens on all document operations and queries.',
  featureKeys: ['actAs', 'firestore'],
  flipped: 'unit-backed',
});
