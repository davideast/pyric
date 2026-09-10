/**
 * `acceptedOpReached` folds `rescore.ts`'s `anyAccepted` metric into the scorer
 * itself: whether any logged call, not just the first, reached an operation the
 * task accepts. Unlike `firstOperationAccepted`, a task that accepts nothing in
 * particular (an empty list) still reports true, matching the first-operation
 * rule the scorer already applies.
 */
import { describe, expect, test } from 'bun:test';
import { scoreRun } from '../score.js';
import type { EvalCall, EvalRow, EvalRun, EvalState, EvalTask } from '../types.js';

const ROW: EvalRow = {
  id: 'row',
  cli: 'claude',
  model: 'm',
  condition: 'agent-default',
  seeds: [1],
};

function stateWithCalls(calls: EvalCall[]): EvalState {
  return {
    firestore: { get: () => null, list: () => [] },
    database: { get: () => undefined },
    users: { get: () => null, list: () => [] },
    storage: { get: () => null },
    calls,
  };
}

function runWith(accepted: string[]): EvalRun {
  const task: EvalTask = {
    id: 't',
    prompt: 'do it',
    seed: {},
    acceptedFirstOperations: accepted,
    assert: () => true,
    tags: [],
  };
  return {
    runId: 'r',
    row: ROW,
    variant: 'verb-prefixed',
    task,
    seed: 1,
    dir: '/dir',
    workspaceDir: '/dir/workspace',
    stateDir: '/state',
    eventsPath: '/state/events.ndjson',
    serverCommand: ['bun'],
    repoRoot: '/repo',
  };
}

describe('acceptedOpReached', () => {
  test('a later call reaching an accepted operation counts, even when the first call did not', () => {
    const state = stateWithCalls([
      { operation: 'get_firestore_document', tool: 'get_firestore_document', ok: true, verdict: false, schemaRejected: false, args: {}, data: undefined },
      { operation: 'write_firestore_document', tool: 'write_firestore_document', ok: true, verdict: false, schemaRejected: false, args: {}, data: undefined },
    ]);
    const line = scoreRun({
      run: runWith(['write_firestore_document']),
      spawn: 'completed',
      durationMs: 1,
      state,
    });
    expect(line.firstOperationAccepted).toBe(false);
    expect(line.acceptedOpReached).toBe(true);
  });

  test('no call reaching an accepted operation reports false', () => {
    const state = stateWithCalls([
      { operation: 'get_firestore_document', tool: 'get_firestore_document', ok: true, verdict: false, schemaRejected: false, args: {}, data: undefined },
    ]);
    const line = scoreRun({
      run: runWith(['write_firestore_document']),
      spawn: 'completed',
      durationMs: 1,
      state,
    });
    expect(line.acceptedOpReached).toBe(false);
  });

  test('an empty accepted list always reports true, like the first-operation rule', () => {
    const state = stateWithCalls([]);
    const line = scoreRun({ run: runWith([]), spawn: 'completed', durationMs: 1, state });
    expect(line.acceptedOpReached).toBe(true);
  });
});

describe('verdict calls', () => {
  test('a failing call carrying a verdict is counted as a verdict, not an error', () => {
    const state = stateWithCalls([
      {
        operation: 'write_firestore_document',
        tool: 'write_firestore_document',
        ok: false,
        verdict: true,
        schemaRejected: false,
        args: {},
        data: { code: 'denied_by_rules' },
      },
      {
        operation: 'lint_firestore_rules',
        tool: 'lint_firestore_rules',
        ok: false,
        verdict: true,
        schemaRejected: false,
        args: {},
        data: { code: 'lint_findings' },
      },
    ]);
    const line = scoreRun({ run: runWith([]), spawn: 'completed', durationMs: 1, state });
    expect(line.errorCalls).toBe(0);
    expect(line.verdictCalls).toBe(2);
  });

  test('a failing call carrying no verdict is still an error call', () => {
    const state = stateWithCalls([
      {
        operation: 'get_firestore_document',
        tool: 'get_firestore_document',
        ok: false,
        verdict: false,
        schemaRejected: false,
        args: {},
        data: { code: 'invalid_arguments' },
      },
    ]);
    const line = scoreRun({ run: runWith([]), spawn: 'completed', durationMs: 1, state });
    expect(line.errorCalls).toBe(1);
    expect(line.verdictCalls).toBe(0);
  });

  test('a successful call is neither an error call nor a verdict call', () => {
    const state = stateWithCalls([
      {
        operation: 'get_firestore_document',
        tool: 'get_firestore_document',
        ok: true,
        verdict: false,
        schemaRejected: false,
        args: {},
        data: undefined,
      },
    ]);
    const line = scoreRun({ run: runWith([]), spawn: 'completed', durationMs: 1, state });
    expect(line.errorCalls).toBe(0);
    expect(line.verdictCalls).toBe(0);
  });
});
