import type { EvalTask } from '../types.js';
import { OWNER_ORDER_RULES, RECORDED_ORDER_RULES } from '../../test/fixtures/order-rules.js';
import { recordOrderSession } from '../sessions.js';

const task: EvalTask = {
  id: 'run-the-recorded-cases-against-owner-rules',
  prompt: `I rewrote the order rules to key off the owner field instead of a hard-coded uid. Take every request the app actually made last time, turn it into a case, and decide each one against the new rules. I want a per-case verdict, not a summary:\n\n${OWNER_ORDER_RULES}`,
  seed: {
    session: recordOrderSession,
    firestoreRules: RECORDED_ORDER_RULES,
    firestore: { 'orders/o1': { owner: 'alice', total: 10 } },
  },
  acceptedFirstOperations: ['verify_assurance_cases'],
  assert: (state) => {
    const decided = state.calls.find((call) => call.operation === 'verify_assurance_cases');
    if (!decided) return 'the recorded cases were never decided';
    const data = decided.data as
      | { cases?: Array<{ path?: string; recorded?: string; candidate?: string }>; diverged?: number }
      | undefined;
    const cases = data?.cases ?? [];
    if (cases.length < 2) return `only ${cases.length} case(s) were decided; the recording holds two`;
    if (data?.diverged !== 0) return `${String(data?.diverged)} case(s) changed verdict under rules that keep them all`;
    for (const decidedCase of cases) {
      if (decidedCase.recorded !== 'allow' || decidedCase.candidate !== 'allow') {
        return `case ${String(decidedCase.path)} came back ${String(decidedCase.candidate)}`;
      }
    }
    return true;
  },
  tags: ['assurance', 'cases', 'read'],
};

export default task;
