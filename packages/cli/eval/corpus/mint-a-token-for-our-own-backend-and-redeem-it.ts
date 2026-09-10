import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'mint-a-token-for-our-own-backend-and-redeem-it',
  prompt:
    'Our own backend hands the client a token instead of a password. Mint one for dana that says plan is pro, redeem it in the app, and tell me whether the plan claim reaches Security Rules.',
  seed: {
    users: [{ uid: 'dana', email: 'dana@example.test', password: 'hunter22' }],
    firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /reports/{id} {
      allow read: if request.auth.token.plan == 'pro';
    }
  }
}`,
    firestore: { 'reports/q3': { revenue: 12 } },
  },
  acceptedFirstOperations: ['create_auth_token'],
  assert: (state) => {
    if (!state.calls.some((call) => call.operation === 'create_auth_token' && call.ok)) {
      return 'no token was minted';
    }
    if (!state.calls.some((call) => call.operation === 'signin_auth_token' && call.ok)) {
      return 'the token was never redeemed';
    }
    const evaluated = state.calls.find(
      (call) => call.operation === 'simulate_firestore_rules' && call.ok,
    );
    if (!evaluated) return 'the claim was never checked against the rules';
    const decided = evaluated.data as { allowed?: boolean; auth?: { uid?: string } };
    if (decided.auth?.uid !== 'dana') return `the rules evaluated ${String(decided.auth?.uid)}`;
    if (decided.allowed !== true) return 'the plan claim did not reach the rules';
    return true;
  },
  tags: ['auth', 'identity', 'rules', 'multi-step'],
};

export default task;
