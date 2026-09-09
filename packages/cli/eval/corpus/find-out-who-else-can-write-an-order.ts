import type { EvalTask } from '../types.js';
import { OPEN_ORDER_RULES } from '../sessions.js';

const task: EvalTask = {
  id: 'find-out-who-else-can-write-an-order',
  prompt:
    'Orders are supposed to be private to whoever placed them, and I do not trust the rules we have. Alice is a real account here and she can already write her own order. Work out whether she can change one she does not own, and show me the run that proves it rather than telling me.',
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
    const ran = state.calls.find((call) => call.operation === 'run_assurance_probes' && call.ok);
    if (!ran) return 'no probe was ever run, so nothing was proved';
    const summary = (ran.data as { summary?: { localCounterexamples?: number } } | undefined)?.summary;
    if (!summary) return 'the run reported no summary';
    if ((summary.localCounterexamples ?? 0) < 1) {
      return 'the run found no counterexample, and these rules let anyone write any order';
    }
    const inspected = state.calls.find((call) => call.operation === 'inspect_assurance_probe' && call.ok);
    if (!inspected) return 'the counterexample was never inspected';
    const classification = (
      inspected.data as { result?: { classification?: string } } | undefined
    )?.result?.classification;
    if (classification !== 'local-counterexample') {
      return `the inspected probe came back '${String(classification)}'`;
    }
    return true;
  },
  tags: ['assurance', 'campaign', 'multi-step'],
};

export default task;
