import type { EvalTask } from '../types.js';
import { OPEN_ORDER_RULES, OWNER_ORDER_RULES } from '../../test/fixtures/order-rules.js';

const task: EvalTask = {
  id: 'check-the-owner-rules-close-the-hole',
  prompt: `Anyone can rewrite anyone else's order right now. Alice is a real account and she writes her own order fine today, which has to keep working. Prove the hole is there, then tell me whether this rewrite closes it without breaking her:\n\n${OWNER_ORDER_RULES}`,
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
    if (!ran) return 'the hole was never demonstrated';
    const found = (ran.data as { summary?: { localCounterexamples?: number } } | undefined)?.summary;
    if ((found?.localCounterexamples ?? 0) < 1) return 'the run demonstrated no hole to close';
    const verified = state.calls.find((call) => call.operation === 'verify_assurance_rules' && call.ok);
    if (!verified) return 'the candidate rules were never checked against the campaign';
    const report = verified.data as
      | { verified?: boolean; summary?: { controlsPassed?: number; localCounterexamples?: number } }
      | undefined;
    if (report?.verified !== true) return 'the candidate came back unverified';
    if ((report.summary?.localCounterexamples ?? 1) !== 0) {
      return 'the candidate still leaves a counterexample standing';
    }
    if ((report.summary?.controlsPassed ?? 0) < 1) return 'the candidate broke the control it had to keep';
    return true;
  },
  tags: ['assurance', 'campaign', 'multi-step'],
};

export default task;
