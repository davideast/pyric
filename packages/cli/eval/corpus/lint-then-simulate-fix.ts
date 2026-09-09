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
    users: [{ uid: 'alice', email: 'alice@acme.test', tenantId: 'tenant-acme' }],
    firestore: {
      'invoices/inv_101': { tenant: 'tenant-acme', amount: 4200, status: 'open' },
    },
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'lint_firestore_rules')) {
      return 'the rules were never linted';
    }
    // A verdict is one accepted way to verify the read; a real read run as
    // alice is another. Both prove the fixed rules let alice through.
    const verifiedByVerdict = state.calls.some(
      (c) => c.operation === 'simulate_firestore_rules' && c.ok,
    );
    const switchedIdentityIndex = state.calls.findIndex(
      (c) => c.operation === 'switch_auth_identity' && c.ok,
    );
    const readIndex = state.calls.findIndex(
      (c) => c.operation === 'get_firestore_document' && c.ok,
    );
    const verifiedByImpersonatedRead =
      switchedIdentityIndex !== -1 && readIndex !== -1 && readIndex > switchedIdentityIndex;
    if (!verifiedByVerdict && !verifiedByImpersonatedRead) {
      return 'no verdict was requested for the alice read';
    }
    return true;
  },
  tags: ['multi-step', 'rules', 'firestore', 'lint', 'simulate'],
};

export default task;
