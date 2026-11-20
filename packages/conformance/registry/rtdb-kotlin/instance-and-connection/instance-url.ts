import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseDatabase.getInstance(url) / Firebase.database(url)',
  behavior: 'Returns a distinct FirebaseDatabase handle for each database URL; production isolates the data and rules of each URL\'s database.',
  featureKeys: ['getInstanceUrl'],
  status: 'diverged-documented',
  statusNote: 'each URL yields a distinct handle, but data and rules are not isolated: the bridge does not carry the instance, so every handle reaches the default database',
  evidence: 'com.google.firebase:firebase-database specification. The test asserts a distinct handle and URL per instance; bridge operations carry no instance field.',
});
