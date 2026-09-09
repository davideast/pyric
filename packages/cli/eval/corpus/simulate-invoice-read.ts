import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'simulate-invoice-read',
  prompt: 'Would alice be allowed to read invoices/inv_101 under the current rules? She is signed in on tenant-acme.',
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
    users: [{ uid: 'alice', email: 'alice@acme.test', tenant: 'tenant-acme' }],
    firestore: {
      'invoices/inv_101': { tenant: 'tenant-acme', amount: 4200, status: 'open' },
    },
  },
  acceptedFirstOperations: ['simulate_firestore_rules'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'simulate_firestore_rules' && c.ok)) {
      return 'no rules verdict was requested for invoices/inv_101';
    }
    return true;
  },
  tags: ['rules', 'firestore', 'tenant', 'simulate'],
};

export default task;
