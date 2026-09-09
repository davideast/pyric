import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'check-claims-on-tenant-user',
  prompt: 'Before I debug the invoice rules, confirm which tenant wren_acme belongs to and what claims are on the account.',
  seed: {
    users: [
      { uid: 'wren_acme', email: 'wren@acme.test', tenant: 'tenant-acme', claims: { role: 'billingAdmin' } },
    ],
  },
  acceptedFirstOperations: ['get_auth_user'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'get_auth_user' && c.ok)) {
      return 'the wren_acme record was never read';
    }
    return true;
  },
  tags: ['auth', 'tenant', 'read'],
};

export default task;
