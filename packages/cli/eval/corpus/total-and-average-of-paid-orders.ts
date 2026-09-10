import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'total-and-average-of-paid-orders',
  prompt:
    'For the orders marked paid, what is the total revenue and the average order size? Skip the ones still open.',
  seed: {
    firestore: {
      'orders/o1': { status: 'paid', total: 10 },
      'orders/o2': { status: 'paid', total: 30 },
      'orders/o3': { status: 'open', total: 100 },
    },
  },
  acceptedFirstOperations: ['aggregate_firestore_documents'],
  assert: (state) => {
    const aggregated = state.calls.find(
      (c) => c.operation === 'aggregate_firestore_documents' && c.ok,
    );
    if (!aggregated) return 'orders was never aggregated';
    const data = aggregated.data as { sum?: number; average?: number } | undefined;
    if (data?.sum !== undefined && data.sum !== 40) return `sum was ${data.sum}, not 40`;
    if (data?.average !== undefined && data.average !== 20) {
      return `average was ${data.average}, not 20`;
    }
    return true;
  },
  tags: ['firestore', 'read'],
};

export default task;
