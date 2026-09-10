import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'check-index-for-paid-orders-by-date',
  prompt:
    "I'm about to ship a query on orders that filters status equal to paid and orders by createdAt descending. Will Firestore need a composite index for that, and what would it look like?",
  seed: {
    firestore: {
      'orders/o1': { status: 'paid', createdAt: 1 },
    },
  },
  acceptedFirstOperations: ['extract_firestore_indexes'],
  assert: (state) => {
    const extracted = state.calls.find((c) => c.operation === 'extract_firestore_indexes' && c.ok);
    if (!extracted) return 'no index requirement was ever checked';
    const indexes = (extracted.data as { indexes?: Array<Record<string, unknown>> } | undefined)
      ?.indexes;
    if (indexes !== undefined && indexes.length < 1) {
      return 'the check reported no composite index, but this query needs one';
    }
    return true;
  },
  tags: ['firestore', 'read'],
};

export default task;
