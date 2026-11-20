import { row } from './section.ts';

export default row({
  order: 20,
  api: 'PyricDatabase.instanceFor(databaseURL)',
  behavior: 'Returns a distinct Realtime Database handle for each database URL; production isolates the data and rules of each URL\'s database.',
  featureKeys: ['instanceFor'],
  status: 'diverged-documented',
  statusNote: 'each URL yields a distinct handle, but data and rules are not isolated: the bridge does not carry the instance, so every handle reaches the default database',
  evidence: 'Verified by packages/flutter-client/test/rtdb_conformance_test.dart, which asserts the handle carries its URL; bridge operations carry no instance field.',
});
