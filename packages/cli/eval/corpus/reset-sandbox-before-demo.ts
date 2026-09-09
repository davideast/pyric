import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'reset-sandbox-before-demo',
  prompt: 'Wipe the sandbox back to empty. I am about to record a demo and I want a clean slate.',
  seed: {
    users: [
      { uid: 'alice', email: 'alice@acme.test', tenantId: 'tenant-acme' },
      { uid: 'bob', email: 'bob@globex.test', tenantId: 'tenant-globex' },
    ],
    firestore: { 'posts/p1': { title: 'leftover' } },
  },
  acceptedFirstOperations: ['reset_sandbox'],
  assert: (state) => {
    if (state.users.list().length !== 0) return 'users remain after the reset';
    if (state.firestore.get('posts/p1')) return 'posts/p1 survived the reset';
    return true;
  },
  tags: ['sandbox', 'write'],
};

export default task;
