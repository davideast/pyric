import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'seed-database-tree-fixture',
  prompt: 'Set up the realtime database fixture I use for flag work: config/featureFlags with newBilling true and betaSearch false.',
  seed: {},
  acceptedFirstOperations: ['seed_sandbox', 'write_database_value'],
  assert: (state) => {
    const flags = state.database.get('config/featureFlags') as Record<string, unknown> | null;
    if (!flags) return 'config/featureFlags was not seeded';
    if (flags.newBilling !== true) return 'newBilling is not true';
    if (flags.betaSearch !== false) return 'betaSearch is not false';
    return true;
  },
  tags: ['sandbox', 'database', 'write'],
};

export default task;
