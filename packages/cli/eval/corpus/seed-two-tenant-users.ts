import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'seed-two-tenant-users',
  prompt: 'Set me up for an isolation test: one user on tenant-acme with uid ada_acme, one on tenant-globex with uid gus_globex.',
  seed: {},
  acceptedFirstOperations: ['create_auth_user'],
  assert: (state) => {
    const ada = state.users.get('ada_acme');
    const gus = state.users.get('gus_globex');
    if (!ada) return 'ada_acme was not created';
    if (!gus) return 'gus_globex was not created';
    if (ada.tenant !== 'tenant-acme') return 'ada_acme is not on tenant-acme';
    if (gus.tenant !== 'tenant-globex') return 'gus_globex is not on tenant-globex';
    return true;
  },
  tags: ['auth', 'tenant', 'write'],
};

export default task;
