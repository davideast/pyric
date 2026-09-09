import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'read-back-org-profile',
  prompt: 'Show me what is currently stored at orgs/acme. I think the plan field is stale.',
  seed: {
    firestore: {
      'orgs/acme': { name: 'Acme Corp', plan: 'team', seats: 12 },
    },
  },
  acceptedFirstOperations: ['get_firestore_document'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'get_firestore_document' && c.ok)) {
      return 'orgs/acme was never read';
    }
    return true;
  },
  tags: ['firestore', 'read'],
};

export default task;
