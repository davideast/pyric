import type { EvalCall, EvalTask } from '../types.js';
import { OPEN_ORDER_RULES } from '../../test/fixtures/order-rules.js';

/** Document path a call named, under either variant's argument shape. */
function pathNamed(call: EvalCall): string | null {
  const nested = call.args.args as Record<string, unknown> | undefined;
  const path = nested?.path ?? call.args.path;
  return typeof path === 'string' ? path : null;
}

/** Identity a switch named, under either variant's argument shape. */
function uidNamed(call: EvalCall): string | null {
  const nested = call.args.args as Record<string, unknown> | undefined;
  const uid = nested?.uid ?? call.args.uid;
  return typeof uid === 'string' ? uid : null;
}

const WRITE_OPERATIONS = new Set([
  'write_firestore_document',
  'update_firestore_document',
  'batch_firestore_writes',
]);

/**
 * The campaign path: a probe run that found a counterexample and was then
 * inspected. Returns true, or the reason the campaign fell short.
 */
function provedByCampaign(calls: EvalCall[]): true | string {
  const ran = calls.find((call) => call.operation === 'run_assurance_probes' && call.ok);
  if (!ran) return 'no probe was ever run';
  const summary = (ran.data as { summary?: { localCounterexamples?: number } } | undefined)?.summary;
  if (!summary) return 'the run reported no summary';
  if ((summary.localCounterexamples ?? 0) < 1) {
    return 'the run found no counterexample, and these rules let anyone write any order';
  }
  const inspected = calls.find((call) => call.operation === 'inspect_assurance_probe' && call.ok);
  if (!inspected) return 'the counterexample was never inspected';
  const classification = (
    inspected.data as { result?: { classification?: string } } | undefined
  )?.result?.classification;
  if (classification !== 'local-counterexample') {
    return `the inspected probe came back '${String(classification)}'`;
  }
  return true;
}

/**
 * The impersonation path: acting as alice, writing an order she does not own,
 * and reading it back so the change is shown rather than asserted. That is the
 * run the prompt asks for, and it proves the same thing a campaign proves.
 */
function provedByImpersonation(calls: EvalCall[]): true | string {
  const switchIndex = calls.findIndex(
    (call) => call.operation === 'switch_auth_identity' && call.ok && uidNamed(call) === 'alice',
  );
  if (switchIndex === -1) return 'no call acted as alice';
  const afterSwitch = calls.slice(switchIndex + 1);
  const wroteIndex = afterSwitch.findIndex(
    (call) =>
      call.ok && WRITE_OPERATIONS.has(call.operation ?? '') && pathNamed(call) === 'orders/o2',
  );
  if (wroteIndex === -1) return "alice never wrote bob's order";
  const readBack = afterSwitch
    .slice(wroteIndex + 1)
    .some(
      (call) =>
        call.ok &&
        (call.operation === 'get_firestore_document' ||
          call.operation === 'list_firestore_documents') &&
        (pathNamed(call) === 'orders/o2' || pathNamed(call) === 'orders'),
    );
  if (!readBack) return 'the write was never read back, so nothing was shown';
  return true;
}

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
  acceptedFirstOperations: [
    'attach_assurance_target',
    'start_assurance_campaign',
    'switch_auth_identity',
  ],
  assert: (state) => {
    const campaign = provedByCampaign(state.calls);
    if (campaign === true) return true;
    const impersonation = provedByImpersonation(state.calls);
    if (impersonation === true) return true;
    return `nothing proved the hole: ${campaign}, and ${impersonation}`;
  },
  tags: ['assurance', 'campaign', 'multi-step'],
};

export default task;
