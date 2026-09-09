import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'grant-claim-then-verify-read',
  prompt: 'otto_acme keeps getting permission denied on invoices/inv_601. Give the account the billingAdmin role and then confirm the read actually goes through as otto.',
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
    users: [{ uid: 'otto_acme', email: 'otto@acme.test', tenant: 'tenant-acme' }],
    firestore: {
      'invoices/inv_601': { tenant: 'tenant-acme', amount: 990, status: 'open' },
    },
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    const user = state.users.get('otto_acme');
    if (!user) return 'otto_acme is gone';
    if (user.claims.role !== 'billingAdmin') return 'otto_acme still lacks the billingAdmin role claim';
    const verified = state.calls.some(
      (c) =>
        (c.operation === 'get_firestore_document' || c.operation === 'simulate_firestore_rules') &&
        c.ok,
    );
    if (!verified) return 'the read was never verified after the claim change';
    return true;
  },
  tags: ['multi-step', 'auth', 'tenant', 'rules'],
};

export default task;
