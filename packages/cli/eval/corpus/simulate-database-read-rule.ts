import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'simulate-database-read-rule',
  prompt: 'Under these realtime database rules, can an unauthenticated client read billing/acct1? I want the verdict from the engine.',
  seed: {
    databaseRules: `{
  "rules": {
    ".read": true,
    "billing": {
      ".read": "auth != null"
    }
  }
}
`,
    database: {
      billing: { acct1: { plan: 'team', balance: 0 } },
    },
  },
  acceptedFirstOperations: ['simulate_database_rules'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'simulate_database_rules' && c.ok)) {
      return 'no database rules verdict was requested for billing/acct1';
    }
    return true;
  },
  tags: ['rules', 'database', 'simulate'],
};

export default task;
