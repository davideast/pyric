import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'find-rules-helper-module',
  prompt: 'Is there a ready made rules helper for tenant checks I can pull in? I would rather not write the same predicate twice.',
  seed: {},
  acceptedFirstOperations: ['list_rules_stdlib'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'list_rules_stdlib' && c.ok)) {
      return 'the rules helper catalogue was never listed';
    }
    return true;
  },
  tags: ['rules', 'read'],
};

export default task;
