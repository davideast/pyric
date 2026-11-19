import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ['setLogLevel'],
  api: 'setLogLevel',
  behavior:
    'Accepts all six `LogLevel` values (`debug`, `verbose`, `info`, `warn`, `error`, `silent`) and returns `undefined` synchronously without throwing',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    '`unit:firestore/tier1-cache-init-align.test.ts`, oracle: `firestore-offline-cache-init-index-and-refequal.json` (`setLogLevelOutcomes`) replayed across in-page, SharedWorker, and Node-hosted planes.',
  oracleObservations: ['firestore-offline-cache-init-index-and-refequal'],
  conformanceTests: [
    'packages/pyric/test/firestore/tier1-cache-init-align.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-offline-cache-init-index-and-refequal.test.ts',
  ],
});
