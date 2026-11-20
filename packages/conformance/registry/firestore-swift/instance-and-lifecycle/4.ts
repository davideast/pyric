import { row } from './section.ts';

export default row({
  order: 40,
  api: 'Firestore.firestore(database:)',
  behavior: 'Returns a distinct handle per named database for the default FirebaseApp; production isolates the documents and rules of each named database.',
  featureKeys: ['firestoreDatabase'],
  status: 'diverged-documented',
  statusNote: 'each database ID yields a distinct handle, but data is not isolated: the bridge does not carry the database ID, so every handle reaches (default)',
  evidence: 'FirebaseFirestore Swift specification. The test asserts the handle carries its database ID; bridge operations carry no database field.',
});
