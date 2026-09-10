import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'mint-order-id-for-later',
  prompt:
    "I need a fresh unique id under orders in the realtime database, but I'm not ready to fill in the order yet. Just get me the id.",
  seed: {
    database: { orders: { existing: { total: 5 } } },
  },
  acceptedFirstOperations: ['push_database_value'],
  assert: (state) => {
    const call = state.calls.find((c) => c.operation === 'push_database_value' && c.ok);
    if (!call) return 'the auto-id write was never made';
    const data = call.data as { key?: string } | null;
    if (data === null || typeof data.key !== 'string' || data.key.length !== 20) {
      return 'the call did not return a generated key';
    }
    if (call.args.value !== undefined) return 'a value was written when none was requested';
    return true;
  },
  tags: ['database', 'write'],
};

export default task;
