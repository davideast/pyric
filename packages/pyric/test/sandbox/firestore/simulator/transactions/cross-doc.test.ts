/**
 * Item 5.3 — Cross-doc read/write fixture.
 *
 * Read doc A, write doc B with a field derived from A. Verifies:
 *   - Cross-doc transactional read followed by transactional write
 *     applies atomically.
 *   - Global read-before-write ordering (probe 0.J): a write to A,
 *     then a read of B, throws and aborts the tx.
 *   - All-or-nothing atomicity: rule denial on B's write rolls back
 *     A's write too.
 *
 * Realistic shape: a `users/{uid}` doc holds a balance, and a transfer
 * tx reads the source balance, writes a derived ledger entry under
 * `transfers/{id}`, and decrements the source.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { ReadAfterWriteError } from 'pyric/sandbox/internal';

const TRANSFER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if true;
      allow create: if request.resource.data.balance >= 0;
      allow update: if request.resource.data.balance >= 0
          && request.resource.data.balance < resource.data.balance;
    }
    match /transfers/{id} {
      allow read: if true;
      allow create: if request.resource.data.amount > 0
          && request.resource.data.from is string;
      allow update, delete: if false;
    }
  }
}`;

describe('transactions / cross-doc fixture', () => {
  test('read source, write ledger + decrement source — both apply atomically', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: TRANSFER_RULES,
      documents: { 'users/u1': { balance: 100 } },
    });

    const result = env.transaction((tx) => {
      const src = (tx.get('users/u1').data() as { balance: number }).balance;
      const amount = 30;
      if (src < amount) return;
      tx.create('transfers/t1', { from: 'u1', amount });
      tx.update('users/u1', { balance: src - amount });
    }, { auth: { uid: 'u1' } });

    expect(result.allowed).toBe(true);
    expect(env.getDocument('users/u1')).toEqual({ balance: 70 });
    expect(env.getDocument('transfers/t1')).toEqual({ from: 'u1', amount: 30 });
    // Two writes, two entries (different paths — no merge)
    expect(result.writes).toHaveLength(2);
    expect(result.reads).toEqual([{ path: 'users/u1', data: { balance: 100 } }]);
  });

  test('source rule denial rolls back the transfer write too (atomicity)', () => {
    // Force a denial by trying to set balance ABOVE the source's
    // current value (rule requires strict decrease).
    const env = new LocalEnvironment();
    env.seed({
      rules: TRANSFER_RULES,
      documents: { 'users/u1': { balance: 100 } },
    });

    const result = env.transaction((tx) => {
      const src = (tx.get('users/u1').data() as { balance: number }).balance;
      tx.create('transfers/t1', { from: 'u1', amount: 10 });
      tx.update('users/u1', { balance: src + 50 });   // rule violation
    }, { auth: { uid: 'u1' } });

    expect(result.allowed).toBe(false);
    expect(env.getDocument('users/u1')).toEqual({ balance: 100 });
    // The transfer write rolled back too — atomicity holds across docs
    expect(env.getDocument('transfers/t1')).toBeNull();
  });

  test('global read-before-write: write A then read B aborts (probe 0.J)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: TRANSFER_RULES,
      documents: {
        'users/u1': { balance: 100 },
        'users/u2': { balance: 50 },
      },
    });

    expect(() => env.transaction((tx) => {
      tx.update('users/u1', { balance: 90 });
      // Cross-doc read after a same-tx write — same throw as same-doc.
      tx.get('users/u2');
    }, { auth: { uid: 'u1' } })).toThrow(ReadAfterWriteError);

    // Aborted — neither user changed
    expect(env.getDocument('users/u1')).toEqual({ balance: 100 });
    expect(env.getDocument('users/u2')).toEqual({ balance: 50 });
  });

  test('getAll across two paths preserves input order, then a single write', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: TRANSFER_RULES,
      documents: {
        'users/u1': { balance: 100 },
        'users/u2': { balance: 200 },
      },
    });

    const result = env.transaction((tx) => {
      const [a, b] = tx.getAll('users/u2', 'users/u1');
      const totalBefore =
        (a.data() as { balance: number }).balance +
        (b.data() as { balance: number }).balance;
      tx.create('transfers/t1', { from: 'u1', amount: 1, total: totalBefore });
      return totalBefore;
    }, { auth: { uid: 'u1' } });

    expect(result.allowed).toBe(true);
    expect(result.returnValue).toBe(300);
    // Ordering check: reads recorded in input order
    expect(result.reads.map((r) => r.path)).toEqual(['users/u2', 'users/u1']);
  });

  test('cross-doc undo reverts both writes', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: TRANSFER_RULES,
      documents: { 'users/u1': { balance: 100 } },
    });

    env.transaction((tx) => {
      const src = (tx.get('users/u1').data() as { balance: number }).balance;
      tx.create('transfers/t1', { from: 'u1', amount: 5 });
      tx.update('users/u1', { balance: src - 5 });
    }, { auth: { uid: 'u1' } });

    expect(env.getDocument('users/u1')).toEqual({ balance: 95 });
    expect(env.getDocument('transfers/t1')).toEqual({ from: 'u1', amount: 5 });

    env.undo();

    expect(env.getDocument('users/u1')).toEqual({ balance: 100 });
    expect(env.getDocument('transfers/t1')).toBeNull();
  });
});
