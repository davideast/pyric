import type { EvalCall, EvalTask } from '../types.js';
import { OPEN_ORDER_RULES, OWNER_ORDER_RULES } from '../../test/fixtures/order-rules.js';

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

/** Whether a simulation carried the candidate ruleset rather than the live one. */
function carriedCandidateRules(call: EvalCall): boolean {
  const nested = call.args.args as Record<string, unknown> | undefined;
  const rules = nested?.rules ?? call.args.rules;
  return typeof rules === 'string' && rules.includes('request.resource.data.owner');
}

/** The verdict a simulation came back with. */
function simulationAllowed(call: EvalCall): boolean {
  return (call.data as { allowed?: unknown } | undefined)?.allowed === true;
}

const WRITE_OPERATIONS = new Set([
  'write_firestore_document',
  'update_firestore_document',
  'batch_firestore_writes',
]);

/** The campaign path: a probe run that found the hole, then a verified candidate. */
function checkedByCampaign(calls: EvalCall[]): true | string {
  const ran = calls.find((call) => call.operation === 'run_assurance_probes' && call.ok);
  if (!ran) return 'the hole was never demonstrated by a probe run';
  const found = (ran.data as { summary?: { localCounterexamples?: number } } | undefined)?.summary;
  if ((found?.localCounterexamples ?? 0) < 1) return 'the run demonstrated no hole to close';
  const verified = calls.find((call) => call.operation === 'verify_assurance_rules' && call.ok);
  if (!verified) return 'the candidate rules were never checked against the campaign';
  const report = verified.data as
    | { verified?: boolean; summary?: { controlsPassed?: number; localCounterexamples?: number } }
    | undefined;
  if (report?.verified !== true) return 'the candidate came back unverified';
  if ((report.summary?.localCounterexamples ?? 1) !== 0) {
    return 'the candidate still leaves a counterexample standing';
  }
  if ((report.summary?.controlsPassed ?? 0) < 1) {
    return 'the candidate broke the control it had to keep';
  }
  return true;
}

/**
 * The impersonation path: acting as alice and writing an order she does not
 * own shows the hole is real rather than argued, and simulating both the
 * cross-owner write and alice's own write under the candidate rules shows the
 * rewrite closes it without breaking her.
 */
function checkedByImpersonation(calls: EvalCall[]): true | string {
  const switchIndex = calls.findIndex(
    (call) => call.operation === 'switch_auth_identity' && call.ok && uidNamed(call) === 'alice',
  );
  if (switchIndex === -1) return 'no call acted as alice';
  const wroteOthersOrder = calls
    .slice(switchIndex + 1)
    .some(
      (call) =>
        call.ok && WRITE_OPERATIONS.has(call.operation ?? '') && pathNamed(call) === 'orders/o2',
    );
  if (!wroteOthersOrder) return "alice never wrote bob's order, so no hole was shown";

  const candidateSimulations = calls.filter(
    (call) =>
      call.operation === 'simulate_firestore_rules' && call.ok && carriedCandidateRules(call),
  );
  const closesTheHole = candidateSimulations.some(
    (call) => pathNamed(call)?.endsWith('orders/o2') === true && !simulationAllowed(call),
  );
  if (!closesTheHole) return 'the candidate was never shown to refuse the cross-owner write';
  const keepsAliceWorking = candidateSimulations.some(
    (call) => pathNamed(call)?.endsWith('orders/o1') === true && simulationAllowed(call),
  );
  if (!keepsAliceWorking) return "the candidate was never shown to keep alice's own write";
  return true;
}

/** Whether a rules installation carried the candidate ruleset. */
function installedCandidateRules(call: EvalCall): boolean {
  return call.operation === 'set_firestore_rules' && call.ok && carriedCandidateRules(call);
}

/**
 * The simulation path: a cross-owner write simulated as ALLOW under the live
 * rules is the hole, shown by verdict rather than by a real write. The
 * candidate then answers, either carried on the simulation or installed
 * first, with a DENY for a cross-owner write and an ALLOW for an owner's own.
 */
function checkedBySimulation(calls: EvalCall[]): true | string {
  const installedAt = calls.findIndex(installedCandidateRules);
  const underLiveRules = (index: number, call: EvalCall): boolean =>
    !carriedCandidateRules(call) && (installedAt === -1 || index < installedAt);
  const demonstrated = calls.some(
    (call, index) =>
      call.operation === 'simulate_firestore_rules' &&
      call.ok &&
      uidNamed(call) !== null &&
      underLiveRules(index, call) &&
      simulationAllowed(call),
  );
  if (!demonstrated) return 'no simulation showed a cross-owner write allowed under the live rules';
  const underCandidate = calls.filter(
    (call, index) =>
      call.operation === 'simulate_firestore_rules' &&
      call.ok &&
      (carriedCandidateRules(call) || (installedAt !== -1 && index > installedAt)),
  );
  if (!underCandidate.some((call) => !simulationAllowed(call))) {
    return 'the candidate was never shown to refuse a cross-owner write';
  }
  if (!underCandidate.some(simulationAllowed)) {
    return "the candidate was never shown to keep an owner's own write";
  }
  return true;
}

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
  acceptedFirstOperations: [
    'attach_assurance_target',
    'start_assurance_campaign',
    'switch_auth_identity',
  ],
  assert: (state) => {
    const campaign = checkedByCampaign(state.calls);
    if (campaign === true) return true;
    const impersonation = checkedByImpersonation(state.calls);
    if (impersonation === true) return true;
    const simulation = checkedBySimulation(state.calls);
    if (simulation === true) return true;
    return `the hole was never demonstrated and closed: ${campaign}, ${impersonation}, and ${simulation}`;
  },
  tags: ['assurance', 'campaign', 'multi-step'],
};

export default task;
