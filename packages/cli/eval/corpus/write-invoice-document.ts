import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'write-invoice-document',
  prompt: 'Create invoices/inv_101 for tenant-acme with an amount of 4200, currency usd, and status open.',
  seed: {},
  acceptedFirstOperations: ['write_firestore_document'],
  assert: (state) => {
    const doc = state.firestore.get('invoices/inv_101');
    if (!doc) return 'invoices/inv_101 does not exist';
    if (doc.amount !== 4200) return 'the amount field is not 4200';
    if (doc.status !== 'open') return 'the status field is not open';
    return true;
  },
  tags: ['firestore', 'write'],
};

export default task;
