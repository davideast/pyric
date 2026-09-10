import type { EvalTask } from '../types.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /invoices/{id} {
      allow read: if request.auth.token.firebase.tenant == 'tenant-acme';
    }
  }
}`;

const task: EvalTask = {
  id: 'sign-in-as-tenant-user-and-read-rules',
  prompt:
    'Sign the app in as riley@acme.test with the password hunter22, then show me what our invoice rules actually see for that session.',
  seed: {
    firestoreRules: RULES,
    firestore: { 'invoices/inv-1': { total: 240 } },
    users: [
      {
        uid: 'riley',
        email: 'riley@acme.test',
        password: 'hunter22',
        tenantId: 'tenant-acme',
        customClaims: { role: 'viewer' },
      },
    ],
  },
  acceptedFirstOperations: ['signin_auth_password'],
  assert: (state) => {
    if (!state.calls.some((call) => call.operation === 'signin_auth_password' && call.ok)) {
      return 'the app was never signed in';
    }
    const evaluated = state.calls.find(
      (call) => call.operation === 'simulate_firestore_rules' && call.ok,
    );
    if (!evaluated) return 'the rules were never evaluated for that session';
    const auth = (evaluated.data as { auth?: { uid?: string; token?: Record<string, unknown> } })
      ?.auth;
    if (auth?.uid !== 'riley') return `the evaluated identity was ${String(auth?.uid)}`;
    const firebase = auth.token?.firebase as { tenant?: string } | undefined;
    if (firebase?.tenant !== 'tenant-acme') return 'the tenant never reached the evaluated token';
    return true;
  },
  tags: ['auth', 'tenant', 'identity', 'multi-step'],
};

export default task;
