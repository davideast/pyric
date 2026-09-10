import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'list-the-queued-ai-logic-scripts',
  prompt: 'What scripted AI Logic responses are queued right now on this project?',
  seed: {},
  acceptedFirstOperations: ['list_ai_logic_scripts'],
  assert: (state) => {
    const call = state.calls.find((c) => c.operation === 'list_ai_logic_scripts' && c.ok);
    if (call === undefined) return 'no list_ai_logic_scripts call ever succeeded';
    const data = call.data as { scripts?: unknown[] };
    if (!Array.isArray(data.scripts)) return 'list_ai_logic_scripts did not read back a scripts array';
    return true;
  },
  tags: ['ai_logic', 'read'],
};

export default task;
