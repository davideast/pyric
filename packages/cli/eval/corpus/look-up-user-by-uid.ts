import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'look-up-user-by-uid',
  prompt: 'What claims does jules_globex actually carry right now? Our Stripe webhook is treating them like an admin and I want to rule the sandbox out.',
  seed: {
    users: [
      { uid: 'jules_globex', email: 'jules@globex.test', tenant: 'tenant-globex', claims: { role: 'auditor' } },
    ],
  },
  acceptedFirstOperations: ['get_auth_user'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'get_auth_user' && c.ok)) {
      return 'the jules_globex record was never read';
    }
    return true;
  },
  tags: ['auth', 'tenant', 'read'],
};

export default task;
