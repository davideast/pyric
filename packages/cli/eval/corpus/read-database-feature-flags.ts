import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'read-database-feature-flags',
  prompt: 'What is sitting at config/featureFlags in the realtime database? The Segment dashboard disagrees with the app.',
  seed: {
    database: {
      config: { featureFlags: { newBilling: true, betaSearch: false } },
    },
  },
  acceptedFirstOperations: ['get_database_value'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'get_database_value' && c.ok)) {
      return 'config/featureFlags was never read';
    }
    return true;
  },
  tags: ['database', 'read'],
};

export default task;
