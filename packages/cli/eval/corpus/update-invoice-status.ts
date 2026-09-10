import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'update-invoice-status',
  prompt: 'The customer paid. Flip invoices/inv_202 to status paid and leave everything else on the document alone.',
  seed: {
    firestore: {
      'invoices/inv_202': { tenant: 'tenant-acme', amount: 1800, currency: 'usd', status: 'open' },
    },
  },
  acceptedFirstOperations: ['update_firestore_document', 'get_firestore_document'],
  assert: (state) => {
    const doc = state.firestore.get('invoices/inv_202');
    if (!doc) return 'invoices/inv_202 does not exist';
    if (doc.status !== 'paid') return 'the status field is not paid';
    if (doc.amount !== 1800) return 'the amount field was clobbered';
    if (doc.tenant !== 'tenant-acme') return 'the tenant field was clobbered';
    return true;
  },
  tags: ['firestore', 'write'],
};

export default task;
