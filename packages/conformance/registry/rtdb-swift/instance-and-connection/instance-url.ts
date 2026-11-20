import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Database.database(url:)',
  behavior: 'Returns a distinct Database handle for each database URL; production isolates the data and rules of each URL\'s database.',
  featureKeys: ['databaseUrl'],
  status: 'diverged-documented',
  statusNote: 'each URL yields a distinct handle, but data and rules are not isolated: the bridge does not carry the instance, so every handle reaches the default database',
  evidence: 'FirebaseDatabase Swift specification. The test asserts the handle carries its URL; bridge operations carry no instance field.',
});
