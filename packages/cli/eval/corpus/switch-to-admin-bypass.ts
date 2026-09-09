import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'switch-to-admin-bypass',
  prompt: 'Rules keep blocking me while I set up fixtures. Put me in admin bypass until I say otherwise.',
  seed: {},
  acceptedFirstOperations: ['switch_auth_identity'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'switch_auth_identity' && c.ok)) {
      return 'the active identity was never switched to admin';
    }
    return true;
  },
  tags: ['auth', 'identity'],
};

export default task;
