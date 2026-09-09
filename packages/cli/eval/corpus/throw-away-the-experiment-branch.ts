import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'throw-away-the-experiment-branch',
  prompt:
    'Make a branch called spike so I can try the tighter schema, put a write on it that sets settings/flags to {"beta":true,"rollout":100}, then throw the whole branch away. The idea did not work out and nothing from it should reach our data.',
  seed: {
    firestore: { 'settings/flags': { beta: false, rollout: 0 } },
  },
  acceptedFirstOperations: ['fork_sandbox_branch'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'discard_sandbox_branch' && c.ok)) {
      return 'no discard call ever succeeded';
    }
    const flags = state.firestore.get('settings/flags');
    if (!flags) return 'settings/flags is gone';
    if (flags.beta !== false || flags.rollout !== 0) {
      return 'settings/flags changed, so the discarded branch reached live';
    }
    return true;
  },
  tags: ['sandbox', 'branch', 'multi-step', 'write'],
};

export default task;
