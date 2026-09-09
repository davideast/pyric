import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'switch-to-anonymous-visitor',
  prompt: 'Drop me to a signed-out visitor. I want to check what the public marketing collection returns to strangers.',
  seed: {
    firestore: {
      'marketing/home': { headline: 'Ship faster', published: true },
    },
  },
  acceptedFirstOperations: ['switch_auth_identity'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'switch_auth_identity' && c.ok)) {
      return 'the active identity was never switched to an anonymous visitor';
    }
    return true;
  },
  tags: ['auth', 'identity'],
};

export default task;
