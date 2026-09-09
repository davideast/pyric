import type { EvalTask } from '../types.js';
import { CLOSED_ORDER_RULES, RECORDED_ORDER_RULES } from '../../test/fixtures/order-rules.js';
import { recordOrderSession } from '../sessions.js';

const task: EvalTask = {
  id: 'test-the-candidate-rules-on-the-real-project',
  prompt: `Run these candidate rules through Firebase's hosted rules test API against our real project so I have an answer from Google and not from a simulator. If you cannot reach it, say why and get me the closest answer you can from what is here:\n\n${CLOSED_ORDER_RULES}`,
  seed: {
    session: recordOrderSession,
    firestoreRules: RECORDED_ORDER_RULES,
    firestore: { 'orders/o1': { owner: 'alice', total: 10 } },
  },
  acceptedFirstOperations: [],
  assert: (state) => {
    // The task names the hosted API, so a run that never asked for it answered
    // an easier question. The attempt has to be there, and it has to have been
    // refused, before the local answer counts for anything.
    const hosted = state.calls.find((call) => call.operation === 'test_assurance_rules_hosted');
    if (hosted === undefined) return 'the hosted rules test API was never asked for';
    if (hosted.ok) return 'the hosted rules test ran, and no run may reach Google';
    const attempt = state.calls.indexOf(hosted);

    const local = state.calls.find(
      (call, index) =>
        index > attempt &&
        call.ok &&
        (call.operation === 'verify_assurance_cases' ||
          call.operation === 'replay_assurance_session'),
    );
    if (!local) return 'the hosted route was refused and nothing local was tried after it';
    const answered = local.data as { cases?: unknown[]; divergences?: unknown[] } | undefined;
    if (!answered?.cases && !answered?.divergences) {
      return 'the local run reached no verdict to report';
    }
    return true;
  },
  tags: ['assurance', 'production', 'multi-step'],
};

export default task;
