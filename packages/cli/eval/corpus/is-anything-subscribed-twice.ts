import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'is-anything-subscribed-twice',
  prompt: 'Is anything in the app subscribed to the same Firestore document more than once right now?',
  seed: {
    firestore: { 'threads/general': { title: 'General' } },
  },
  acceptedFirstOperations: ['list_sandbox_activity'],
  assert: (state) => {
    const call = state.calls.find(
      (c) => c.operation === 'list_sandbox_activity' && c.ok,
    );
    if (call === undefined) return 'no list_sandbox_activity call ever succeeded';
    const data = call.data as { incidents?: Array<{ pattern: string }> };
    if (!Array.isArray(data.incidents)) {
      return 'list_sandbox_activity did not read back an incidents array';
    }
    if (data.incidents.some((incident) => incident.pattern === 'repeated-read')) {
      return "list_sandbox_activity returned a 'repeated-read' incident for a call about duplicate subscriptions";
    }
    return true;
  },
  tags: ['sandbox', 'read'],
};

export default task;
