/** Single-writer lock and optimistic state version fencing (pyric-persist 4.6, #2051). */
import { describe, expect, it } from 'bun:test';
import {
  createWriterLock,
  parseStateVersionHeader,
} from '../../src/serve/writer-lock.js';

describe('createWriterLock', () => {
  it('grants the first claimer; refuses a different live id; re-grants the holder', () => {
    const lock = createWriterLock(1000);
    expect(lock.claim('A', 0)).toBe(true);
    expect(lock.holder()).toBe('A');
    expect(lock.claim('B', 100)).toBe(false);
    expect(lock.claim('A', 200)).toBe(true);
  });

  it('lets a new id steal a STALE lock (crashed/idle holder)', () => {
    const lock = createWriterLock(1000);
    expect(lock.claim('A', 0)).toBe(true);
    expect(lock.claim('B', 500)).toBe(false);
    expect(lock.claim('B', 1500)).toBe(true);
    expect(lock.holder()).toBe('B');
  });

  it('release frees the lock for the holder only', () => {
    const lock = createWriterLock(1000);
    lock.claim('A', 0);
    lock.release('B');
    expect(lock.holder()).toBe('A');
    lock.release('A');
    expect(lock.holder()).toBeNull();
    expect(lock.claim('B', 100)).toBe(true);
  });

  it('tracks state version and refuses claims carrying an outdated version even when free or stale', () => {
    const lock = createWriterLock(1000);
    expect(lock.version()).toBe(0);
    expect(lock.claim('A', 0, 0)).toBe(true);
    expect(lock.advanceVersion()).toBe(1);
    expect(lock.version()).toBe(1);

    // A went stale (> 1000ms); B loaded version 1 and claims + writes -> version 2.
    expect(lock.claim('B', 1500, 1)).toBe(true);
    expect(lock.advanceVersion()).toBe(2);

    // Even after B releases the lock, A (still at version 1) and a late-claiming
    // tab L (loaded at version 0) are both refused.
    lock.release('B');
    expect(lock.holder()).toBeNull();
    expect(lock.claim('A', 2000, 1)).toBe(false);
    expect(lock.claim('L', 2000, 0)).toBe(false);
    expect(lock.holder()).toBeNull();

    // A tab that loaded current version 2 succeeds.
    expect(lock.claim('C', 2000, 2)).toBe(true);
    expect(lock.holder()).toBe('C');
  });
});

describe('parseStateVersionHeader', () => {
  it('parses absent, valid non-negative integers, and rejects malformed values', () => {
    expect(parseStateVersionHeader(undefined)).toBeUndefined();
    expect(parseStateVersionHeader(null)).toBeUndefined();
    expect(parseStateVersionHeader('  ')).toBeUndefined();
    expect(parseStateVersionHeader('0')).toBe(0);
    expect(parseStateVersionHeader('17')).toBe(17);
    expect(parseStateVersionHeader('01')).toBe('invalid');
    expect(parseStateVersionHeader('-1')).toBe('invalid');
    expect(parseStateVersionHeader('1.5')).toBe('invalid');
    expect(parseStateVersionHeader('abc')).toBe('invalid');
    expect(parseStateVersionHeader('999999999999999999999')).toBe('invalid');
  });
});
