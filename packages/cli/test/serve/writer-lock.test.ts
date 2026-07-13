/** Single-writer lock (pyric-persist 4.6). */
import { describe, expect, it } from 'bun:test';
import { createWriterLock } from '../../src/serve/writer-lock.js';

describe('createWriterLock', () => {
  it('grants the first claimer; refuses a different live id; re-grants the holder', () => {
    const lock = createWriterLock(1000);
    expect(lock.claim('A', 0)).toBe(true);
    expect(lock.holder()).toBe('A');
    expect(lock.claim('B', 100)).toBe(false); // A still fresh
    expect(lock.claim('A', 200)).toBe(true); // holder refreshes
  });

  it('lets a new id steal a STALE lock (crashed/idle holder)', () => {
    const lock = createWriterLock(1000);
    expect(lock.claim('A', 0)).toBe(true);
    expect(lock.claim('B', 500)).toBe(false); // within stale window
    expect(lock.claim('B', 1500)).toBe(true); // A went stale → B takes over
    expect(lock.holder()).toBe('B');
  });

  it('release frees the lock for the holder only', () => {
    const lock = createWriterLock(1000);
    lock.claim('A', 0);
    lock.release('B'); // not the holder — no-op
    expect(lock.holder()).toBe('A');
    lock.release('A');
    expect(lock.holder()).toBeNull();
    expect(lock.claim('B', 100)).toBe(true); // now free
  });
});
