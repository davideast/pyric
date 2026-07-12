/**
 * Unit tests for the bounded-concurrency primitives used by the
 * discover_paths BFS crawler (Item 2.1).
 *
 * The crawler relies on:
 *   - in-flight cap is honored exactly (no over-subscription)
 *   - waiters are FIFO (oldest layer drained before newest)
 *   - `release()` without `acquire()` is a no-op
 *   - `runWithLimit` preserves input ordering in results
 *   - `runWithLimit` does not mask rejections, but does let in-flight
 *     work finish so we don't leak pending RPCs on failure
 */

import { describe, expect, test } from 'bun:test';
import { Semaphore, runWithLimit } from '../../src/discover/concurrency.js';

// ─── Semaphore ────────────────────────────────────────────────────────────

describe('Semaphore', () => {
  test('rejects non-positive max', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(-1)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });

  test('acquire up to max resolves immediately', async () => {
    const sem = new Semaphore(3);
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    expect(sem.inFlight).toBe(3);
    sem.release();
    sem.release();
    sem.release();
  });

  test('acquire beyond max blocks until release', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let resolved = false;
    const blocked = sem.acquire().then(() => {
      resolved = true;
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    expect(sem.pending).toBe(1);

    sem.release();
    await blocked;
    expect(resolved).toBe(true);
    sem.release();
  });

  test('FIFO ordering: waiters served in arrival order', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    const p3 = sem.acquire().then(() => order.push(3));

    sem.release();
    await p1;
    sem.release();
    await p2;
    sem.release();
    await p3;
    sem.release();

    expect(order).toEqual([1, 2, 3]);
  });

  test('release without acquire does not go negative', () => {
    const sem = new Semaphore(2);
    expect(() => sem.release()).not.toThrow();
    expect(sem.inFlight).toBe(0);
  });

  test('inFlight tracks active permits', async () => {
    const sem = new Semaphore(2);
    expect(sem.inFlight).toBe(0);
    await sem.acquire();
    expect(sem.inFlight).toBe(1);
    await sem.acquire();
    expect(sem.inFlight).toBe(2);
    sem.release();
    expect(sem.inFlight).toBe(1);
    sem.release();
    expect(sem.inFlight).toBe(0);
  });
});

// ─── runWithLimit ─────────────────────────────────────────────────────────

describe('runWithLimit', () => {
  test('rejects non-positive limit', async () => {
    await expect(runWithLimit([1], 0, async (x) => x)).rejects.toThrow(RangeError);
    await expect(runWithLimit([1], -1, async (x) => x)).rejects.toThrow(RangeError);
  });

  test('empty input resolves to empty array immediately', async () => {
    const result = await runWithLimit<number, number>([], 4, async (x) => x * 2);
    expect(result).toEqual([]);
  });

  test('preserves input order in results', async () => {
    // Producers complete in REVERSE order on purpose — input 0 sleeps the
    // longest, input N sleeps the shortest. Output must still be sorted by
    // input index, not completion order.
    const items = [0, 1, 2, 3, 4];
    const result = await runWithLimit(items, 8, async (x) => {
      await new Promise((r) => setTimeout(r, 10 - x * 2));
      return x * 10;
    });
    expect(result).toEqual([0, 10, 20, 30, 40]);
  });

  test('honors in-flight cap exactly', async () => {
    const limit = 3;
    let inFlight = 0;
    let peak = 0;

    await runWithLimit(Array.from({ length: 12 }, (_, i) => i), limit, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });

    expect(peak).toBe(limit);
    expect(inFlight).toBe(0);
  });

  test('rejection: lets in-flight work finish, surfaces first error', async () => {
    let completedAfterFailure = 0;
    const items = [0, 1, 2, 3, 4];
    let thrown: unknown = undefined;
    try {
      await runWithLimit(items, 5, async (x) => {
        if (x === 1) {
          throw new Error(`failure at ${x}`);
        }
        await new Promise((r) => setTimeout(r, 10));
        completedAfterFailure++;
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toBe('failure at 1');
    // Other 4 items got the chance to settle
    expect(completedAfterFailure).toBe(4);
  });

  test('multiple errors: surfaces lowest-index error deterministically', async () => {
    let thrown: unknown = undefined;
    try {
      await runWithLimit([0, 1, 2, 3], 4, async (x) => {
        if (x === 3) throw new Error(`late: ${x}`);
        if (x === 1) throw new Error(`early: ${x}`);
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toBe('early: 1');
  });
});
