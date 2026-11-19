import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['refEqual'],
  status: 'conforms',
  automation: 'oracle-backed',
  behavior: '`refEqual(a, b)` - true when paths match under the same target',
  evidence:
    '`unit:sandbox-target.test.ts`, oracle: `firestore-refequal-and-aggregate-equality.json` and `firestore-offline-cache-init-index-and-refequal.json`',
  oracleObservations: [
    'firestore-refequal-and-aggregate-equality',
    'firestore-offline-cache-init-index-and-refequal',
  ],
  conformanceTests: [
    'packages/pyric/test/firestore/sandbox-target.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-txn-batch-equality-classes.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-txn-batch-equality-classes.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
  ],
});
