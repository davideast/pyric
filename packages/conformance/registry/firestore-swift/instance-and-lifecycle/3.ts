import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Firestore.firestore(app:database:)',
  behavior: 'Returns a distinct handle per named database for the specified FirebaseApp; production isolates the documents and rules of each named database.',
  featureKeys: ['firestoreAppDatabase'],
  status: 'diverged-documented',
  statusNote: 'each database ID yields a distinct handle, but data is not isolated: the bridge does not carry the database ID, so every handle reaches (default)',
  evidence: 'FirebaseFirestore Swift specification. The test asserts the handle carries its database ID; bridge operations carry no database field.',
});
