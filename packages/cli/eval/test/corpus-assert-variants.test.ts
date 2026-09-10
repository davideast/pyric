/**
 * Two corpus asserts were biased to one operation shape when the task's
 * prompt has more than one reasonable answer: `getDocs` without constraints
 * resolves to `list_firestore_documents`, not `query_firestore_documents`,
 * so an agent that lists and filters itself was scored a failure it should
 * not have been. These tests pin the fixed asserts against a synthetic
 * `EvalState` rather than a real run, so the accepted-shape logic is checked
 * without spawning a provider.
 */
import { describe, expect, it } from 'bun:test';
import { emptyEvalState } from '../state.js';
import type { EvalCall, EvalState } from '../types.js';
import queryOpenInvoices from '../corpus/query-open-invoices.js';
import lintThenSimulateFix from '../corpus/lint-then-simulate-fix.js';
import diffAgainstMissingCheckpoint from '../corpus/diff-against-a-checkpoint-that-is-not-there.js';
import findOutWhoElseCanWriteAnOrder from '../corpus/find-out-who-else-can-write-an-order.js';
import checkTheOwnerRulesCloseTheHole from '../corpus/check-the-owner-rules-close-the-hole.js';

function stateWithCalls(calls: EvalCall[]): EvalState {
  return { ...emptyEvalState(), calls };
}

/** One call, with the fields a task rarely reads defaulted. */
function call(fields: Partial<EvalCall> & { operation: string }): EvalCall {
  return {
    tool: 'stub',
    ok: true,
    verdict: false,
    schemaRejected: false,
    args: {},
    data: undefined,
    ...fields,
  };
}

describe('query-open-invoices accepts either shape getDocs resolves to', () => {
  it('accepts a query call', () => {
    const state = stateWithCalls([
      { operation: 'query_firestore_documents', tool: 'firestore', ok: true, verdict: false, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(queryOpenInvoices.assert(state)).toBe(true);
  });

  it('accepts a plain listing, since getDocs without constraints lists', () => {
    const state = stateWithCalls([
      { operation: 'list_firestore_documents', tool: 'firestore', ok: true, verdict: false, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(queryOpenInvoices.assert(state)).toBe(true);
  });

  it('fails when the invoices collection was never reached', () => {
    const state = stateWithCalls([
      { operation: 'get_firestore_document', tool: 'firestore', ok: true, verdict: false, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(queryOpenInvoices.assert(state)).not.toBe(true);
  });
});

describe('lint-then-simulate-fix accepts a verdict or a verified impersonated read', () => {
  const lintCall: EvalCall = {
    operation: 'lint_firestore_rules',
    tool: 'rules',
    ok: true,
    verdict: false,
    schemaRejected: false,
    args: {},
    data: undefined,
  };

  it('accepts a simulate verdict', () => {
    const state = stateWithCalls([
      lintCall,
      { operation: 'simulate_firestore_rules', tool: 'rules', ok: true, verdict: false, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(lintThenSimulateFix.assert(state)).toBe(true);
  });

  it('accepts a real read run as alice after switching identity', () => {
    const state = stateWithCalls([
      lintCall,
      { operation: 'switch_auth_identity', tool: 'auth', ok: true, verdict: false, schemaRejected: false, args: {}, data: undefined },
      { operation: 'get_firestore_document', tool: 'firestore', ok: true, verdict: false, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(lintThenSimulateFix.assert(state)).toBe(true);
  });

  it('rejects a read that never switched identity first', () => {
    const state = stateWithCalls([
      lintCall,
      { operation: 'get_firestore_document', tool: 'firestore', ok: true, verdict: false, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(lintThenSimulateFix.assert(state)).not.toBe(true);
  });

  it('still requires the rules to have been linted', () => {
    const state = stateWithCalls([
      { operation: 'simulate_firestore_rules', tool: 'rules', ok: true, verdict: false, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(lintThenSimulateFix.assert(state)).not.toBe(true);
  });

  it('accepts a read as alice that followed an earlier admin survey read', () => {
    // Comparing the first index of each operation asks whether the survey
    // read happened to come after the switch, which it did not. The question
    // is whether any read followed the switch, and one did.
    const state = stateWithCalls([
      lintCall,
      call({ operation: 'get_firestore_document' }),
      call({ operation: 'switch_auth_identity' }),
      call({ operation: 'get_firestore_document' }),
    ]);
    expect(lintThenSimulateFix.assert(state)).toBe(true);
  });

  it('rejects an admin read that came before the switch and was never repeated', () => {
    const state = stateWithCalls([
      lintCall,
      call({ operation: 'get_firestore_document' }),
      call({ operation: 'switch_auth_identity' }),
    ]);
    expect(lintThenSimulateFix.assert(state)).not.toBe(true);
  });
});

describe('diff-against-a-checkpoint-that-is-not-there accepts either way of establishing absence', () => {
  const seededInvoice: EvalState['firestore'] = {
    get: (path) => (path === 'invoices/inv_1' ? { status: 'open', amount: 90 } : null),
    list: () => [],
  };

  function stateOf(calls: EvalCall[]): EvalState {
    return { ...stateWithCalls(calls), firestore: seededInvoice };
  }

  it('accepts a refused diff that names the checkpoint, followed by one that succeeds', () => {
    const state = stateOf([
      call({ operation: 'fork_sandbox_branch' }),
      call({
        operation: 'diff_sandbox_branch',
        ok: false,
        args: { args: { branch: 'audit', against: 'friday-night' } },
      }),
      call({ operation: 'diff_sandbox_branch', args: { args: { branch: 'audit' } } }),
    ]);
    expect(diffAgainstMissingCheckpoint.assert(state)).toBe(true);
  });

  it('accepts a checkpoint listing that found none, followed by a diff against live', () => {
    const state = stateOf([
      call({ operation: 'fork_sandbox_branch' }),
      call({ operation: 'list_sandbox_checkpoints' }),
      call({
        operation: 'diff_sandbox_branch',
        args: { args: { branch: 'audit', against: 'live' } },
      }),
    ]);
    expect(diffAgainstMissingCheckpoint.assert(state)).toBe(true);
  });

  it('rejects a diff against live that established nothing about the checkpoint', () => {
    const state = stateOf([
      call({ operation: 'fork_sandbox_branch' }),
      call({ operation: 'diff_sandbox_branch', args: { args: { branch: 'audit' } } }),
    ]);
    expect(diffAgainstMissingCheckpoint.assert(state)).not.toBe(true);
  });
});

describe('find-out-who-else-can-write-an-order accepts a proof by impersonation', () => {
  it('accepts a cross-owner write as alice, read back afterwards', () => {
    const state = stateWithCalls([
      call({ operation: 'switch_auth_identity', args: { args: { uid: 'alice' } } }),
      call({
        operation: 'update_firestore_document',
        args: { args: { path: 'orders/o2', data: { total: 99999 } } },
      }),
      call({ operation: 'get_firestore_document', args: { args: { path: 'orders/o2' } } }),
    ]);
    expect(findOutWhoElseCanWriteAnOrder.assert(state)).toBe(true);
  });

  it('rejects a cross-owner write that was never read back', () => {
    const state = stateWithCalls([
      call({ operation: 'switch_auth_identity', args: { args: { uid: 'alice' } } }),
      call({
        operation: 'update_firestore_document',
        args: { args: { path: 'orders/o2', data: { total: 99999 } } },
      }),
    ]);
    expect(findOutWhoElseCanWriteAnOrder.assert(state)).not.toBe(true);
  });

  it('still accepts the campaign path', () => {
    const state = stateWithCalls([
      call({
        operation: 'run_assurance_probes',
        data: { summary: { localCounterexamples: 1 } },
      }),
      call({
        operation: 'inspect_assurance_probe',
        data: { result: { classification: 'local-counterexample' } },
      }),
    ]);
    expect(findOutWhoElseCanWriteAnOrder.assert(state)).toBe(true);
  });
});

describe('check-the-owner-rules-close-the-hole accepts a hole shown by impersonation', () => {
  const CANDIDATE = 'allow write: if request.auth.uid == request.resource.data.owner;';

  it('accepts a cross-owner write plus candidate simulations either way', () => {
    const state = stateWithCalls([
      call({ operation: 'switch_auth_identity', args: { args: { uid: 'alice' } } }),
      call({
        operation: 'update_firestore_document',
        args: { args: { path: 'orders/o2', data: { total: 99999 } } },
      }),
      call({
        operation: 'simulate_firestore_rules',
        args: { args: { path: 'orders/o2', rules: CANDIDATE } },
        data: { allowed: false },
      }),
      call({
        operation: 'simulate_firestore_rules',
        args: { args: { path: 'orders/o1', rules: CANDIDATE } },
        data: { allowed: true },
      }),
    ]);
    expect(checkTheOwnerRulesCloseTheHole.assert(state)).toBe(true);
  });

  it("rejects a candidate that was never shown to keep alice's own write working", () => {
    const state = stateWithCalls([
      call({ operation: 'switch_auth_identity', args: { args: { uid: 'alice' } } }),
      call({
        operation: 'update_firestore_document',
        args: { args: { path: 'orders/o2', data: { total: 99999 } } },
      }),
      call({
        operation: 'simulate_firestore_rules',
        args: { args: { path: 'orders/o2', rules: CANDIDATE } },
        data: { allowed: false },
      }),
    ]);
    expect(checkTheOwnerRulesCloseTheHole.assert(state)).not.toBe(true);
  });

  it('still accepts the campaign path', () => {
    const state = stateWithCalls([
      call({
        operation: 'run_assurance_probes',
        data: { summary: { localCounterexamples: 1 } },
      }),
      call({
        operation: 'verify_assurance_rules',
        data: { verified: true, summary: { controlsPassed: 1, localCounterexamples: 0 } },
      }),
    ]);
    expect(checkTheOwnerRulesCloseTheHole.assert(state)).toBe(true);
  });
});
