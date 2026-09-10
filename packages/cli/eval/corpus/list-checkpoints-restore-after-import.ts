import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'list-checkpoints-restore-after-import',
  // The assertion turns on which of the two checkpoints came back, and the
  // only thing that tells them apart is the phase field, so the prompt asks
  // for the phase writes that make each checkpoint distinct. Dropping the
  // check instead would leave the task asserting nothing more than that a
  // restore succeeded, which is a different and much smaller question.
  prompt:
    "Before the risky migration, checkpoint the sandbox as morning-state. Then run the first phase: set the phase field on status/doc to importing, and checkpoint again as after-import. The phase after that went wrong and left status/doc on broken, so put it there, then list the checkpoints and restore after-import.",
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
