import type { EvalTask } from '../types.js';
import { CLOSED_ORDER_RULES, RECORDED_ORDER_RULES } from '../../test/fixtures/order-rules.js';
import { recordOrderSession } from '../sessions.js';

const task: EvalTask = {
  id: 'replay-last-session-under-closed-rules',
  prompt: `I am about to ship this ruleset and I want to know what it breaks before I do. Replay whatever the app did last against it and tell me which calls stop working and what they used to do:\n\n${CLOSED_ORDER_RULES}`,
  seed: {
    session: recordOrderSession,
    firestoreRules: RECORDED_ORDER_RULES,
    firestore: { 'orders/o1': { owner: 'alice', total: 10 } },
  },
  acceptedFirstOperations: ['replay_assurance_session'],
  assert: (state) => {
    const replay = state.calls.find((call) => call.operation === 'replay_assurance_session');
    if (!replay) return 'the recorded session was never replayed';
    const data = replay.data as { divergences?: Array<Record<string, unknown>> } | undefined;
    const divergences = data?.divergences ?? [];
    const order = divergences.find((entry) => entry.path === 'orders/o1');
    if (!order) return 'the replay reported nothing about orders/o1, which the recording holds';
    if (order.recorded !== 'allow' || order.candidate !== 'deny') {
      return `the replay called orders/o1 ${String(order.recorded)} then ${String(order.candidate)}`;
    }
    return true;
  },
  tags: ['assurance', 'replay', 'read'],
};

export default task;
