import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'check-what-has-fired-so-far',
  prompt:
    'What Cloud Functions runs has the sandbox recorded so far? I care about which trigger ran, how long it took, and whether it succeeded.',
  seed: {},
  acceptedFirstOperations: ['list_functions_executions'],
  assert: (state) => {
    const call = state.calls.find((c) => c.operation === 'list_functions_executions' && c.ok);
    if (call === undefined) return 'no list_functions_executions call ever succeeded';
    const data = call.data as { executions?: unknown[] };
    if (!Array.isArray(data.executions)) {
      return 'list_functions_executions did not read back an executions array';
    }
    return true;
  },
  tags: ['functions', 'read'],
};

export default task;
