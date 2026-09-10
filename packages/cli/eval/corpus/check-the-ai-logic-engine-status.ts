import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'check-the-ai-logic-engine-status',
  prompt:
    "What AI Logic engine is this project configured to use right now, which model and upstream does it resolve to, and is a key configured for it?",
  seed: {},
  acceptedFirstOperations: ['get_ai_logic_status'],
  assert: (state) => {
    const call = state.calls.find((c) => c.operation === 'get_ai_logic_status' && c.ok);
    if (call === undefined) return 'no get_ai_logic_status call ever succeeded';
    const data = call.data as { engine?: unknown; keyPresent?: unknown };
    if (typeof data.engine !== 'string') return 'get_ai_logic_status did not read back a string engine';
    if (typeof data.keyPresent !== 'boolean') return 'get_ai_logic_status did not read back a boolean keyPresent';
    return true;
  },
  tags: ['ai_logic', 'read'],
};

export default task;
