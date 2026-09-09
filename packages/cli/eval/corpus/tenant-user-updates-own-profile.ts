import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'tenant-user-updates-own-profile',
  prompt: 'As riley_acme, set the displayName on profiles/riley_acme to Riley Chen. Own-profile writes are allowed by the rules.',
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
    users: [{ uid: 'riley_acme', email: 'riley@acme.test', tenantId: 'tenant-acme' }],
    firestore: {
      'profiles/riley_acme': { displayName: 'riley', tenant: 'tenant-acme' },
    },
  },
  acceptedFirstOperations: ['switch_auth_identity', 'update_firestore_document'],
  assert: (state) => {
    const doc = state.firestore.get('profiles/riley_acme');
    if (!doc) return 'profiles/riley_acme is gone';
    if (doc.displayName !== 'Riley Chen') return 'the displayName was not updated';
    if (!state.calls.some((c) => c.operation === 'switch_auth_identity' && c.ok)) {
      return 'the write was not made as riley_acme';
    }
    return true;
  },
  tags: ['firestore', 'tenant', 'auth', 'write'],
};

export default task;
