import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'switch-to-tenant-identity',
  prompt: 'Let me browse as riley_acme on tenant-acme for a minute so I can see exactly what that account sees.',
  seed: {
    users: [
      { uid: 'riley_acme', email: 'riley@acme.test', tenantId: 'tenant-acme', customClaims: { role: 'viewer' } },
    ],
  },
  acceptedFirstOperations: ['switch_auth_identity'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'switch_auth_identity' && c.ok)) {
      return 'the active identity was never switched';
    }
    return true;
  },
  tags: ['auth', 'tenant', 'identity'],
};

export default task;
