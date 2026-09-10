import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'top-level-shape-of-inventory',
  prompt:
    "Give me just the top-level shape under inventory in the realtime database, don't go deeper than one level and don't show me the actual stock numbers.",
  seed: {
    database: {
      inventory: {
        widgets: { count: 42, warehouse: { aisle: 3, bin: 7 } },
        gadgets: { count: 7, warehouse: { aisle: 1, bin: 2 } },
      },
    },
  },
  acceptedFirstOperations: ['crawl_database_structure'],
  assert: (state) => {
    const call = state.calls.find((c) => c.operation === 'crawl_database_structure' && c.ok);
    if (!call) return 'inventory was never crawled for its structure';
    if (typeof call.args.depth === 'number' && call.args.depth > 1) {
      return 'depth went deeper than the one level asked for';
    }
    return true;
  },
  tags: ['database', 'read'],
};

export default task;
