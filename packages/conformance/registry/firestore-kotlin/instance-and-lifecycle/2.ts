import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseFirestore.getInstance(app, database) / Firebase.firestore(app, database)',
  behavior: 'Provides a distinct FirebaseFirestore handle per FirebaseApp and database ID; production isolates the documents and rules of each named database.',
  featureKeys: ['getInstance'],
  status: 'diverged-documented',
  statusNote: 'each database ID yields a distinct handle, but data is not isolated: the bridge does not carry the database ID, so every handle reaches (default)',
  evidence: 'com.google.firebase.firestore specification. The test asserts a distinct handle and databaseId per instance; bridge operations carry no database field.',
});
