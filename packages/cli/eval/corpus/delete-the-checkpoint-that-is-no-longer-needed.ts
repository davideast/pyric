import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'delete-the-checkpoint-that-is-no-longer-needed',
  prompt:
    'Checkpoint the sandbox as pre-cleanup before you delete the archived note, then delete the note. The cleanup worked, so the checkpoint is no longer needed: delete it and show me what checkpoints are left.',
  seed: {
    firestore: {
      'demo/archived-note': { archived: true },
      'demo/kept-note': { archived: false },
    },
  },
  acceptedFirstOperations: ['checkpoint_sandbox'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'checkpoint_sandbox' && c.ok)) {
      return 'no checkpoint_sandbox call ever succeeded';
    }
    if (!state.calls.some((c) => c.operation === 'delete_sandbox_checkpoint' && c.ok)) {
      return 'the checkpoint was never deleted';
    }
    if (!state.calls.some((c) => c.operation === 'list_sandbox_checkpoints' && c.ok)) {
      return 'the remaining checkpoints were never listed';
    }
    if (state.calls.some((c) => c.operation === 'restore_sandbox' && c.ok)) {
      return 'the sandbox was restored, which the task never asked for';
    }
    if (state.firestore.get('demo/archived-note') !== null) {
      return 'demo/archived-note is still there, so the cleanup never landed';
    }
    if (state.firestore.get('demo/kept-note') === null) {
      return 'demo/kept-note is gone, so deleting the checkpoint took the sandbox with it';
    }
    return true;
  },
  tags: ['sandbox', 'write', 'multi-step'],
};

export default task;
