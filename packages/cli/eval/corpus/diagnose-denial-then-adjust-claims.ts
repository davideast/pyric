import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'diagnose-denial-then-adjust-claims',
  prompt: 'sasha_acme cannot read invoices/inv_701 and our Datadog trace is no help. Work out why the rules deny it, then fix the account so the read passes.',
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
    users: [{ uid: 'sasha_acme', email: 'sasha@acme.test', tenant: 'tenant-acme', claims: { role: 'viewer' } }],
    firestore: {
      'invoices/inv_701': { tenant: 'tenant-acme', amount: 320, status: 'open' },
    },
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    const traced = state.calls.some(
      (c) =>
        (c.operation === 'diagnose_firestore_denial' || c.operation === 'simulate_firestore_rules') &&
        c.ok,
    );
    if (!traced) return 'the denial was never traced';
    const user = state.users.get('sasha_acme');
    if (!user) return 'sasha_acme is gone';
    if (user.claims.role !== 'billingAdmin') return 'sasha_acme still lacks the role the rules require';
    return true;
  },
  tags: ['multi-step', 'rules', 'auth', 'tenant', 'diagnose'],
};

export default task;
