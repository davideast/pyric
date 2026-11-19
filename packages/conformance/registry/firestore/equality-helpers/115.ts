import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ['refEqual'],
  behavior:
    '`refEqual(ref, foreignObject)` returns `false` without throwing when compared against plain or unrecognized foreign objects',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    'Oracle: `firestore-offline-cache-init-index-and-refequal.json` (`refEqualChecks`) replayed across in-page, SharedWorker, and Node-hosted planes.',
  oracleObservations: ['firestore-offline-cache-init-index-and-refequal'],
  conformanceTests: [
    'packages/pyric/test/firestore/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
  ],
});
