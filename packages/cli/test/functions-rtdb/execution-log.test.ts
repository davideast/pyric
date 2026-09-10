import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { executionLogFor } from '../../src/functions-rtdb/execution-log.js';

describe('FunctionsExecutionLog', () => {
  test('assigns each record a stable id in log order', () => {
    const sandbox = initializeSandbox();
    const log = executionLogFor(sandbox);
    const first = log.record({
      trigger: 'makeUppercase',
      cause: { ref: 'messages/one/original', params: { pushId: 'one' } },
      startedAt: 100,
      durationMs: 5,
      status: 'fulfilled',
    });
    const second = log.record({
      trigger: 'makeUppercase',
      cause: { ref: 'messages/two/original', params: { pushId: 'two' } },
      startedAt: 200,
      durationMs: 3,
      status: 'rejected',
      error: 'boom',
    });
    expect(first.id).not.toBe(second.id);
    expect(log.list()).toEqual([first, second]);
  });

  test('lists only records at or after the cursor', () => {
    const sandbox = initializeSandbox();
    const log = executionLogFor(sandbox);
    log.record({
      trigger: 'a',
      cause: { ref: 'x/1', params: {} },
      startedAt: 10,
      durationMs: 1,
      status: 'fulfilled',
    });
    const later = log.record({
      trigger: 'a',
      cause: { ref: 'x/2', params: {} },
      startedAt: 20,
      durationMs: 1,
      status: 'fulfilled',
    });
    expect(log.list(20)).toEqual([later]);
  });

  test('keeps one log per sandbox', () => {
    const sandboxA = initializeSandbox();
    const sandboxB = initializeSandbox();
    executionLogFor(sandboxA).record({
      trigger: 'a',
      cause: { ref: 'x/1', params: {} },
      startedAt: 1,
      durationMs: 1,
      status: 'fulfilled',
    });
    expect(executionLogFor(sandboxB).list()).toEqual([]);
  });
});
