/**
 * Item 5.1 — Counter fixture.
 *
 * The canonical transaction shape: read a counter, increment, write
 * back. This fixture exercises the full path:
 *
 *   seed → tx.get → compute → tx.update → commit → assert state
 *
 * Plus: per-tx rules eval against pre-tx state, undo of the entire
 * transaction, and read-set surfaced on the result for diagnostic value.
 *
 * The rules here intentionally constrain the increment shape:
 *   - count must rise monotonically (request.resource.data.count >
 *     resource.data.count).
 *   - delta cannot exceed 100 per tx (anti-runaway clamp).
 *
 * Either constraint catches a bad transaction at commit time, which
 * is exactly what `LocalEnvironment.transaction()`'s per-write rules
 * eval is supposed to enforce.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';

const COUNTER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /counters/{id} {
      allow read: if true;
      allow create: if request.resource.data.count == 0;
      allow update: if request.resource.data.count > resource.data.count
          && request.resource.data.count - resource.data.count <= 100;
    }
  }
}`;

describe('transactions / counter fixture', () => {
  test('read-modify-write increment commits and is visible after', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: COUNTER_RULES,
      documents: { 'counters/c1': { count: 5 } },
    });

    const result = env.transaction((tx) => {
      const snap = tx.get('counters/c1');
      const current = (snap.data() as { count: number }).count;
      tx.update('counters/c1', { count: current + 1 });
      return current + 1;
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(true);
    expect(result.returnValue).toBe(6);
    expect(result.reads).toEqual([{ path: 'counters/c1', data: { count: 5 } }]);
    expect(env.getDocument('counters/c1')).toEqual({ count: 6 });
  });

  test('rules reject decrement — tx rolled back, state unchanged', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: COUNTER_RULES,
      documents: { 'counters/c1': { count: 10 } },
    });

    const result = env.transaction((tx) => {
      const cur = (tx.get('counters/c1').data() as { count: number }).count;
      tx.update('counters/c1', { count: cur - 1 });    // monotonic violation
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('permission-denied');
    expect(env.getDocument('counters/c1')).toEqual({ count: 10 });
  });

  test('rules reject delta > 100 — anti-runaway clamp', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: COUNTER_RULES,
      documents: { 'counters/c1': { count: 0 } },
    });

    const result = env.transaction((tx) => {
      const cur = (tx.get('counters/c1').data() as { count: number }).count;
      tx.update('counters/c1', { count: cur + 500 });
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(false);
    expect(env.getDocument('counters/c1')).toEqual({ count: 0 });
  });

  test('undo reverts the entire transaction in one event', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: COUNTER_RULES,
      documents: { 'counters/c1': { count: 1 } },
    });

    env.transaction((tx) => {
      const cur = (tx.get('counters/c1').data() as { count: number }).count;
      tx.update('counters/c1', { count: cur + 10 });
    }, { auth: { uid: 'a' } });

    expect(env.getDocument('counters/c1')).toEqual({ count: 11 });
    env.undo();
    expect(env.getDocument('counters/c1')).toEqual({ count: 1 });

    // One transaction event in the log, undone once → empty undoable stack
    const events = env.getEvents();
    expect(events).toHaveLength(0);
  });

  test('async callback path also commits cleanly', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: COUNTER_RULES,
      documents: { 'counters/c1': { count: 0 } },
    });

    // Real-world transactions are usually async (the callback awaits a
    // computation between read and write). Smoke the same fixture
    // through the async overload.
    const result = await env.transaction(async (tx) => {
      const cur = (tx.get('counters/c1').data() as { count: number }).count;
      const inc = await Promise.resolve(7);
      tx.update('counters/c1', { count: cur + inc });
      return cur + inc;
    }, { auth: { uid: 'a' } });

    expect(result.allowed).toBe(true);
    expect(result.returnValue).toBe(7);
    expect(env.getDocument('counters/c1')).toEqual({ count: 7 });
  });
});
