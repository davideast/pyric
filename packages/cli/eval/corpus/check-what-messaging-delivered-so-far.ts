import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'check-what-messaging-delivered-so-far',
  prompt:
    "What has the sandbox actually delivered through push messaging so far? I care whether each one landed in the foreground or the background, and whether anything was even listening.",
  seed: {},
  acceptedFirstOperations: ['list_messaging_deliveries'],
  assert: (state) => {
    const read = state.calls.find((c) => c.operation === 'list_messaging_deliveries' && c.ok);
    if (read === undefined) return 'no list_messaging_deliveries call ever succeeded';
    const data = read.data as { deliveries?: unknown[] };
    if (!Array.isArray(data.deliveries)) {
      return 'list_messaging_deliveries did not read back a deliveries array';
    }
    return true;
  },
  tags: ['messaging', 'read'],
};

export default task;
