import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ['ensureFirestoreConfigured', 'executeWrite'],
  api: 'ensureFirestoreConfigured / executeWrite',
  behavior:
    'Idempotent ensureFirestoreConfigured(db) client initialization and synchronous-guard executeWrite(db, mutations) startup and post-terminate failed-precondition checks across in-page, SharedWorker, and Node-hosted planes',
  evidence:
    'Production observation firestore-ensure-configured-and-execute-write replayed across in-page, SharedWorker, and Node-hosted planes',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['firestore-ensure-configured-and-execute-write'],
  conformanceTests: [
    'packages/pyric/test/firestore/oracle-captures/firestore-fieldvalue-and-execwrite.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-fieldvalue-and-execwrite.test.ts',
    'packages/pyric/test/firestore/writes-plumbing.test.ts',
    'packages/cli/test/serve/worker/client/firestore-fieldvalue-and-plumbing.test.ts',
  ],
});
