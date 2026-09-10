import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'advance-clock-an-hour-check-session-token',
  prompt:
    "Advance the clock an hour and see whether dana's session is still accepted for a read.",
  seed: {
    firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /accounts/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
  }
}`,
    users: [{ uid: 'dana', email: 'dana@example.com' }],
    firestore: { 'accounts/dana': { plan: 'pro' } },
  },
  acceptedFirstOperations: ['advance_clock'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'advance_clock' && c.ok)) {
      return 'the clock was never advanced';
    }
    const simulated = state.calls.find((c) => c.operation === 'simulate_firestore_rules' && c.ok);
    if (simulated === undefined) return "dana's session was never checked against the rule";
    const allowed = (simulated.data as { allowed?: boolean } | undefined)?.allowed;
    if (allowed !== true) return "dana's session should still be accepted an hour later";
    return true;
  },
  tags: ['sandbox', 'rules', 'auth', 'multi-step'],
};

export default task;
