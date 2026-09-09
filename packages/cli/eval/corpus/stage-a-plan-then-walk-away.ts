import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'stage-a-plan-then-walk-away',
  prompt:
    "Before I let this loose on real data I want to see it on a copy. Make a branch called price-bump, run these two writes on it, and show me what changes: set products/p1 to {\"name\":\"Anvil\",\"price\":140} and products/p2 to {\"name\":\"Rope\",\"price\":32}. Do not land any of it, I want to look first.",
  seed: {
    firestore: {
      'products/p1': { name: 'Anvil', price: 120 },
      'products/p2': { name: 'Rope', price: 30 },
    },
  },
  acceptedFirstOperations: ['fork_sandbox_branch'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'fork_sandbox_branch' && c.ok)) {
      return 'no branch was forked';
    }
    if (!state.calls.some((c) => c.operation === 'apply_sandbox_events' && c.ok)) {
      return 'nothing was applied to the branch';
    }
    if (!state.calls.some((c) => c.operation === 'diff_sandbox_branch' && c.ok)) {
      return 'the branch was never compared against live';
    }
    if (state.calls.some((c) => c.operation === 'promote_sandbox_branch')) {
      return 'the branch was promoted, and the task said not to land it';
    }
    const p1 = state.firestore.get('products/p1');
    if (!p1 || p1.price !== 120) return 'products/p1 changed on the live sandbox';
    const p2 = state.firestore.get('products/p2');
    if (!p2 || p2.price !== 30) return 'products/p2 changed on the live sandbox';
    return true;
  },
  tags: ['sandbox', 'branch', 'multi-step', 'read'],
};

export default task;
