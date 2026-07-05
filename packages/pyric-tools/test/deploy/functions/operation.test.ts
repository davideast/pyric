/**
 * Polling helper tests. Uses a controlled `sleep` so the tests don't
 * actually wait, and asserts the backoff sequence + terminal-state
 * branches.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { pollOperation } from '../../../src/deploy/functions/operation.js';
import type { Operation } from '../../../src/deploy/functions/types.js';

let originalFetch: typeof fetch;
let sleeps: number[];
const noSleep = async (ms: number): Promise<void> => { sleeps.push(ms); };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sleeps = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockOperations(states: Operation[]): void {
  let i = 0;
  globalThis.fetch = (async () => {
    const op = states[Math.min(i, states.length - 1)];
    i++;
    return new Response(JSON.stringify(op), { status: 200 });
  }) as typeof fetch;
}

describe('pollOperation', () => {
  test('returns ok on done with response', async () => {
    mockOperations([
      { name: 'op1', done: false },
      { name: 'op1', done: true, response: { name: 'fn1' } as Operation['response'] },
    ]);
    const result = await pollOperation('op1', 'tok', { sleep: noSleep, initialBackoffMs: 100 });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.operation.response?.name).toBe('fn1');
  });

  test('returns failed on done with error', async () => {
    mockOperations([
      { name: 'op1', done: true, error: { code: 13, message: 'build broke' } },
    ]);
    const result = await pollOperation('op1', 'tok', { sleep: noSleep });
    expect(result.kind).toBe('failed');
  });

  test('exponential backoff capped at maxBackoffMs', async () => {
    mockOperations([
      { name: 'op1', done: false },
      { name: 'op1', done: false },
      { name: 'op1', done: false },
      { name: 'op1', done: false },
      { name: 'op1', done: true, response: { name: 'fn1' } as Operation['response'] },
    ]);
    await pollOperation('op1', 'tok', {
      sleep: noSleep,
      initialBackoffMs: 100,
      maxBackoffMs: 200,
    });
    // Sleeps between fetches: 100, 150, 200 (cap), 200 (cap).
    expect(sleeps).toEqual([100, 150, 200, 200]);
  });

  test('returns timeout when deadline elapses before done', async () => {
    // Always not-done; deadline is immediate so first iteration
    // makes the loop condition false on the next check.
    mockOperations([{ name: 'op1', done: false }]);
    const result = await pollOperation('op1', 'tok', {
      sleep: noSleep,
      initialBackoffMs: 1,
      deadlineMs: 1, // expires immediately
    });
    expect(result.kind).toBe('timeout');
  });

  test('returns http_error on non-2xx GET', async () => {
    globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;
    const result = await pollOperation('op1', 'tok', { sleep: noSleep });
    expect(result.kind).toBe('http_error');
    if (result.kind !== 'http_error') throw new Error('unreachable');
    expect(result.status).toBe(403);
  });

  test('returns network_error on fetch rejection', async () => {
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    const result = await pollOperation('op1', 'tok', { sleep: noSleep });
    expect(result.kind).toBe('network_error');
  });
});
