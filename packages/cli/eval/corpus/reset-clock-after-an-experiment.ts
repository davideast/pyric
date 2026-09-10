import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'reset-clock-after-an-experiment',
  prompt:
    'The time-travel experiment is done. Put the sandbox clock back to normal.',
  seed: {},
  acceptedFirstOperations: ['reset_clock'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'reset_clock' && c.ok)) {
      return 'the clock was never reset';
    }
    return true;
  },
  tags: ['sandbox', 'write'],
};

export default task;
