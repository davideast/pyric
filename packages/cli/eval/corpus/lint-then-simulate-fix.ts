import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'lint-then-simulate-fix',
  prompt: 'These rules get rejected on deploy. Work out what is wrong with them, then check that alice on tenant-acme can still read invoices/inv_101 once they parse.',
  seed: {
    firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /invoices/{invoiceId} {
      allow read: if request.auth != null
        && request.auth.token.firebase.tenant == resource.data.tenant
    }
  }
}
`,
    users: [{ uid: 'alice', email: 'alice@acme.test', tenant: 'tenant-acme' }],
    firestore: {
      'invoices/inv_101': { tenant: 'tenant-acme', amount: 4200, status: 'open' },
    },
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'lint_firestore_rules' && c.ok)) {
      return 'the rules were never linted';
    }
    if (!state.calls.some((c) => c.operation === 'simulate_firestore_rules' && c.ok)) {
      return 'no verdict was requested for the alice read';
    }
    return true;
  },
  tags: ['multi-step', 'rules', 'firestore', 'lint', 'simulate'],
};

export default task;
