import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'seed-sandbox-from-snapshot',
  prompt: 'Load my starting fixture: a user alice on tenant-acme, and a document at orgs/acme with plan set to team.',
  seed: {},
  acceptedFirstOperations: ['seed_sandbox', 'create_auth_user', 'write_firestore_document'],
  assert: (state) => {
    const user = state.users.get('alice');
    if (!user) return 'alice was not seeded';
    if (user.tenant !== 'tenant-acme') return 'alice is not on tenant-acme';
    const org = state.firestore.get('orgs/acme');
    if (!org) return 'orgs/acme was not seeded';
    if (org.plan !== 'team') return 'orgs/acme is not on the team plan';
    return true;
  },
  tags: ['sandbox', 'tenant', 'write'],
};

export default task;
