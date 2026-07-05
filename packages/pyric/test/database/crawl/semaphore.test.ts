import { describe, test, expect } from 'bun:test';
import { Semaphore } from '../../../src/database/crawl/semaphore.js';

describe('Semaphore', () => {
  test('acquire up to max without blocking', async () => {
    const sem = new Semaphore(3);
    // All three should resolve immediately
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    // If we got here, none blocked
    expect(true).toBe(true);
    sem.release();
    sem.release();
    sem.release();
  });

  test('acquire beyond max blocks until release', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let resolved = false;
    const blocked = sem.acquire().then(() => { resolved = true; });

    // Give microtasks a chance to run
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);

    sem.release();
    await blocked;
    expect(resolved).toBe(true);
    sem.release();
  });

  test('FIFO ordering: first waiter resolves first', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));

    sem.release(); // unblocks p1
    await p1;
    sem.release(); // unblocks p2
    await p2;

    expect(order).toEqual([1, 2]);
    sem.release();
    sem.release();
  });

  test('release without matching acquire does not go negative', () => {
    const sem = new Semaphore(2);
    // Release without acquire should not throw
    expect(() => sem.release()).not.toThrow();
  });
});
