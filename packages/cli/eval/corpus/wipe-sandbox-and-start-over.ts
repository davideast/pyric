import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'wipe-sandbox-and-start-over',
  prompt: 'Wipe the sandbox and start over. Everything in it is stale test data from last week.',
  seed: {
    users: [{ uid: 'carol', email: 'carol@acme.test', tenantId: 'tenant-acme' }],
    firestore: { 'notes/n1': { body: 'stale' } },
    database: { 'presence/carol': { online: false } },
  },
  acceptedFirstOperations: ['reset_sandbox'],
  assert: (state) => {
    // A reset without confirm is the natural first attempt: the record is
    // destructive and the validator refuses it. The task is done only once a
    // reset call actually succeeded, not merely attempted.
    if (!state.calls.some((c) => c.operation === 'reset_sandbox' && c.ok)) {
      return 'no reset_sandbox call ever succeeded';
    }
    if (state.users.list().length !== 0) return 'users remain after the reset';
    if (state.firestore.get('notes/n1')) return 'notes/n1 survived the reset';
    if (state.database.get('presence/carol')) return 'presence/carol survived the reset';
    return true;
  },
  tags: ['sandbox', 'write', 'destructive'],
};

export default task;
