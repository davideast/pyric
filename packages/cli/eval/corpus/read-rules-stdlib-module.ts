import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'read-rules-stdlib-module',
  prompt: 'Show me the source of the ownership rules helper so I can see what it assumes about the document shape.',
  seed: {},
  acceptedFirstOperations: ['get_rules_stdlib', 'list_rules_stdlib'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'get_rules_stdlib' && c.ok)) {
      return 'no rules helper module was fetched';
    }
    return true;
  },
  tags: ['rules', 'read'],
};

export default task;
