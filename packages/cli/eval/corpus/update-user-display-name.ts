import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'update-user-display-name',
  prompt: 'Fix the display name on quinn_acme. It should read Quinn Alvarez, not quinn.',
  seed: {
    users: [{ uid: 'quinn_acme', email: 'quinn@acme.test', tenantId: 'tenant-acme' }],
  },
  acceptedFirstOperations: ['update_auth_user'],
  assert: (state) => {
    if (!state.users.get('quinn_acme')) return 'quinn_acme is gone';
    if (!state.calls.some((c) => c.operation === 'update_auth_user' && c.ok)) {
      return 'the quinn_acme profile was never updated';
    }
    return true;
  },
  tags: ['auth', 'write'],
};

export default task;
