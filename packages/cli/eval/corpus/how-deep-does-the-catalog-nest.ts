import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'how-deep-does-the-catalog-nest',
  prompt:
    'Show me one level of subcollections under products, I do not need anything deeper than that right now.',
  seed: {
    firestore: {
      'products/p1': { name: 'Widget' },
      'products/p1/variants/v1': { size: 'small' },
      'products/p1/variants/v1/stock/warehouse-1': { units: 5 },
    },
  },
  acceptedFirstOperations: ['discover_firestore_paths'],
  assert: (state) => {
    const discovered = state.calls.find((c) => c.operation === 'discover_firestore_paths' && c.ok);
    if (!discovered) return 'the products tree was never discovered';
    const depth = (discovered.data as { depth?: number } | undefined)?.depth;
    if (depth !== undefined && depth > 2) {
      return `depth was requested as ${depth}, deeper than the one subcollection level asked for`;
    }
    return true;
  },
  tags: ['firestore', 'read'],
};

export default task;
