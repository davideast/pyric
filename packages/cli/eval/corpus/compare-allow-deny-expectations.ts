import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'compare-allow-deny-expectations',
  prompt: 'I expect alice to be allowed on invoices/inv_101 and bob to be denied. Check both against the current rules and tell me which expectation is wrong.',
  seed: {
    firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /invoices/{invoiceId} {
      allow read: if request.auth != null
        && request.auth.token.firebase.tenant == resource.data.tenant;
    }
  }
}
`,
    users: [
      { uid: 'alice', email: 'alice@acme.test', tenant: 'tenant-acme' },
      { uid: 'bob', email: 'bob@globex.test', tenant: 'tenant-globex' },
    ],
    firestore: {
      'invoices/inv_101': { tenant: 'tenant-acme', amount: 4200, status: 'open' },
    },
  },
  acceptedFirstOperations: ['simulate_firestore_rules', 'diagnose_firestore_denial'],
  assert: (state) => {
    const verdicts = state.calls.filter(
      (c) =>
        (c.operation === 'simulate_firestore_rules' || c.operation === 'diagnose_firestore_denial') &&
        c.ok,
    );
    if (verdicts.length < 2) return 'both expectations were not checked against the rules';
    return true;
  },
  tags: ['rules', 'firestore', 'tenant', 'simulate'],
};

export default task;
