import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'list-tenant-members',
  prompt: 'List everything under tenants/tenant-acme/members. I want to see the raw documents, not a count.',
  seed: {
    firestore: {
      'tenants/tenant-acme/members/alice': { role: 'owner' },
      'tenants/tenant-acme/members/bob': { role: 'member' },
      'tenants/tenant-globex/members/gus': { role: 'owner' },
    },
  },
  acceptedFirstOperations: ['list_firestore_documents', 'query_firestore_documents'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'list_firestore_documents' && c.ok)) {
      return 'the members collection was never listed';
    }
    return true;
  },
  tags: ['firestore', 'tenant', 'read'],
};

export default task;
