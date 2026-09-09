import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'diagnose-invoice-denial',
  prompt: "Why can't alice read invoice inv_101? The app just shows permission denied and I need the actual reason.",
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
    users: [{ uid: 'alice', email: 'alice@acme.test', tenant: 'tenant-globex' }],
    firestore: {
      'invoices/inv_101': { tenant: 'tenant-acme', amount: 4200, status: 'open' },
    },
  },
  acceptedFirstOperations: ['diagnose_firestore_denial', 'simulate_firestore_rules'],
  assert: (state) => {
    const asked = state.calls.some(
      (c) =>
        (c.operation === 'diagnose_firestore_denial' || c.operation === 'simulate_firestore_rules') &&
        c.ok,
    );
    if (!asked) return 'the denial on invoices/inv_101 was never traced';
    return true;
  },
  tags: ['rules', 'firestore', 'tenant', 'diagnose'],
};

export default task;
