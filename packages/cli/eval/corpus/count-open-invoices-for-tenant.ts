import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'count-open-invoices-for-tenant',
  prompt:
    'How many invoices for tenant-acme are still open? I just need the number, not the list.',
  seed: {
    firestore: {
      'invoices/inv_401': { tenant: 'tenant-acme', status: 'open' },
      'invoices/inv_402': { tenant: 'tenant-acme', status: 'paid' },
      'invoices/inv_403': { tenant: 'tenant-acme', status: 'open' },
      'invoices/inv_404': { tenant: 'tenant-globex', status: 'open' },
    },
  },
  acceptedFirstOperations: ['count_firestore_documents'],
  assert: (state) => {
    const counted = state.calls.find((c) => c.operation === 'count_firestore_documents' && c.ok);
    if (!counted) return 'the invoices collection was never counted';
    const count = (counted.data as { count?: number } | undefined)?.count;
    if (count !== undefined && count !== 2) {
      return `the reported count was ${count}, not the 2 open tenant-acme invoices`;
    }
    return true;
  },
  tags: ['firestore', 'read'],
};

export default task;
