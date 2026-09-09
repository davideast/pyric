import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'query-database-by-child',
  prompt: 'Under orders in the realtime database, find the ones whose status child is pending. There should be two.',
  seed: {
    database: {
      orders: {
        o1: { status: 'pending', total: 10 },
        o2: { status: 'shipped', total: 20 },
        o3: { status: 'pending', total: 30 },
      },
    },
  },
  acceptedFirstOperations: ['query_database_values'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'query_database_values' && c.ok)) {
      return 'the orders branch was never queried by child';
    }
    return true;
  },
  tags: ['database', 'read'],
};

export default task;
