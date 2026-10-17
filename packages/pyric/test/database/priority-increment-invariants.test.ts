import { describe, expect, test } from 'bun:test';
import {
  get,
  getAdminDatabase,
  getDatabase,
  increment,
  ref,
  remove,
  runTransaction,
  set,
  setPriority,
  setWithPriority,
  update,
} from 'pyric/database';
import {
  compileRtdbRules,
  simulateRtdbRules,
} from '../../src/rules/rtdb/compiled-rules.js';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/database';

describe('RTDB priority and increment invariants (#1014)', () => {
  test('ENF-3c: removing last child under prioritized parent auto-trims parent and clears its priority', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, { rules: { '.read': true, '.write': true } });
    const db = getDatabase(sandbox);
    await set(ref(db, 'parent'), { only: 'v' });
    await setPriority(ref(db, 'parent'), 9);
    expect((await get(ref(db, 'parent'))).priority).toBe(9);

    await remove(ref(db, 'parent/only'));
    const afterRemove = await get(ref(db, 'parent'));
    expect(afterRemove.exists()).toBe(false);
    expect(afterRemove.priority).toBeNull();

    // Next write under /parent must not inherit stale priority 9
    await set(ref(db, 'parent/next'), 'fresh');
    const afterReappear = await get(ref(db, 'parent'));
    expect(afterReappear.val()).toEqual({ next: 'fresh' });
    expect(afterReappear.priority).toBeNull();
  });

  test('ENF-3c: update() and runTransaction() removing last child also clear trimmed ancestor priority', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, { rules: { '.read': true, '.write': true } });
    const db = getDatabase(sandbox);

    await setWithPriority(ref(db, 'viaUpdate'), { only: 'v' }, 'p-update');
    await update(ref(db, 'viaUpdate'), { only: null });
    expect((await get(ref(db, 'viaUpdate'))).priority).toBeNull();

    await setWithPriority(ref(db, 'viaTx'), { only: 'v' }, 'p-tx');
    await runTransaction(ref(db, 'viaTx/only'), () => null);
    expect((await get(ref(db, 'viaTx'))).priority).toBeNull();
  });

  test('ENF-3a: child write under prioritized primitive leaf in simulate() promotes parent and clears .value', () => {
    const compiled = compileRtdbRules({
      rules: {
        leaf: {
          nested: {
            '.write': "newData.parent().val() !== 42 && newData.parent().child('nested').val() === 'broken'",
          },
        },
      },
    });
    const res = simulateRtdbRules(compiled, {
      operation: 'write',
      path: '/leaf/nested',
      auth: { uid: 'u1', token: {} },
      mockData: { leaf: { '.value': 42, '.priority': 9 } },
      newData: 'broken',
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.allowed).toBe(true);
    }
  });

  test('MET-4a: runTransaction preserves existing node priority on newData during rules evaluation', async () => {
    const sandbox = initializeSandbox();
    const adminDb = getAdminDatabase(sandbox);
    const db = getDatabase(sandbox.withAuth({ uid: 'u1' }));

    await setWithPriority(ref(adminDb, 'counter'), 1, 5);
    setRules(sandbox, {
      rules: {
        counter: {
          '.read': true,
          '.write': 'newData.getPriority() === 5 && newData.val() === 2',
        },
      },
    });

    const outcome = await runTransaction(ref(db, 'counter'), (cur) => ((cur as number | null) ?? 0) + 1);
    expect(outcome.committed).toBe(true);
    const snap = await get(ref(db, 'counter'));
    expect(snap.val()).toBe(2);
    expect(snap.priority).toBe(5);
  });

  test('ENF-3b (U1 & U2): direct-key update clears child priority while deeper path update preserves it in rules and PriorityState', async () => {
    const sandbox = initializeSandbox();
    const adminDb = getAdminDatabase(sandbox);
    const db = getDatabase(sandbox.withAuth({ uid: 'u1' }));

    // U1: direct-key overwrite clears that child's priority; untouched sibling keeps its priority
    await set(ref(adminDb, 'parent'), {
      child: { '.value': 'v1', '.priority': 7 },
      sib: { '.value': 's', '.priority': 4 },
    });
    // U2: deeper multi-path write under child preserves child's priority
    await set(ref(adminDb, 'parent2'), {
      child: { '.priority': 7, x: 1 },
    });

    setRules(sandbox, {
      rules: {
        parent: {
          '.read': true,
          child: {
            '.write': "newData.getPriority() === null && newData.parent().child('sib').getPriority() === 4 && newData.val() === 'v2'",
          },
        },
        parent2: {
          '.read': true,
          child: {
            x: {
              '.write': 'newData.parent().getPriority() === 7 && newData.val() === 2',
            },
          },
        },
      },
    });

    await update(ref(db, 'parent'), { child: 'v2' });
    const childSnap = await get(ref(db, 'parent/child'));
    const sibSnap = await get(ref(db, 'parent/sib'));
    expect(childSnap.val()).toBe('v2');
    expect(childSnap.priority).toBeNull();
    expect(sibSnap.val()).toBe('s');
    expect(sibSnap.priority).toBe(4);

    await update(ref(db, 'parent2'), { 'child/x': 2 });
    const parent2ChildSnap = await get(ref(db, 'parent2/child'));
    expect(parent2ChildSnap.val()).toEqual({ x: 2 });
    expect(parent2ChildSnap.priority).toBe(7);
  });

  test('ENF-3d: increment() on a prioritized node in simulate() unwraps .value and adds delta', () => {
    const compiled = compileRtdbRules({
      rules: {
        n: {
          '.write': 'newData.val() === 14',
        },
      },
    });
    const res = simulateRtdbRules(compiled, {
      operation: 'write',
      path: '/n',
      auth: { uid: 'u1', token: {} },
      mockData: { n: { '.value': 10, '.priority': 3 } },
      newData: increment(4),
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.allowed).toBe(true);
    }
  });

  test('ENF-3e: increment() inside a {.value, .priority} wrapper resolves against current node value (10 + 4 = 14) in sandbox and simulate()', async () => {
    const compiled = compileRtdbRules({
      rules: {
        n: {
          '.write': 'newData.val() === 14 && newData.getPriority() === 3',
        },
      },
    });
    const res = simulateRtdbRules(compiled, {
      operation: 'write',
      path: '/n',
      auth: { uid: 'u1', token: {} },
      mockData: { n: { '.value': 10, '.priority': 3 } },
      newData: { '.value': increment(4), '.priority': 3 },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.allowed).toBe(true);
    }

    const sandbox = initializeSandbox();
    const adminDb = getAdminDatabase(sandbox);
    const db = getDatabase(sandbox.withAuth({ uid: 'u1' }));
    await setWithPriority(ref(adminDb, 'n'), 10, 3);
    setRules(sandbox, {
      rules: {
        n: {
          '.read': true,
          '.write': 'newData.val() === 14 && newData.getPriority() === 3',
        },
      },
    });

    await set(ref(db, 'n'), { '.value': increment(4), '.priority': 3 });
    const snap = await get(ref(db, 'n'));
    expect(snap.val()).toBe(14);
    expect(snap.priority).toBe(3);
  });
});
