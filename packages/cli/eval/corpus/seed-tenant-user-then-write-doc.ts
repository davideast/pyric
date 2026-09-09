import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'seed-tenant-user-then-write-doc',
  prompt: 'Create nina_acme on tenant-acme with the billingAdmin role, then write invoices/inv_501 for that tenant with amount 750 as nina, then read it back so I know the rules let it through.',
  seed: {
    firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /invoices/{invoiceId} {
      allow read: if request.auth != null
        && request.auth.token.role == 'billingAdmin'
        && request.auth.token.firebase.tenant == resource.data.tenant;
      allow write: if request.auth != null
        && request.auth.token.role == 'billingAdmin';
    }
    match /profiles/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /porfiles/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
`,
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    const user = state.users.get('nina_acme');
    if (!user) return 'nina_acme was not created';
    if (user.claims.role !== 'billingAdmin') return 'nina_acme is missing the billingAdmin role claim';
    const doc = state.firestore.get('invoices/inv_501');
    if (!doc) return 'invoices/inv_501 was not written';
    if (doc.amount !== 750) return 'the amount field is not 750';
    if (!state.calls.some((c) => c.operation === 'get_firestore_document' && c.ok)) {
      return 'invoices/inv_501 was never read back';
    }
    return true;
  },
  tags: ['multi-step', 'auth', 'tenant', 'firestore', 'write'],
};

export default task;
