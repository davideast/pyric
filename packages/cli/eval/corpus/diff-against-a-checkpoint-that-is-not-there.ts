import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'diff-against-a-checkpoint-that-is-not-there',
  prompt:
    'Open a copy called audit and compare it against the friday-night checkpoint. If that checkpoint is not around, just compare it against what we have now and tell me what you compared against.',
  seed: {
    firestore: { 'invoices/inv_1': { status: 'open', amount: 90 } },
  },
  acceptedFirstOperations: ['fork_sandbox_branch'],
  assert: (state) => {
    const diffs = state.calls.filter((c) => c.operation === 'diff_sandbox_branch');
    const refusedIndex = diffs.findIndex((c) => !c.ok);
    if (refusedIndex === -1) {
      return 'the missing checkpoint was never named, so nothing was refused';
    }
    const followed = diffs.slice(refusedIndex + 1).some((c) => c.ok);
    if (!followed) return 'the refusal was never followed by a diff that succeeded';
    const invoice = state.firestore.get('invoices/inv_1');
    if (!invoice || invoice.status !== 'open') {
      return 'invoices/inv_1 changed, and a comparison changes nothing';
    }
    return true;
  },
  tags: ['sandbox', 'branch', 'read', 'multi-step'],
};

export default task;
