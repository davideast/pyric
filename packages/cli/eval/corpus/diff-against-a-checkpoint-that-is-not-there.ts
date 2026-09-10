import type { EvalCall, EvalTask } from '../types.js';

/**
 * What a diff call compared against, under either variant's argument shape:
 * the service tools nest the method's arguments, the discriminator tools do
 * not. The operation defaults to live, so an absent field is live.
 */
function comparedAgainst(call: EvalCall): string {
  const nested = call.args.args as Record<string, unknown> | undefined;
  const against = nested?.against ?? call.args.against;
  if (typeof against !== 'string') return 'live';
  return against;
}

const task: EvalTask = {
  id: 'diff-against-a-checkpoint-that-is-not-there',
  prompt:
    'Open a copy called audit and compare it against the friday-night checkpoint. If that checkpoint is not around, just compare it against what we have now and tell me what you compared against.',
  seed: {
    firestore: { 'invoices/inv_1': { status: 'open', amount: 90 } },
  },
  acceptedFirstOperations: ['fork_sandbox_branch'],
  assert: (state) => {
    const invoice = state.firestore.get('invoices/inv_1');
    if (!invoice || invoice.status !== 'open') {
      return 'invoices/inv_1 changed, and a comparison changes nothing';
    }

    // Two ways of establishing the checkpoint is not around are equally good.
    // The first names it and is refused. The second asks what checkpoints
    // exist, gets none, and compares against live on that evidence. Only an
    // agent that did neither guessed.
    const diffs = state.calls.filter((c) => c.operation === 'diff_sandbox_branch');
    const refusedIndex = diffs.findIndex((c) => !c.ok);
    if (refusedIndex !== -1) {
      const followed = diffs.slice(refusedIndex + 1).some((c) => c.ok);
      if (!followed) return 'the refusal was never followed by a diff that succeeded';
      return true;
    }

    const listedIndex = state.calls.findIndex(
      (c) => c.operation === 'list_sandbox_checkpoints' && c.ok,
    );
    if (listedIndex === -1) {
      return 'the missing checkpoint was neither named nor looked up, so the comparison was a guess';
    }
    const comparedAgainstLive = state.calls
      .slice(listedIndex + 1)
      .some((c) => c.operation === 'diff_sandbox_branch' && c.ok && comparedAgainst(c) === 'live');
    if (!comparedAgainstLive) {
      return 'the checkpoint listing was never followed by a comparison against live';
    }
    return true;
  },
  tags: ['sandbox', 'branch', 'read', 'multi-step'],
};

export default task;
