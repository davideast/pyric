import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'write-doc-as-tenant-user',
  prompt: 'Acting as dana_acme, write invoices/inv_401 for tenant-acme with amount 500 and status open. The rules should let that through.',
  seed: {
    firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /invoices/{invoiceId} {
      allow read: if request.auth != null
        && request.auth.token.firebase.tenant == resource.data.tenant;
      allow write: if request.auth != null
        && request.auth.token.role == 'billingAdmin'
        && request.auth.token.firebase.tenant == request.resource.data.tenant;
    }
    match /profiles/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
`,
    users: [
      {
        uid: 'dana_acme',
        email: 'dana@acme.test',
        tenantId: 'tenant-acme',
        customClaims: { role: 'billingAdmin' },
      },
    ],
  },
  acceptedFirstOperations: ['switch_auth_identity', 'write_firestore_document'],
  assert: (state) => {
    const doc = state.firestore.get('invoices/inv_401');
    if (!doc) return 'invoices/inv_401 was not written';
    if (doc.tenant !== 'tenant-acme') return 'invoices/inv_401 is not on tenant-acme';
    if (doc.amount !== 500) return 'the amount field is not 500';
    if (!state.calls.some((c) => c.operation === 'switch_auth_identity' && c.ok)) {
      return 'the write was not made as dana_acme';
    }
    return true;
  },
  tags: ['firestore', 'tenant', 'auth', 'write'],
};

export default task;
