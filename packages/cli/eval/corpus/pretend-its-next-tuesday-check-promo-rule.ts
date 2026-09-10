import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'pretend-its-next-tuesday-check-promo-rule',
  prompt:
    "Pretend it's next Tuesday, September 15th, and check whether the summer-sale promo doc still allows a read.",
  seed: {
    firestoreRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /promos/{promoId} {
      allow read: if request.time < timestamp.date(2026, 9, 12);
    }
  }
}`,
    firestore: { 'promos/summer-sale': { active: true } },
  },
  acceptedFirstOperations: ['set_clock'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'set_clock' && c.ok)) {
      return 'the clock was never pinned';
    }
    const simulated = state.calls.find((c) => c.operation === 'simulate_firestore_rules' && c.ok);
    if (simulated === undefined) return 'the promo rule was never simulated';
    const allowed = (simulated.data as { allowed?: boolean } | undefined)?.allowed;
    if (allowed !== false) return 'the promo should have expired by next Tuesday';
    return true;
  },
  tags: ['sandbox', 'rules', 'multi-step'],
};

export default task;
