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

function stateWithCalls(calls: EvalCall[]): EvalState {
  return { ...emptyEvalState(), calls };
}

describe('query-open-invoices accepts either shape getDocs resolves to', () => {
  it('accepts a query call', () => {
    const state = stateWithCalls([
      { operation: 'query_firestore_documents', tool: 'firestore', ok: true, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(queryOpenInvoices.assert(state)).toBe(true);
  });

  it('accepts a plain listing, since getDocs without constraints lists', () => {
    const state = stateWithCalls([
      { operation: 'list_firestore_documents', tool: 'firestore', ok: true, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(queryOpenInvoices.assert(state)).toBe(true);
  });

  it('fails when the invoices collection was never reached', () => {
    const state = stateWithCalls([
      { operation: 'get_firestore_document', tool: 'firestore', ok: true, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(queryOpenInvoices.assert(state)).not.toBe(true);
  });
});

describe('lint-then-simulate-fix accepts a verdict or a verified impersonated read', () => {
  const lintCall: EvalCall = {
    operation: 'lint_firestore_rules',
    tool: 'rules',
    ok: true,
    schemaRejected: false,
    args: {},
    data: undefined,
  };

  it('accepts a simulate verdict', () => {
    const state = stateWithCalls([
      lintCall,
      { operation: 'simulate_firestore_rules', tool: 'rules', ok: true, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(lintThenSimulateFix.assert(state)).toBe(true);
  });

  it('accepts a real read run as alice after switching identity', () => {
    const state = stateWithCalls([
      lintCall,
      { operation: 'switch_auth_identity', tool: 'auth', ok: true, schemaRejected: false, args: {}, data: undefined },
      { operation: 'get_firestore_document', tool: 'firestore', ok: true, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(lintThenSimulateFix.assert(state)).toBe(true);
  });

  it('rejects a read that never switched identity first', () => {
    const state = stateWithCalls([
      lintCall,
      { operation: 'get_firestore_document', tool: 'firestore', ok: true, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(lintThenSimulateFix.assert(state)).not.toBe(true);
  });

  it('still requires the rules to have been linted', () => {
    const state = stateWithCalls([
      { operation: 'simulate_firestore_rules', tool: 'rules', ok: true, schemaRejected: false, args: {}, data: undefined },
    ]);
    expect(lintThenSimulateFix.assert(state)).not.toBe(true);
  });
});
