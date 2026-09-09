import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'seed-tenant-billing-admin',
  prompt: 'Add a billing admin for the acme tenant so I can reproduce a support ticket. Use uid dana_acme, email dana@acme.test, tenant tenant-acme, and a custom claim role of billingAdmin.',
  seed: {},
  acceptedFirstOperations: ['create_auth_user'],
  assert: (state) => {
    const user = state.users.get('dana_acme');
    if (!user) return 'dana_acme was not created';
    if (user.tenant !== 'tenant-acme') return 'dana_acme is not on tenant-acme';
    if (user.claims.role !== 'billingAdmin') return 'dana_acme is missing the billingAdmin role claim';
    return true;
  },
  tags: ['auth', 'tenant', 'write'],
};

export default task;
