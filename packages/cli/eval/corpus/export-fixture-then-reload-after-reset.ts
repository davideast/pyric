import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'export-fixture-then-reload-after-reset',
  prompt:
    'Save the current sandbox as a fixture file at fixtures/scenario.json, wipe the sandbox completely, and then load that fixture back in.',
  seed: {
    firestore: { 'orders/o1': { total: 42 } },
    users: [{ uid: 'reviewer', email: 'reviewer@example.com', tenantId: 'tenant-x' }],
  },
  acceptedFirstOperations: ['export_sandbox_fixture'],
  assert: (state) => {
    if (!state.calls.some((c) => c.operation === 'export_sandbox_fixture' && c.ok)) {
      return 'no export_sandbox_fixture call ever succeeded';
    }
    if (!state.calls.some((c) => c.operation === 'reset_sandbox' && c.ok)) {
      return 'no reset_sandbox call ever succeeded';
    }
    if (!state.calls.some((c) => c.operation === 'seed_sandbox_fixture' && c.ok)) {
      return 'no seed_sandbox_fixture call ever succeeded';
    }
    const order = state.firestore.get('orders/o1');
    if (order === null) return 'orders/o1 did not come back after the reload';
    if (order.total !== 42) return `orders/o1 has total ${String(order.total)}, expected 42`;
    const reviewer = state.users.get('reviewer');
    if (reviewer === null) return 'reviewer did not come back after the reload';
    if (reviewer.tenant !== 'tenant-x') return "reviewer's tenant did not survive the round trip";
    return true;
  },
  tags: ['sandbox', 'write', 'destructive', 'multi-step'],
};

export default task;
