import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'disable-user-account',
  prompt: 'Suspend casey_acme without deleting the account. We may re-enable it next week.',
  seed: {
    users: [{ uid: 'casey_acme', email: 'casey@acme.test', tenantId: 'tenant-acme' }],
  },
  acceptedFirstOperations: ['update_auth_user'],
  assert: (state) => {
    if (!state.users.get('casey_acme')) return 'casey_acme was deleted instead of suspended';
    if (!state.calls.some((c) => c.operation === 'update_auth_user' && c.ok)) {
      return 'the casey_acme account was never updated';
    }
    return true;
  },
  tags: ['auth', 'write'],
};

export default task;
