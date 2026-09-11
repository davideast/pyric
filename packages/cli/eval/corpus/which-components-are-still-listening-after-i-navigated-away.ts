import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'which-components-are-still-listening-after-i-navigated-away',
  prompt:
    'I navigated away from the dashboard a minute ago. Is anything still listening for Firestore or Realtime Database changes that I should worry about?',
  seed: {
    firestore: { 'boards/main': { title: 'Main board' } },
  },
  acceptedFirstOperations: ['list_sandbox_listeners'],
  assert: (state) => {
    const call = state.calls.find((c) => c.operation === 'list_sandbox_listeners' && c.ok);
    if (call === undefined) return 'no list_sandbox_listeners call ever succeeded';
    const data = call.data as { listeners?: unknown[]; totals?: Record<string, number> };
    if (!Array.isArray(data.listeners)) {
      return 'list_sandbox_listeners did not read back a listeners array';
    }
    if (data.totals === undefined || data.totals.firestore === undefined || data.totals.database === undefined) {
      return 'list_sandbox_listeners did not read back totals per service';
    }
    return true;
  },
  tags: ['sandbox', 'read'],
};

export default task;
