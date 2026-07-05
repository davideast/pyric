/**
 * Item 1.3 — Same-path queued-write collapse.
 *
 * Probe 0.D verified `update + update` empirically. Other combinations
 * are extrapolated from Admin SDK semantics; tests pin the contract
 * so future regressions surface here, not in the commit path.
 */
import { describe, test, expect } from 'bun:test';
import {
  mergeQueuedWrites,
  AmbiguousPostDeleteWriteError,
} from 'pyric/sandbox/internal';
import type { QueuedWrite } from 'pyric/sandbox/internal';

describe('mergeQueuedWrites — single op passthrough', () => {
  test('one update → one BatchOperation', () => {
    const writes: QueuedWrite[] = [{ method: 'update', path: 'a/1', data: { x: 1 } }];
    expect(mergeQueuedWrites(writes)).toEqual([
      { method: 'update', path: 'a/1', data: { x: 1 } },
    ]);
  });

  test('one delete → one BatchOperation (no data)', () => {
    const writes: QueuedWrite[] = [{ method: 'delete', path: 'a/1' }];
    expect(mergeQueuedWrites(writes)).toEqual([
      { method: 'delete', path: 'a/1' },
    ]);
  });
});

describe('mergeQueuedWrites — different paths preserved', () => {
  test('writes to different paths emit one op per path, in insertion order', () => {
    const writes: QueuedWrite[] = [
      { method: 'update', path: 'a/1', data: { x: 1 } },
      { method: 'update', path: 'b/2', data: { y: 2 } },
      { method: 'delete', path: 'c/3' },
    ];
    expect(mergeQueuedWrites(writes)).toEqual([
      { method: 'update', path: 'a/1', data: { x: 1 } },
      { method: 'update', path: 'b/2', data: { y: 2 } },
      { method: 'delete', path: 'c/3' },
    ]);
  });
});

describe('mergeQueuedWrites — same-path collapse (probe 0.D)', () => {
  test('update + update merges fields (last-wins per field, earlier preserved)', () => {
    const writes: QueuedWrite[] = [
      { method: 'update', path: 'p/1', data: { x: 1, shared: 'first' } },
      { method: 'update', path: 'p/1', data: { y: 2, shared: 'second' } },
    ];
    expect(mergeQueuedWrites(writes)).toEqual([
      {
        method: 'update',
        path: 'p/1',
        data: { x: 1, y: 2, shared: 'second' },
      },
    ]);
  });

  test('set + update keeps set as method, applies update on top', () => {
    const writes: QueuedWrite[] = [
      { method: 'set', path: 'p/1', data: { x: 1 } },
      { method: 'update', path: 'p/1', data: { y: 2 } },
    ];
    expect(mergeQueuedWrites(writes)).toEqual([
      { method: 'set', path: 'p/1', data: { x: 1, y: 2 } },
    ]);
  });

  test('create + update keeps create as method, merges data', () => {
    const writes: QueuedWrite[] = [
      { method: 'create', path: 'p/1', data: { x: 1 } },
      { method: 'update', path: 'p/1', data: { y: 2 } },
    ];
    expect(mergeQueuedWrites(writes)).toEqual([
      { method: 'create', path: 'p/1', data: { x: 1, y: 2 } },
    ]);
  });

  test('set + set: second set replaces first entirely', () => {
    const writes: QueuedWrite[] = [
      { method: 'set', path: 'p/1', data: { x: 1, gone: true } },
      { method: 'set', path: 'p/1', data: { y: 2 } },
    ];
    expect(mergeQueuedWrites(writes)).toEqual([
      { method: 'set', path: 'p/1', data: { y: 2 } },
    ]);
  });

  test('update + set: set replaces (set is overwrite)', () => {
    const writes: QueuedWrite[] = [
      { method: 'update', path: 'p/1', data: { x: 1 } },
      { method: 'set', path: 'p/1', data: { y: 2 } },
    ];
    expect(mergeQueuedWrites(writes)).toEqual([
      { method: 'set', path: 'p/1', data: { y: 2 } },
    ]);
  });

  test('anything-then-delete: delete wins', () => {
    for (const first of ['set', 'create', 'update'] as const) {
      const writes: QueuedWrite[] = [
        { method: first, path: 'p/1', data: { x: 1 } },
        { method: 'delete', path: 'p/1' },
      ];
      expect(mergeQueuedWrites(writes)).toEqual([
        { method: 'delete', path: 'p/1' },
      ]);
    }
  });

  test('three-op chain folds left-to-right', () => {
    const writes: QueuedWrite[] = [
      { method: 'set', path: 'p/1', data: { a: 1 } },
      { method: 'update', path: 'p/1', data: { b: 2 } },
      { method: 'update', path: 'p/1', data: { c: 3 } },
    ];
    expect(mergeQueuedWrites(writes)).toEqual([
      { method: 'set', path: 'p/1', data: { a: 1, b: 2, c: 3 } },
    ]);
  });
});

describe('mergeQueuedWrites — delete-then-write throws', () => {
  test('delete + update throws AmbiguousPostDeleteWriteError', () => {
    const writes: QueuedWrite[] = [
      { method: 'delete', path: 'p/1' },
      { method: 'update', path: 'p/1', data: { x: 1 } },
    ];
    expect(() => mergeQueuedWrites(writes)).toThrow(AmbiguousPostDeleteWriteError);
  });

  test('delete + set / create also throw', () => {
    for (const second of ['set', 'create'] as const) {
      const writes: QueuedWrite[] = [
        { method: 'delete', path: 'p/1' },
        { method: second, path: 'p/1', data: {} },
      ];
      expect(() => mergeQueuedWrites(writes)).toThrow(AmbiguousPostDeleteWriteError);
    }
  });

  test('delete + delete also throws (still ambiguous)', () => {
    const writes: QueuedWrite[] = [
      { method: 'delete', path: 'p/1' },
      { method: 'delete', path: 'p/1' },
    ];
    expect(() => mergeQueuedWrites(writes)).toThrow(AmbiguousPostDeleteWriteError);
  });

  test('error names the path and the offending second method', () => {
    const writes: QueuedWrite[] = [
      { method: 'delete', path: 'foo/bar' },
      { method: 'update', path: 'foo/bar', data: { x: 1 } },
    ];
    try {
      mergeQueuedWrites(writes);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousPostDeleteWriteError);
      const err = e as AmbiguousPostDeleteWriteError;
      expect(err.path).toBe('foo/bar');
      expect(err.secondMethod).toBe('update');
      expect(err.message).toContain('foo/bar');
      expect(err.message).toContain('update');
    }
  });
});

describe('mergeQueuedWrites — interleaved paths fold independently', () => {
  test('two paths with their own update chains each collapse to one op', () => {
    const writes: QueuedWrite[] = [
      { method: 'update', path: 'a/1', data: { x: 1 } },
      { method: 'update', path: 'b/2', data: { y: 1 } },
      { method: 'update', path: 'a/1', data: { x: 2 } },
      { method: 'update', path: 'b/2', data: { y: 2 } },
    ];
    expect(mergeQueuedWrites(writes)).toEqual([
      { method: 'update', path: 'a/1', data: { x: 2 } },
      { method: 'update', path: 'b/2', data: { y: 2 } },
    ]);
  });
});
