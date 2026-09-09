import type { EvalTask } from '../types.js';
import { OPEN_ORDER_RULES } from '../../test/fixtures/order-rules.js';

const task: EvalTask = {
  id: 'shrink-the-counterexample-and-file-it',
  prompt:
    'Alice can rewrite an order with a pile of fields she never sent, and I need this in the bug tracker. Show that it happens, cut the payload down to the smallest thing that still does it so nobody argues about the extra fields, and leave the whole thing on disk under .pyric so I can attach it.',
  seed: {
    firestoreRules: OPEN_ORDER_RULES,
    firestore: {
      'orders/o1': { owner: 'alice', total: 10 },
      'orders/o2': { owner: 'bob', total: 20 },
    },
    users: [{ uid: 'alice', email: 'alice@example.com' }],
  },
  acceptedFirstOperations: ['attach_assurance_target', 'start_assurance_campaign'],
  assert: (state) => {
    const minimized = state.calls.find((call) => call.operation === 'minimize_assurance_probe' && call.ok);
    if (!minimized) return 'nothing was minimized';
    const shrunk = minimized.data as
      | { changed?: boolean; removedPayloadFields?: string[] }
      | undefined;
    if (shrunk?.changed !== true) {
      return 'the minimizer removed nothing, so the counterexample was never cut down';
    }
    if ((shrunk.removedPayloadFields ?? []).length < 1) return 'no payload field was named as removed';
    const exported = state.calls.find((call) => call.operation === 'export_assurance_campaign' && call.ok);
    if (!exported) return 'nothing was exported, so there is nothing to attach';
    const path = (exported.data as { path?: string } | undefined)?.path;
    if (typeof path !== 'string' || !path.includes('.pyric')) {
      return `the export landed at '${String(path)}' rather than under .pyric`;
    }
    return true;
  },
  tags: ['assurance', 'campaign', 'multi-step'],
};

export default task;
