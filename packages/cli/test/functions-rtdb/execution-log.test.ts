/**
 * The execution list is a fold over the sandbox event stream, so the same
 * properties the private log used to guarantee have to hold of the fold:
 * stable ids in the order runs finished, a cursor that filters by start
 * instant, and one history per sandbox.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { emitExecutionFinished } from '../../src/functions-rtdb/events.js';
import { executionIdFor, listExecutions } from '../../src/functions-rtdb/execution-log.js';

function finish(
  sandbox: LocalSandbox,
  outcome: {
    trigger: string;
    ref: string;
    params?: Record<string, string>;
    startedAt: number;
    status?: 'fulfilled' | 'rejected';
    result?: unknown;
    error?: string;
  },
): void {
  emitExecutionFinished(sandbox, {
    trigger: outcome.trigger,
    ref: outcome.ref,
    params: outcome.params ?? {},
    startedAt: outcome.startedAt,
    durationMs: 1,
    status: outcome.status ?? 'fulfilled',
    result: outcome.result,
    error: outcome.error,
  });
}

describe('functions execution history', () => {
  test('assigns each record a stable id in the order runs finished', () => {
    const sandbox = initializeSandbox();
    expect(executionIdFor(sandbox)).toBe('1');
    finish(sandbox, { trigger: 'makeUppercase', ref: 'messages/one/original', startedAt: 100 });
    expect(executionIdFor(sandbox)).toBe('2');
    finish(sandbox, {
      trigger: 'makeUppercase',
      ref: 'messages/two/original',
      startedAt: 200,
      status: 'rejected',
      error: 'boom',
    });

    const listed = listExecutions(sandbox);
    expect(listed.map((record) => record.id)).toEqual(['1', '2']);
    expect(listed[1]!.status).toBe('rejected');
    expect(listed[1]!.error).toBe('boom');
  });

  test('carries the cause the synthetic event named', () => {
    const sandbox = initializeSandbox();
    finish(sandbox, {
      trigger: 'makeUppercase',
      ref: 'messages/one/original',
      params: { pushId: 'one' },
      startedAt: 100,
      result: 'HELLO',
    });
    const [record] = listExecutions(sandbox);
    expect(record!.cause).toEqual({ ref: 'messages/one/original', params: { pushId: 'one' } });
    expect(record!.result).toBe('HELLO');
  });

  test('lists only records at or after the cursor', () => {
    const sandbox = initializeSandbox();
    finish(sandbox, { trigger: 'a', ref: 'x/1', startedAt: 10 });
    finish(sandbox, { trigger: 'a', ref: 'x/2', startedAt: 20 });
    expect(listExecutions(sandbox, 20).map((record) => record.cause.ref)).toEqual(['x/2']);
  });

  test('keeps one history per sandbox', () => {
    const sandboxA = initializeSandbox();
    const sandboxB = initializeSandbox();
    finish(sandboxA, { trigger: 'a', ref: 'x/1', startedAt: 1 });
    expect(listExecutions(sandboxB)).toEqual([]);
  });
});
