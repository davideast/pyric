/**
 * Item 1.2 — TransactionContext callback class.
 *
 * Tests are decoupled from `LocalEnvironment` — they exercise the class
 * directly with a stub reader. The integration with `LocalEnvironment`
 * lives in Item 2's tests.
 *
 * Locked behaviors (validation plan probes):
 *   - 0.A + 0.J: read-after-write throws synchronously, GLOBAL ordering.
 *   - 0.B: missing doc → `{ exists: false, data() === undefined }`.
 *   - 0.C: getAll preserves input order.
 *   - Captured reads are immutable snapshots (won't mutate if the
 *     reader's source mutates after the call).
 */
import { describe, test, expect } from 'bun:test';
import {
  TransactionContext,
  ReadAfterWriteError,
  type TransactionReader,
} from 'pyric/sandbox/internal';
import { READ_AFTER_WRITE_MESSAGE } from 'pyric/sandbox/internal';

function readerFor(store: Record<string, Record<string, unknown>>): TransactionReader {
  return path => (path in store ? store[path]! : null);
}

describe('TransactionContext — reads', () => {
  test('get(missing) returns { exists: false, data() === undefined }', () => {
    const tx = new TransactionContext(readerFor({}));
    const snap = tx.get('users/missing');
    expect(snap.exists).toBe(false);
    expect(snap.data()).toBeUndefined();
    expect(snap.path).toBe('users/missing');
  });

  test('get(existing) returns { exists: true, data() === stored }', () => {
    const tx = new TransactionContext(readerFor({ 'users/u1': { name: 'A' } }));
    const snap = tx.get('users/u1');
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ name: 'A' });
  });

  test('captured read is immutable — mutation of source after read does not leak', () => {
    const store: Record<string, Record<string, unknown>> = { 'users/u1': { name: 'A' } };
    const tx = new TransactionContext(readerFor(store));
    const snap = tx.get('users/u1');
    // Mutate the source after the snapshot was taken.
    store['users/u1']!.name = 'MUTATED';
    expect(snap.data()).toEqual({ name: 'A' });
  });

  test('getAll preserves input order', () => {
    const tx = new TransactionContext(
      readerFor({
        'a/1': { id: 'a' },
        'b/2': { id: 'b' },
        'c/3': { id: 'c' },
      }),
    );
    const snaps = tx.getAll('c/3', 'a/1', 'b/2');
    expect(snaps.map(s => s.data())).toEqual([{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
  });

  test('getAll with mixed missing + existing returns matching exists flags', () => {
    const tx = new TransactionContext(readerFor({ 'a/1': { id: 'a' } }));
    const snaps = tx.getAll('a/1', 'a/missing');
    expect(snaps[0]!.exists).toBe(true);
    expect(snaps[1]!.exists).toBe(false);
    expect(snaps[1]!.data()).toBeUndefined();
  });
});

describe('TransactionContext — writes queue + writeStarted', () => {
  test('set/create/update/delete all flip writeStarted', () => {
    for (const op of ['set', 'create', 'update', 'delete'] as const) {
      const tx = new TransactionContext(readerFor({}));
      expect(tx.hadWrites()).toBe(false);
      if (op === 'delete') tx[op]('p/1');
      else tx[op]('p/1', { x: 1 });
      expect(tx.hadWrites()).toBe(true);
    }
  });

  test('queued writes appear in consume() in call order, un-merged', () => {
    const tx = new TransactionContext(readerFor({}));
    tx.update('p/1', { x: 1 });
    tx.update('p/1', { y: 2 });
    tx.set('p/2', { z: 3 });
    const { writes } = tx.consume();
    expect(writes).toEqual([
      { method: 'update', path: 'p/1', data: { x: 1 } },
      { method: 'update', path: 'p/1', data: { y: 2 } },
      { method: 'set', path: 'p/2', data: { z: 3 } },
    ]);
  });

  test('consume() also surfaces every captured read', () => {
    const tx = new TransactionContext(readerFor({ 'a/1': { id: 'a' } }));
    tx.get('a/1');
    tx.get('a/missing');
    const { reads } = tx.consume();
    expect(reads).toEqual([
      { path: 'a/1', data: { id: 'a' } },
      { path: 'a/missing', data: null },
    ]);
  });
});

describe('TransactionContext — read-before-write enforcement (0.A + 0.J)', () => {
  test('get after set throws ReadAfterWriteError synchronously', () => {
    const tx = new TransactionContext(readerFor({}));
    tx.set('p/1', { x: 1 });
    expect(() => tx.get('p/1')).toThrow(ReadAfterWriteError);
  });

  test('error message matches Admin SDK wording exactly (probe 0.A lock)', () => {
    const tx = new TransactionContext(readerFor({}));
    tx.update('p/1', { x: 1 });
    try {
      tx.get('p/1');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toBe(READ_AFTER_WRITE_MESSAGE);
      expect(e).toBeInstanceOf(ReadAfterWriteError);
      expect((e as ReadAfterWriteError).simError.code).toBe('failed-precondition');
    }
  });

  test('cross-doc read after write also throws (global ordering — 0.J)', () => {
    const tx = new TransactionContext(readerFor({ 'b/1': { y: 2 } }));
    tx.set('a/1', { x: 1 });
    expect(() => tx.get('b/1')).toThrow(ReadAfterWriteError);
  });

  test('every write method (set/create/update/delete) trips the gate', () => {
    for (const op of ['set', 'create', 'update', 'delete'] as const) {
      const tx = new TransactionContext(readerFor({ 'p/1': {} }));
      if (op === 'delete') tx[op]('p/1');
      else tx[op]('p/1', { x: 1 });
      expect(() => tx.get('q/2')).toThrow(ReadAfterWriteError);
      expect(() => tx.getAll('q/2', 'r/3')).toThrow(ReadAfterWriteError);
    }
  });

  test('multiple reads BEFORE any write are all allowed', () => {
    const tx = new TransactionContext(
      readerFor({ 'a/1': { id: 'a' }, 'b/2': { id: 'b' } }),
    );
    expect(() => {
      tx.get('a/1');
      tx.getAll('b/2', 'c/3');
      tx.get('a/1');
    }).not.toThrow();
  });
});
