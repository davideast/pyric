import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'clear-the-queued-ai-logic-scripts',
  prompt: 'Clear out whatever scripted AI Logic responses are currently queued on this project.',
  seed: {},
  acceptedFirstOperations: ['clear_ai_logic_scripts'],
  assert: (state) => {
    const call = state.calls.find((c) => c.operation === 'clear_ai_logic_scripts' && c.ok);
    if (call === undefined) return 'no clear_ai_logic_scripts call ever succeeded';
    return true;
  },
  tags: ['ai_logic', 'write'],
};

export default task;
