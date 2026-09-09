import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'query-open-invoices',
  prompt: 'Which invoices are still open for tenant-acme? I am chasing a reconciliation mismatch and Stripe says three.',
  seed: {
    firestore: {
      'invoices/inv_301': { tenant: 'tenant-acme', amount: 100, status: 'open' },
      'invoices/inv_302': { tenant: 'tenant-acme', amount: 200, status: 'paid' },
      'invoices/inv_303': { tenant: 'tenant-acme', amount: 300, status: 'open' },
      'invoices/inv_304': { tenant: 'tenant-globex', amount: 400, status: 'open' },
    },
  },
  acceptedFirstOperations: ['query_firestore_documents', 'list_firestore_documents'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'query_firestore_documents' && c.ok)) {
      return 'the invoices collection was never queried';
    }
    return true;
  },
  tags: ['firestore', 'tenant', 'read'],
};

export default task;
