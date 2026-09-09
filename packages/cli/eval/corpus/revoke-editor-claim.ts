import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'revoke-editor-claim',
  prompt: 'Take the editor role away from lee_acme. They should keep the beta flag they have.',
  seed: {
    users: [
      { uid: 'lee_acme', email: 'lee@acme.test', tenant: 'tenant-acme', claims: { role: 'editor', beta: true } },
    ],
  },
  acceptedFirstOperations: ['set_auth_claims', 'get_auth_user'],
  assert: (state) => {
    const user = state.users.get('lee_acme');
    if (!user) return 'lee_acme is gone';
    if (user.claims.role === 'editor') return 'lee_acme still carries the editor role claim';
    if (user.claims.beta !== true) return 'the beta claim was dropped';
    return true;
  },
  tags: ['auth', 'write'],
};

export default task;
