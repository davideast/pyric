/**
 * Bounded concurrency primitives for the Firestore discover_paths crawler.
 *
 * Phase 0.3 of the validation plan locked layered BFS with `Promise.all`-per-
 * layer as the production strategy (38× faster than serial DFS on the
 * representative corpus). This module provides the two pieces every layer
 * needs:
 *
 *   - `Semaphore` — FIFO-ordered counting semaphore with `acquire`/`release`.
 *   - `runWithLimit` — ergonomic wrapper that maps a list of async producers
 *     through the semaphore and resolves to the ordered results.
 *
 * Kept self-contained (no `database/crawl/semaphore.ts` reuse) so the
 * `firestore/discover` subsystem owns its own concurrency contract.
 */
'use strict';

/**
 * FIFO counting semaphore. `acquire()` resolves immediately while
 * fewer than `max` permits are checked out, otherwise it queues until
 * a `release()` frees a slot. Waiters are served in arrival order.
 *
 * `release()` without a prior `acquire()` is a no-op (does not go
 * negative). This is intentional — it lets defensive `try/finally`
 * release in error paths without bookkeeping.
 */
export class Semaphore {
  private readonly max: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(
        `Semaphore: max must be a positive integer, got ${max}`,
      );
    }
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    if (this.active === 0) return; // never go negative
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Number of permits currently checked out. For tests and instrumentation
   * only; do not branch on this in production logic.
   */
  get inFlight(): number {
    return this.active;
  }

  /**
   * Number of waiters queued. For tests and instrumentation only.
   */
  get pending(): number {
    return this.queue.length;
  }
}

/**
 * Run `items` through `producer` concurrently, capping in-flight calls
 * at `limit`. Returns results in input order (same shape as
 * `Promise.all(items.map(producer))` — but bounded).
 *
 * `producer` may throw; the rejection propagates after in-flight work
 * settles. Other items continue running so the rejection isn't masked
 * by a Promise.all-style fast-fail leaving zombie pending work.
 *
 * Implementation detail: uses an internal `Semaphore(limit)`; callers
 * who need to share a permit pool across multiple `runWithLimit` calls
 * (e.g. crawler global RPC cap) should use the `Semaphore` class
 * directly via `acquire`/`release`.
 */
export async function runWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  producer: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(
      `runWithLimit: limit must be a positive integer, got ${limit}`,
    );
  }
  if (items.length === 0) return [];

  const sem = new Semaphore(limit);
  const results: R[] = new Array<R>(items.length);
  const errors: { index: number; error: unknown }[] = [];

  await Promise.all(
    items.map(async (item, index) => {
      await sem.acquire();
      try {
        results[index] = await producer(item, index);
      } catch (error) {
        errors.push({ index, error });
      } finally {
        sem.release();
      }
    }),
  );

  if (errors.length > 0) {
    // Surface the first error in input order — agents/tests can rely on
    // a deterministic surface even when multiple producers throw.
    errors.sort((a, b) => a.index - b.index);
    throw errors[0]!.error;
  }
  return results;
}
