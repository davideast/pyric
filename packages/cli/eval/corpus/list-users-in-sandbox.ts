import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'list-users-in-sandbox',
  prompt: 'Who is signed up in the sandbox right now? I lost track after the last seed script ran.',
  seed: {
    users: [
      { uid: 'alice', email: 'alice@acme.test', tenant: 'tenant-acme' },
      { uid: 'bob', email: 'bob@globex.test', tenant: 'tenant-globex' },
      { uid: 'admin', email: 'admin@acme.test', claims: { role: 'admin' } },
    ],
  },
  acceptedFirstOperations: ['list_auth_users'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'list_auth_users' && c.ok)) {
      return 'the sandbox user list was never read';
    }
    return true;
  },
  tags: ['auth', 'read'],
};

export default task;
