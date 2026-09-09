import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'checkpoint-before-cleanup-then-restore',
  prompt:
    "I'm about to run a bulk cleanup script against the sandbox. Save a checkpoint called before-cleanup first, then delete the demo/legacy document, and if it turns out I needed it, restore before-cleanup.",
  seed: {
    firestore: { 'demo/legacy': { keep: true } },
  },
  acceptedFirstOperations: ['checkpoint_sandbox'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'checkpoint_sandbox' && c.ok)) {
      return 'no checkpoint_sandbox call ever succeeded';
    }
    if (!state.calls.some((c) => c.operation === 'delete_firestore_document' && c.ok)) {
      return 'demo/legacy was never deleted';
    }
    if (!state.calls.some((c) => c.operation === 'restore_sandbox' && c.ok)) {
      return 'no restore_sandbox call ever succeeded';
    }
    const legacy = state.firestore.get('demo/legacy');
    if (legacy === null) return 'demo/legacy did not come back after the restore';
    return true;
  },
  tags: ['sandbox', 'write', 'destructive', 'multi-step'],
};

export default task;
