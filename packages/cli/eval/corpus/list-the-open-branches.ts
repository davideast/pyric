import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'list-the-open-branches',
  prompt:
    'I left a couple of copies open before the holiday and I cannot remember what is on them. Start one called after-holiday so I have somewhere to work, then tell me every copy that is sitting around and how far each has drifted.',
  seed: {
    firestore: { 'orders/o1': { total: 42 } },
  },
  acceptedFirstOperations: ['fork_sandbox_branch', 'list_sandbox_branches'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'list_sandbox_branches' && c.ok)) {
      return 'the branches were never listed';
    }
    if (!state.calls.some((c) => c.operation === 'fork_sandbox_branch' && c.ok)) {
      return 'no branch was forked, so the listing had nothing to report';
    }
    const order = state.firestore.get('orders/o1');
    if (!order || order.total !== 42) return 'orders/o1 changed, and nothing asked for a write';
    return true;
  },
  tags: ['sandbox', 'branch', 'read'],
};

export default task;
