import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseFirestore.firestoreSettings',
  behavior: 'Configures host, sslEnabled, persistenceEnabled, and cacheSizeBytes via FirebaseFirestoreSettings.',
  featureKeys: ['settings'],
  flipped: 'unit-backed',
});
