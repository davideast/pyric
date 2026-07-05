/**
 * Item 4.5 — Corpus integration tests for `firestore_simulator_transaction`.
 *
 * Re-exercises Item 5's three locked fixtures (counter, state-machine,
 * cross-doc) through the MCP tool surface. The same rules and the same
 * scenarios should produce the same allow/deny verdicts whether driven
 * by a direct `LocalEnvironment.transaction()` callback (Item 5) or by
 * the agent-facing tool (Item 4.4).
 *
 * Scenarios that do not map onto the declarative MCP shape are skipped
 * here and stay covered by Item 5 alone:
 *   - read-after-write throws (probe 0.J): the MCP tool collects reads
 *     up front, so the offending sequence cannot be expressed.
 *   - getAll input-order semantics: reads are an unordered alias map.
 *   - async vs sync overload: the MCP path is already async.
 */
import { describe, test, expect } from 'bun:test';
import {
  exec,
  setup,
  seedEnv,
  type SimulatorRegistry,
} from './_helpers.js';

async function readDoc(reg: SimulatorRegistry, path: string): Promise<any> {
  const r = await exec(reg.get('firestore_simulator_read'), { path });
  return r.data.document;
}

// ─── Counter fixture ─────────────────────────────────────────────────────

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

describe('mcp tool / counter corpus parity', () => {
  test('read-modify-write increment commits and is visible after', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: COUNTER_RULES,
      documents: { 'counters/c1': { count: 5 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'a' },
      includeReads: true,
      reads: { c: 'counters/c1' },
      writes: [{ method: 'update', path: 'counters/c1', data: { count: { $expr: '$c.count + 1' } } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    expect(r.data.reads).toEqual([{ path: 'counters/c1', data: { count: 5 } }]);
    expect(await readDoc(reg, 'counters/c1')).toEqual({ count: 6 });
  });

  test('rules reject decrement — tx rolled back, state unchanged', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: COUNTER_RULES,
      documents: { 'counters/c1': { count: 10 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'a' },
      reads: { c: 'counters/c1' },
      writes: [{ method: 'update', path: 'counters/c1', data: { count: { $expr: '$c.count - 1' } } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    expect(r.data.error.code).toBe('permission-denied');
    expect(await readDoc(reg, 'counters/c1')).toEqual({ count: 10 });
  });

  test('rules reject delta > 100 — anti-runaway clamp', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: COUNTER_RULES,
      documents: { 'counters/c1': { count: 0 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'a' },
      reads: { c: 'counters/c1' },
      writes: [{ method: 'update', path: 'counters/c1', data: { count: { $expr: '$c.count + 500' } } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    expect(await readDoc(reg, 'counters/c1')).toEqual({ count: 0 });
  });

  test('undo reverts the entire transaction in one event', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: COUNTER_RULES,
      documents: { 'counters/c1': { count: 1 } },
    });
    await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'a' },
      reads: { c: 'counters/c1' },
      writes: [{ method: 'update', path: 'counters/c1', data: { count: { $expr: '$c.count + 10' } } }],
    });
    expect(await readDoc(reg, 'counters/c1')).toEqual({ count: 11 });

    const undo = await exec(reg.get('firestore_simulator_undo'), {});
    expect(undo.success).toBe(true);
    expect(undo.data.undone).toBe(true);
    expect(await readDoc(reg, 'counters/c1')).toEqual({ count: 1 });

    // One transaction event, undone once → empty undoable stack
    const events = await exec(reg.get('firestore_simulator_events'), {});
    expect(events.data.events).toHaveLength(0);
  });
});

// ─── State-machine fixture ────────────────────────────────────────────────

const STATE_MACHINE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /jobs/{id} {
      allow read: if true;
      allow create: if request.resource.data.status == 'pending';
      allow update: if (
          (resource.data.status == 'pending' && request.resource.data.status == 'active')
          || (resource.data.status == 'active' && request.resource.data.status == 'done')
      );
      allow delete: if false;
    }
  }
}`;

describe('mcp tool / state-machine corpus parity', () => {
  test('pending → active commits', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: STATE_MACHINE_RULES,
      documents: { 'jobs/j1': { status: 'pending' } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'a' },
      reads: { j: 'jobs/j1' },
      writes: [{ method: 'update', path: 'jobs/j1', data: { status: 'active' } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    expect(await readDoc(reg, 'jobs/j1')).toEqual({ status: 'active' });
  });

  test('pending → done denied (must transit through active)', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: STATE_MACHINE_RULES,
      documents: { 'jobs/j1': { status: 'pending' } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'a' },
      reads: { j: 'jobs/j1' },
      writes: [{ method: 'update', path: 'jobs/j1', data: { status: 'done' } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    expect(r.data.error.code).toBe('permission-denied');
    expect(await readDoc(reg, 'jobs/j1')).toEqual({ status: 'pending' });
  });

  test('active → done commits', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: STATE_MACHINE_RULES,
      documents: { 'jobs/j1': { status: 'active' } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'a' },
      reads: { j: 'jobs/j1' },
      writes: [{ method: 'update', path: 'jobs/j1', data: { status: 'done' } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    expect(await readDoc(reg, 'jobs/j1')).toEqual({ status: 'done' });
  });

  test('done → anything denied (terminal)', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: STATE_MACHINE_RULES,
      documents: { 'jobs/j1': { status: 'done' } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'a' },
      reads: { j: 'jobs/j1' },
      writes: [{ method: 'update', path: 'jobs/j1', data: { status: 'active' } }],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    expect(await readDoc(reg, 'jobs/j1')).toEqual({ status: 'done' });
  });

  test('multi-write same-path tx: rules see pre-tx state (probe 0.E canary)', async () => {
    // Same-path multi-update merges (probe 0.D), so the merged op is
    // {status: 'done'} — and the rule sees pre-tx status 'pending' →
    // request 'done'. That transition is denied.
    const reg = setup();
    await seedEnv(reg, {
      rules: STATE_MACHINE_RULES,
      documents: { 'jobs/j1': { status: 'pending' } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'a' },
      reads: { j: 'jobs/j1' },
      writes: [
        { method: 'update', path: 'jobs/j1', data: { status: 'active' } },
        { method: 'update', path: 'jobs/j1', data: { status: 'done' } },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    expect(await readDoc(reg, 'jobs/j1')).toEqual({ status: 'pending' });
  });

  test('parallel jobs: two independent state machines in one tx', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: STATE_MACHINE_RULES,
      documents: {
        'jobs/j1': { status: 'pending' },
        'jobs/j2': { status: 'active' },
      },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'a' },
      reads: { j1: 'jobs/j1', j2: 'jobs/j2' },
      writes: [
        { method: 'update', path: 'jobs/j1', data: { status: 'active' } },
        { method: 'update', path: 'jobs/j2', data: { status: 'done' } },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    expect(await readDoc(reg, 'jobs/j1')).toEqual({ status: 'active' });
    expect(await readDoc(reg, 'jobs/j2')).toEqual({ status: 'done' });
  });

  test('one job invalid → both writes roll back (atomic)', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: STATE_MACHINE_RULES,
      documents: {
        'jobs/j1': { status: 'pending' },
        'jobs/j2': { status: 'done' },   // terminal — any update denied
      },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'a' },
      reads: { j1: 'jobs/j1', j2: 'jobs/j2' },
      writes: [
        { method: 'update', path: 'jobs/j1', data: { status: 'active' } },
        { method: 'update', path: 'jobs/j2', data: { status: 'active' } },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    // Atomic — j1 also rolled back even though its rule allowed
    expect(await readDoc(reg, 'jobs/j1')).toEqual({ status: 'pending' });
    expect(await readDoc(reg, 'jobs/j2')).toEqual({ status: 'done' });
  });
});

// ─── Cross-doc fixture ────────────────────────────────────────────────────

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

describe('mcp tool / cross-doc corpus parity', () => {
  test('read source, write ledger + decrement source — both apply atomically', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: TRANSFER_RULES,
      documents: { 'users/u1': { balance: 100 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'u1' },
      includeReads: true,
      reads: { src: 'users/u1' },
      writes: [
        { method: 'create', path: 'transfers/t1', data: { from: 'u1', amount: 30 } },
        { method: 'update', path: 'users/u1', data: { balance: { $expr: '$src.balance - 30' } } },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(true);
    expect(r.data.writes).toHaveLength(2);
    expect(r.data.reads).toEqual([{ path: 'users/u1', data: { balance: 100 } }]);
    expect(await readDoc(reg, 'users/u1')).toEqual({ balance: 70 });
    expect(await readDoc(reg, 'transfers/t1')).toEqual({ from: 'u1', amount: 30 });
  });

  test('source rule denial rolls back the transfer write too (atomicity)', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: TRANSFER_RULES,
      documents: { 'users/u1': { balance: 100 } },
    });
    const r = await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'u1' },
      reads: { src: 'users/u1' },
      writes: [
        { method: 'create', path: 'transfers/t1', data: { from: 'u1', amount: 10 } },
        // rule violation: balance must strictly DECREASE
        { method: 'update', path: 'users/u1', data: { balance: { $expr: '$src.balance + 50' } } },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data.allowed).toBe(false);
    expect(await readDoc(reg, 'users/u1')).toEqual({ balance: 100 });
    // The transfer write rolled back too — atomicity holds across docs
    expect(await readDoc(reg, 'transfers/t1')).toBeNull();
  });

  test('cross-doc undo reverts both writes', async () => {
    const reg = setup();
    await seedEnv(reg, {
      rules: TRANSFER_RULES,
      documents: { 'users/u1': { balance: 100 } },
    });
    await exec(reg.get('firestore_simulator_transaction'), {
      auth: { uid: 'u1' },
      reads: { src: 'users/u1' },
      writes: [
        { method: 'create', path: 'transfers/t1', data: { from: 'u1', amount: 5 } },
        { method: 'update', path: 'users/u1', data: { balance: { $expr: '$src.balance - 5' } } },
      ],
    });
    expect(await readDoc(reg, 'users/u1')).toEqual({ balance: 95 });
    expect(await readDoc(reg, 'transfers/t1')).toEqual({ from: 'u1', amount: 5 });

    const undo = await exec(reg.get('firestore_simulator_undo'), {});
    expect(undo.data.undone).toBe(true);

    expect(await readDoc(reg, 'users/u1')).toEqual({ balance: 100 });
    expect(await readDoc(reg, 'transfers/t1')).toBeNull();
  });
});
