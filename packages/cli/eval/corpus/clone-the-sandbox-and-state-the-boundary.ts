import type { EvalTask } from '../types.js';
import { OPEN_ORDER_RULES } from '../../test/fixtures/order-rules.js';

const task: EvalTask = {
  id: 'clone-the-sandbox-and-state-the-boundary',
  prompt:
    'Take a copy of what is loaded right now so I can poke at it without touching the live data, note that alice is an account someone could sign in as and that she can already write her own order, and write down the rule we actually mean: nobody edits an order that is not theirs. Do not run anything against it yet.',
  seed: {
    firestoreRules: OPEN_ORDER_RULES,
    firestore: {
      'orders/o1': { owner: 'alice', total: 10 },
      'orders/o2': { owner: 'bob', total: 20 },
    },
    users: [{ uid: 'alice', email: 'alice@example.com' }],
  },
  acceptedFirstOperations: ['attach_assurance_target'],
  assert: (state) => {
    const attached = state.calls.find((call) => call.operation === 'attach_assurance_target' && call.ok);
    if (!attached) return 'nothing was cloned, so there is nothing to poke at';
    const inventory = (attached.data as { inventory?: { firestoreDocuments?: number } } | undefined)
      ?.inventory;
    if ((inventory?.firestoreDocuments ?? 0) < 2) {
      return `the clone reported ${String(inventory?.firestoreDocuments)} document(s); two were loaded`;
    }
    const mapped = state.calls.find((call) => call.operation === 'map_assurance_campaign' && call.ok);
    if (!mapped) return 'the actor and the known-good operation were never recorded';
    if ((mapped.data as { actors?: number } | undefined)?.actors !== 1) {
      return 'the clone was mapped with no reachable actor';
    }
    const defined = state.calls.find((call) => call.operation === 'define_assurance_invariants' && call.ok);
    if (!defined) return 'the boundary was never written down';
    if (state.calls.some((call) => call.operation === 'run_assurance_probes')) {
      return 'a probe was run, and the request said not to run anything yet';
    }
    const order = state.firestore.get('orders/o2');
    if (!order || order.owner !== 'bob') return 'orders/o2 changed, and a clone touches nothing';
    return true;
  },
  tags: ['assurance', 'campaign', 'multi-step'],
};

export default task;
