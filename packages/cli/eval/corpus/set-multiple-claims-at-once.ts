import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'set-multiple-claims-at-once',
  prompt: 'toby_globex needs two custom claims for the new reviewer flow: role of reviewer and region of eu. Set both.',
  seed: {
    users: [{ uid: 'toby_globex', email: 'toby@globex.test', tenantId: 'tenant-globex' }],
  },
  acceptedFirstOperations: ['set_auth_claims'],
  assert: (state) => {
    const user = state.users.get('toby_globex');
    if (!user) return 'toby_globex is gone';
    if (user.claims.role !== 'reviewer') return 'the reviewer role claim is missing';
    if (user.claims.region !== 'eu') return 'the eu region claim is missing';
    return true;
  },
  tags: ['auth', 'tenant', 'write'],
};

export default task;
