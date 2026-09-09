import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'delete-departed-user',
  prompt: 'morgan_acme left the company last week. Remove that account from the sandbox.',
  seed: {
    users: [
      { uid: 'morgan_acme', email: 'morgan@acme.test', tenantId: 'tenant-acme' },
      { uid: 'wren_acme', email: 'wren@acme.test', tenantId: 'tenant-acme' },
    ],
  },
  acceptedFirstOperations: ['delete_auth_user'],
  assert: (state) => {
    if (state.users.get('morgan_acme')) return 'morgan_acme still exists';
    if (!state.users.get('wren_acme')) return 'wren_acme was removed as well';
    return true;
  },
  tags: ['auth', 'write'],
};

export default task;
