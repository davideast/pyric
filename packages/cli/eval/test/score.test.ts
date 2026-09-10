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
      { operation: 'get_firestore_document', tool: 'get_firestore_document', ok: true, schemaRejected: false },
      { operation: 'write_firestore_document', tool: 'write_firestore_document', ok: true, schemaRejected: false },
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
      { operation: 'get_firestore_document', tool: 'get_firestore_document', ok: true, schemaRejected: false },
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
