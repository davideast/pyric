import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseFirestorePlatform.instanceFor(app, databaseId)',
  behavior: 'Provides a distinct platform handle per FirebaseApp and database ID; production isolates the documents and rules of each named database.',
  featureKeys: ['instanceFor'],
  status: 'diverged-documented',
  statusNote: 'each database ID yields a distinct handle, but data is not isolated: the bridge does not carry the database ID, so every handle reaches (default)',
  evidence: 'cloud_firestore_platform_interface specification. The test asserts the handle carries its database ID; bridge operations carry no database field.',
});
