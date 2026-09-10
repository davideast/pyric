import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'grant-admin-claim-existing-user',
  prompt: 'Priya got promoted. Give priya_acme the custom claim role of orgAdmin. She stays on the acme tenant.',
  seed: {
    users: [
      { uid: 'priya_acme', email: 'priya@acme.test', tenantId: 'tenant-acme', customClaims: { role: 'member' } },
    ],
  },
  acceptedFirstOperations: ['set_auth_claims', 'get_auth_user'],
  assert: (state) => {
    const user = state.users.get('priya_acme');
    if (!user) return 'priya_acme is gone';
    if (user.claims.role !== 'orgAdmin') return 'priya_acme does not carry the orgAdmin role claim';
    return true;
  },
  tags: ['auth', 'tenant', 'write'],
};

export default task;
