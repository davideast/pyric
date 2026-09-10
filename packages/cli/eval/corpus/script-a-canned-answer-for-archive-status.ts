import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'script-a-canned-answer-for-archive-status',
  prompt:
    "Set up a canned AI Logic answer: whenever a prompt mentions 'archive status', have it reply with the plain text 'The archive is offline for maintenance.' This should only touch the local mock, not call any real model.",
  seed: {},
  acceptedFirstOperations: ['script_ai_logic'],
  assert: (state) => {
    const call = state.calls.find((c) => c.operation === 'script_ai_logic' && c.ok);
    if (call === undefined) return 'no script_ai_logic call ever succeeded';
    // `args` nests the method's own arguments the way the tool's own variant
    // spells them: the service tools nest them under a further `args` field.
    const outer = call.args as { args?: { match?: { substring?: string }; response?: { type?: string; payload?: unknown } } };
    const inner = outer.args ?? (call.args as { match?: { substring?: string }; response?: { type?: string; payload?: unknown } });
    if (inner.match?.substring !== 'archive status') return 'the match substring was not archive status';
    if (inner.response?.type !== 'text') return 'the response type was not text';
    if (inner.response?.payload !== 'The archive is offline for maintenance.') {
      return 'the response payload did not carry the exact sentence';
    }
    return true;
  },
  tags: ['ai_logic', 'write'],
};

export default task;
