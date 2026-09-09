import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'clear-database-only-leave-firestore',
  prompt:
    'Clear out just the Realtime Database data in the sandbox. Leave Firestore and everything else alone.',
  seed: {
    firestore: { 'keep/doc': { ok: true } },
    database: { temp: { stale: true } },
  },
  acceptedFirstOperations: ['reset_sandbox'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'reset_sandbox' && c.ok)) {
      return 'no reset_sandbox call ever succeeded';
    }
    if (state.database.get('temp') !== null) return 'temp survived the database-scoped reset';
    if (state.firestore.get('keep/doc') === null) return 'keep/doc was cleared, but it should not have been';
    return true;
  },
  tags: ['sandbox', 'write', 'destructive'],
};

export default task;
