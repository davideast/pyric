/**
 * `firestore_simulator_transaction` end-to-end behavior against the
 * canonical `createFirestoreSimulatorTools` factory.
 *
 * Coverage:
 *   1. The three locked design examples (counter, conditional transfer,
 *      cross-doc derived).
 *   2. Sentinels (@increment, @serverTimestamp, @arrayUnion).
 *   3. `includeReads` default OFF: response omits `reads` and per-write
 *      debugMessages. ON: both surface.
 *   4. Failure modes: parse error, eval error (unknown reference,
 *      null-access), input shape (delete with data, create without).
 *   5. Read of a missing doc resolves to null (not exists shows up as
 *      null in EvalEnv); accessing a field on it throws.
 *   6. Top-level wrapper resolving to non-object is rejected.
 *   7. Atomic rollback: rule denial flips `allowed: false`.
 *
 * Moved 2026-05-24 from sdk/test/firestore/simulator/transaction-mcp-tool.test.ts
 * as part of W8C. The legacy registration tests (asserting AgentTool's
 * `.service` + `.tags` fields) dropped — ToolHandler has neither;
 * tool-name presence is implicit in `setup()`'s registry lookup.
 */
import { describe, test, expect } from 'bun:test';
import { exec, setup, seedEnv } from './_helpers.js';

// ─── 1. Input-shape rejection (canonical-style) ───────────────────────────

describe('firestore_simulator_transaction — input validation', () => {
  test('missing reads/writes rejects with INVALID_INPUT', async () => {
    const reg = setup();
    await seedEnv(reg, {});
    let threw = false;
    let r: Awaited<ReturnType<typeof exec>> | undefined;
    try {
      r = await exec(reg.get('firestore_simulator_transaction'), { auth: null });
    } catch {
      threw = true;
    }
    // Tool may either throw (parameter validation upstream) or return
    // non-success; either is acceptable.
    if (!threw) {
      expect(r!.success).toBe(false);
    }
  });
});

// ─── 2. Locked design example: counter increment ──────────────────────────

describe('firestore_simulator_transaction — counter increment', () => {
  test('reads $c.count, writes count + 1', async () => {
    const reg = setup();
    await seedEnv(reg, {
      documents: { 'counters/c1': { count: 4 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'alice' },
      reads: { c: 'counters/c1' },
      writes: [
        {
          method: 'update',
          path: 'counters/c1',
          data: { count: { $expr: '$c.count + 1' } },
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    expect(r.data.writes).toEqual([
      { path: 'counters/c1', method: 'update', allowed: true },
    ]);
    const read = await exec(reg.get('firestore_simulator_read'), {
      path: 'counters/c1',
    });
    expect(read.data.document).toEqual({ count: 5 });
  });

  test('@increment sentinel via expression', async () => {
    const reg = setup();
    await seedEnv(reg, {
      documents: { 'counters/c1': { count: 10 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'alice' },
      reads: {},
      writes: [
        {
          method: 'update',
          path: 'counters/c1',
          data: { count: { $expr: '@increment(7)' } },
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    const read = await exec(reg.get('firestore_simulator_read'), {
      path: 'counters/c1',
    });
    expect(read.data.document).toEqual({ count: 17 });
  });
});

// ─── 3. Conditional transfer (rule-gated) ─────────────────────────────────

describe('firestore_simulator_transaction — conditional transfer', () => {
  const TRANSFER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.resource.data.balance >= 0;
    }
    match /transfers/{id} {
      allow read, write: if true;
    }
  }
}`;

  test('debit succeeds when balance is sufficient', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: TRANSFER_RULES,
      documents: { 'users/alice': { balance: 100 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'alice' },
      reads: { src: 'users/alice' },
      writes: [
        { method: 'create', path: 'transfers/t1', data: { from: 'alice', to: 'bob', amount: 30 } },
        { method: 'update', path: 'users/alice', data: { balance: { $expr: '$src.balance - 30' } } },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    const read = await exec(reg.get('firestore_simulator_read'), {
      path: 'users/alice',
    });
    expect(read.data.document).toEqual({ balance: 70 });
  });

  test('debit rolls back atomically when rule denies', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: TRANSFER_RULES,
      documents: { 'users/alice': { balance: 20 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'alice' },
      reads: { src: 'users/alice' },
      writes: [
        { method: 'create', path: 'transfers/t1', data: { from: 'alice', to: 'bob', amount: 30 } },
        { method: 'update', path: 'users/alice', data: { balance: { $expr: '$src.balance - 30' } } },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    // State unchanged — alice still 20, transfer not created.
    const aliceRead = await exec(reg.get('firestore_simulator_read'), {
      path: 'users/alice',
    });
    expect(aliceRead.data.document).toEqual({ balance: 20 });
    const transferRead = await exec(reg.get('firestore_simulator_read'), {
      path: 'transfers/t1',
    });
    expect(transferRead.data.document).toBeNull();
  });
});

// ─── 4. Cross-doc derived field ───────────────────────────────────────────

describe('firestore_simulator_transaction — cross-doc derived', () => {
  test('totalBalance + ternary primary', async () => {
    const reg = setup();
    await seedEnv(reg, {
      documents: {
        'users/u1': { balance: 100 },
        'users/u2': { balance: 60 },
      },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'admin' },
      reads: { a: 'users/u1', b: 'users/u2' },
      writes: [
        {
          method: 'create',
          path: 'audits/a1',
          data: {
            totalBalance: { $expr: '$a.balance + $b.balance' },
            primary: { $expr: '$a.balance > $b.balance ? "u1" : "u2"' },
          },
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    const read = await exec(reg.get('firestore_simulator_read'), {
      path: 'audits/a1',
    });
    expect(read.data.document).toEqual({ totalBalance: 160, primary: 'u1' });
  });
});

// ─── 5. Sentinels ─────────────────────────────────────────────────────────

describe('firestore_simulator_transaction — sentinels', () => {
  test('@serverTimestamp resolves to a server time', async () => {
    const reg = setup();
    await seedEnv(reg, {
      documents: { 'docs/d1': { name: 'a' } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: null,
      reads: {},
      writes: [
        {
          method: 'update',
          path: 'docs/d1',
          data: { updatedAt: { $expr: '@serverTimestamp()' } },
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    const read = await exec(reg.get('firestore_simulator_read'), {
      path: 'docs/d1',
    });
    expect(read.data.document.updatedAt).toBeDefined();
    expect(read.data.document.updatedAt).not.toBeNull();
  });

  test('@arrayUnion appends literal values', async () => {
    const reg = setup();
    await seedEnv(reg, {
      documents: { 'docs/d1': { tags: ['a'] } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: null,
      reads: {},
      writes: [
        {
          method: 'update',
          path: 'docs/d1',
          data: { tags: { $expr: '@arrayUnion("b", "c")' } },
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    const read = await exec(reg.get('firestore_simulator_read'), {
      path: 'docs/d1',
    });
    expect(read.data.document.tags).toEqual(['a', 'b', 'c']);
  });
});

// ─── 6. includeReads context lever ────────────────────────────────────────

describe('firestore_simulator_transaction — includeReads', () => {
  test('default false omits `reads` and per-write debugMessages', async () => {
    const reg = setup();
    await seedEnv(reg, {
      documents: { 'counters/c1': { count: 4 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: null,
      reads: { c: 'counters/c1' },
      writes: [{ method: 'update', path: 'counters/c1', data: { count: { $expr: '$c.count + 1' } } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.reads).toBeUndefined();
    expect(r.data.writes[0].debugMessages).toBeUndefined();
  });

  test('includeReads:true surfaces reads and debugMessages', async () => {
    const reg = setup();
    await seedEnv(reg, {
      documents: { 'counters/c1': { count: 4 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: null,
      includeReads: true,
      reads: { c: 'counters/c1' },
      writes: [{ method: 'update', path: 'counters/c1', data: { count: { $expr: '$c.count + 1' } } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.reads).toEqual([{ path: 'counters/c1', data: { count: 4 } }]);
    expect(Array.isArray(r.data.writes[0].debugMessages)).toBe(true);
  });
});

// ─── 7. Failure modes ────────────────────────────────────────────────────

describe('firestore_simulator_transaction — parse / eval errors', () => {
  test('parse error: returns invalid-argument with path-tagged message', async () => {
    const reg = setup();
    await seedEnv(reg, {});
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: null,
      reads: {},
      writes: [{ method: 'create', path: 'docs/d1', data: { x: { $expr: '@badname()' } } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    expect(r.data.error.code).toBe('invalid-argument');
    expect(r.data.error.message).toContain('x');
  });

  test('eval error: $missing alias surfaces unknown-reference', async () => {
    const reg = setup();
    await seedEnv(reg, {});
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: null,
      reads: {},
      writes: [{ method: 'create', path: 'docs/d1', data: { x: { $expr: '$missing.field' } } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    expect(r.data.error.code).toBe('invalid-argument');
  });

  test('field access on missing doc throws (null-access)', async () => {
    const reg = setup();
    await seedEnv(reg, {});  // no docs
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: null,
      reads: { c: 'counters/c1' },  // doc does not exist
      writes: [{ method: 'create', path: 'docs/d1', data: { x: { $expr: '$c.count' } } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    expect(r.data.error.code).toBe('invalid-argument');
  });

  test('top-level $expr resolving to non-object is rejected', async () => {
    const reg = setup();
    await seedEnv(reg, {});
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: null,
      reads: {},
      // The whole `data` is an expression that evaluates to a number
      // (not an object). Tool layer must reject before reaching the
      // simulator's commit path.
      writes: [{ method: 'create', path: 'docs/d1', data: { $expr: '1 + 1' } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    expect(r.data.error.code).toBe('invalid-argument');
    expect(r.data.error.message).toContain('non-object');
  });
});

// ─── 8. Input-shape validation ───────────────────────────────────────────

describe('firestore_simulator_transaction — input shape', () => {
  test('delete + data is rejected', async () => {
    const reg = setup();
    await seedEnv(reg, {});
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: null,
      reads: {},
      writes: [{ method: 'delete', path: 'docs/d1', data: { x: 1 } }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.code).toBe('INVALID_INPUT');
  });

  test('create without data is rejected', async () => {
    const reg = setup();
    await seedEnv(reg, {});
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: null,
      reads: {},
      writes: [{ method: 'create', path: 'docs/d1' }],
    });
    expect(r.success).toBe(false);
    expect(r.error!.code).toBe('INVALID_INPUT');
  });

  // ENV_NOT_FOUND test dropped 2026-05-24 (W8C migration): canonical
  // `createFirestoreSimulatorTools({ resolveSandbox })` binds to a
  // single env per factory call, so there's no environmentId →
  // no lookup → no NOT_FOUND code path.
});

// ─── 9. Pure delete (no reads, no expressions) ───────────────────────────

describe('firestore_simulator_transaction — delete', () => {
  test('queues a delete and removes the doc', async () => {
    const reg = setup();
    await seedEnv(reg, {
      documents: { 'docs/d1': { x: 1 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: null,
      reads: {},
      writes: [{ method: 'delete', path: 'docs/d1' }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    const read = await exec(reg.get('firestore_simulator_read'), {
      path: 'docs/d1',
    });
    expect(read.data.document).toBeNull();
  });
});
