import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'count-total-orders-in-catalog',
  prompt: 'Give me a quick total of how many orders exist in the sandbox right now, nothing else.',
  seed: {
    firestore: {
      'orders/o1': { total: 10 },
      'orders/o2': { total: 20 },
      'orders/o3': { total: 30 },
    },
  },
  acceptedFirstOperations: ['count_firestore_documents'],
  assert: (state) => {
    const counted = state.calls.find((c) => c.operation === 'count_firestore_documents' && c.ok);
    if (!counted) return 'orders was never counted';
    const count = (counted.data as { count?: number } | undefined)?.count;
    if (count !== undefined && count !== 3) return `the reported count was ${count}, not 3`;
    return true;
  },
  tags: ['firestore', 'read'],
};

export default task;
