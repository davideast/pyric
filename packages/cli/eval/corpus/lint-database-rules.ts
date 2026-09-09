import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'lint-database-rules',
  prompt: 'Check my realtime database rules. I think the read at the root is cascading over the billing branch.',
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
  },
  acceptedFirstOperations: ['lint_database_rules'],
  assert: (state) => {
    // A lint that reports errors is a completed lint, so ok is not required.
    if (!state.calls.some((c) => c.operation === 'lint_database_rules')) {
      return 'the database rules were never linted';
    }
    return true;
  },
  tags: ['rules', 'database', 'lint'],
};

export default task;
