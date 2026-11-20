import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ['FieldValue'],
  behavior:
    'FieldValue runtime base class inherited by deleteField(), serverTimestamp(), increment(), arrayUnion(), and arrayRemove() (not vector()), with structural .isEqual() across in-page, SharedWorker, and Node-hosted planes',
  evidence:
    'Production observation firestore-field-value-class-and-equality replayed across in-page, SharedWorker, and Node-hosted planes',
  status: 'conforms',
  risk: ['specific-value'],
  riskScore: 2,
  riskReasons: ['asserts 1 specific value(s)'],
  automation: 'oracle-backed',
  oracleObservations: ['firestore-field-value-class-and-equality'],
  conformanceTests: [
    'packages/pyric/test/firestore/oracle-captures/firestore-fieldvalue-and-execwrite.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/firestore-fieldvalue-and-execwrite.test.ts',
    'packages/pyric/test/firestore/writes-plumbing.test.ts',
    'packages/cli/test/serve/worker/client/firestore-fieldvalue-and-plumbing.test.ts',
  ],
});
