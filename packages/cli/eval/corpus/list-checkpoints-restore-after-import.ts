import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'list-checkpoints-restore-after-import',
  prompt:
    "Before the risky migration, checkpoint the sandbox as morning-state. After the first phase finishes, checkpoint again as after-import. Something went wrong in the phase after that, so list the checkpoints and restore after-import.",
  seed: {
    firestore: { 'status/doc': { phase: 'start' } },
  },
  acceptedFirstOperations: ['checkpoint_sandbox'],
  assert: (state) => {
    const checkpoints = state.calls.filter((c) => c.operation === 'checkpoint_sandbox' && c.ok);
    if (checkpoints.length < 2) return 'fewer than two checkpoints were saved';
    if (!state.calls.some((c) => c.operation === 'list_sandbox_checkpoints' && c.ok)) {
      return 'the checkpoints were never listed';
    }
    if (!state.calls.some((c) => c.operation === 'restore_sandbox' && c.ok)) {
      return 'no restore_sandbox call ever succeeded';
    }
    const doc = state.firestore.get('status/doc');
    if (doc === null) return 'status/doc is missing after the restore';
    if (doc.phase !== 'importing') {
      return `status/doc.phase is ${JSON.stringify(doc.phase)}, expected 'importing' (after-import's state, not morning-state's or the broken state)`;
    }
    return true;
  },
  tags: ['sandbox', 'write', 'destructive', 'multi-step'],
};

export default task;
