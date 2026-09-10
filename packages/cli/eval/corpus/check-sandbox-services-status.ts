import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'check-sandbox-services-status',
  prompt: 'Is the realtime database side of the sandbox even active? Nothing I write to it shows up in the app.',
  seed: {
    database: { presence: { alice: { state: 'online' } } },
  },
  acceptedFirstOperations: ['inspect_sandbox'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'inspect_sandbox' && c.ok)) {
      return 'the sandbox service status was never checked';
    }
    return true;
  },
  tags: ['sandbox', 'database', 'read'],
};

export default task;
