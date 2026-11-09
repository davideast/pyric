import { describe, expect, test } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  endAt,
  equalTo,
  get,
  getAdminDatabase,
  getDatabase,
  goOffline,
  limitToFirst,
  onDisconnect,
  orderByChild,
  orderByKey,
  orderByValue,
  query,
  ref,
  runTransaction,
  sandbox,
  increment,
  serverTimestamp,
  set,
  setPriority,
  setWithPriority,
  startAt,
  update,
  type QueryConstraint,
} from 'pyric/database';
import { rtdbRules, type RtdbCaseQuery } from 'pyric/rules';

// A request that no `.read` or `.write` rule grants is denied, whether or not
// the deepest rules node on its path carries a rule of that kind. The sandbox
// and `simulate` answer each request the same way.
const rules = {
  rules: {
    '.read': false,
    '.write': false,
    rooms: {
      $id: {
        '.read': 'auth != null',
        '.write': "auth != null && newData.child('n').val() < 10",
        n: { '.validate': 'newData.isNumber()' },
      },
    },
    reports: { $id: { '.read': 'auth != null' } },
  },
};

type Db = ReturnType<typeof getDatabase>;
const cases: { label: string; operation: 'read' | 'write'; path: string; newData?: unknown; expected: 'ALLOW' | 'DENY'; run: (db: Db) => Promise<unknown> }[] = [
  { label: 'write under a node with only .validate, ancestor .write false', operation: 'write', path: '/rooms/r1/n', newData: 50, expected: 'DENY', run: (db) => set(ref(db, 'rooms/r1/n'), 50) },
  { label: 'write under a node with only .validate, ancestor .write true', operation: 'write', path: '/rooms/r1/n', newData: 5, expected: 'ALLOW', run: (db) => set(ref(db, 'rooms/r1/n'), 5) },
  { label: 'write under a node with only .read', operation: 'write', path: '/reports/x', newData: 1, expected: 'DENY', run: (db) => set(ref(db, 'reports/x'), 1) },
  { label: 'write outside every rules node', operation: 'write', path: '/elsewhere', newData: 1, expected: 'DENY', run: (db) => set(ref(db, 'elsewhere'), 1) },
  { label: 'read of a node with only children', operation: 'read', path: '/rooms', expected: 'DENY', run: (db) => get(ref(db, 'rooms')) },
  { label: 'read granted below a node with only children', operation: 'read', path: '/rooms/r1', expected: 'ALLOW', run: (db) => get(ref(db, 'rooms/r1')) },
];

describe('RTDB simulate agrees with the sandbox when no rule grants', () => {
  for (const c of cases) {
    test(c.label, async () => {
      const box = initializeSandbox();
      sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), rules);
      let verdict: 'ALLOW' | 'DENY' = 'ALLOW';
      try {
        await c.run(getDatabase(box.withAuth({ uid: 'alice' })));
      } catch {
        verdict = 'DENY';
      }
      const [result] = rtdbRules(rules).simulate([
        { expectation: c.expected, operation: c.operation, path: c.path, auth: { uid: 'alice' }, ...(c.newData === undefined ? {} : { newData: c.newData }) },
      ]).cases;
      expect(verdict).toBe(c.expected);
      expect(result.decision).toBe(verdict);
      expect(result.unsupported).toBe(false);
    });
  }
});

// Production verdicts from a deploy-observe-restore capture: `==` and `!=`
// compare operands of different types without converting either, so a
// `.validate` that expects one type denies a value of another type.
const equalityCases: Array<[validate: string, value: unknown, expected: 'ALLOW' | 'DENY']> = [
  ["newData.val() == '5'", 5, 'DENY'],
  ["newData.val() == '5'", '5', 'ALLOW'],
  ["newData.val() != '5'", 5, 'ALLOW'],
  ["newData.val() != '5'", '5', 'DENY'],
  ['newData.val() == true', 1, 'DENY'],
  ['newData.val() == true', true, 'ALLOW'],
  ['newData.val() != true', 1, 'ALLOW'],
  ['newData.val() != true', true, 'DENY'],
  ['newData.val() == 0', false, 'DENY'],
  ['newData.val() == 0', 0, 'ALLOW'],
  ["newData.val() == ''", false, 'DENY'],
  ["newData.val() == '1'", true, 'DENY'],
  ["newData.val() == '1'", '1', 'ALLOW'],
  ["newData.val() != '1'", true, 'ALLOW'],
  ['newData.val() == 1.0', 1, 'ALLOW'],
];

describe('RTDB simulate agrees with the sandbox on == and != across types', () => {
  for (const [validate, value, expected] of equalityCases) {
    test(`${validate} with ${JSON.stringify(value)}`, async () => {
      const equalityRules = { rules: { a: { '.write': 'auth != null', '.validate': validate } } };
      const box = initializeSandbox();
      sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), equalityRules);
      let verdict: 'ALLOW' | 'DENY' = 'ALLOW';
      try {
        await set(ref(getDatabase(box.withAuth({ uid: 'alice' })), 'a'), value);
      } catch {
        verdict = 'DENY';
      }
      const [result] = rtdbRules(equalityRules).simulate([
        { expectation: expected, operation: 'write', path: '/a', auth: { uid: 'alice' }, newData: value },
      ]).cases;
      expect(verdict).toBe(expected);
      expect(result.decision).toBe(verdict);
    });
  }
});

// Production verdicts from deploy-observe-restore captures: a rule that fails
// at evaluation, such as a string method called on a number, fails as that
// rule. A `.validate` or `.write` that errors denies the write, and an
// erroring ancestor `.write` leaves a descendant `.write` to grant.
const errorRules = {
  rules: {
    a: { '.write': 'auth != null', '.validate': "newData.val().toUpperCase() == 'A'" },
    w: { '.write': "newData.val().toUpperCase() == 'OK'", open: { '.write': 'auth != null' } },
  },
};
const errorCases: Array<[label: string, path: string, value: unknown, expected: 'ALLOW' | 'DENY']> = [
  ['.validate calling a string method on a number', '/a', 5, 'DENY'],
  ['.validate calling a string method on a string', '/a', 'a', 'ALLOW'],
  ['.write calling a string method on a number', '/w', 5, 'DENY'],
  ['erroring ancestor .write, descendant .write grants', '/w/open', 5, 'ALLOW'],
];

describe('RTDB simulate agrees with the sandbox on rules that error at evaluation', () => {
  for (const [label, path, value, expected] of errorCases) {
    test(label, async () => {
      const box = initializeSandbox();
      sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), errorRules);
      let verdict: 'ALLOW' | 'DENY' = 'ALLOW';
      try {
        await set(ref(getDatabase(box.withAuth({ uid: 'u' })), path.slice(1)), value);
      } catch {
        verdict = 'DENY';
      }
      const [result] = rtdbRules(errorRules).simulate([
        { expectation: expected, operation: 'write', path, auth: 'u', newData: value },
      ]).cases;
      expect(verdict).toBe(expected);
      expect(result.decision).toBe(verdict);
      expect(result.unsupported).toBe(false);
    });
  }
});

// Multi-path updates, query reads and scalar writes reach the engine through a
// case the same way the SDK sends them. The sandbox and `simulate` give each
// the same verdict.
const reachRules = {
  rules: {
    '.read': false,
    '.write': false,
    scores: { '.write': 'auth != null', '.validate': 'newData.isNumber()' },
    totals: {
      '.write': 'auth != null',
      '.validate': "newData.val() == newData.parent().child('scores').val() + 1",
    },
    flag: { '.write': 'auth != null', '.validate': 'newData.val() == true' },
    rooms: { $id: { title: { '.write': "auth != null && newData.val() != 'banned'" } } },
    items: {
      '.indexOn': ['owner'],
      '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid",
    },
    feed: { '.read': 'query.orderByKey == true && query.limitToFirst <= 10' },
    ranged: { '.indexOn': ['.value'], '.read': 'query.startAt == 5 && query.endAt == 9' },
  },
};

type Verdict = 'ALLOW' | 'DENY';

async function sandboxVerdict(
  as: string | null,
  run: (db: Db) => Promise<unknown>,
): Promise<Verdict> {
  const box = initializeSandbox();
  sandbox.setRules(getDatabase(box.withAuth({ uid: 'admin' })), reachRules);
  const db = getDatabase(as === null ? box : box.withAuth({ uid: as }));
  try {
    await run(db);
    return 'ALLOW';
  } catch (error) {
    // Only a rules denial is a verdict; any other failure is a broken case.
    const code = String((error as { code?: string }).code ?? error);
    if (!/permission[_-]denied/i.test(code)) throw error;
    return 'DENY';
  }
}

const updateCases: Array<[label: string, as: string | null, patch: Record<string, unknown>, expected: Verdict]> = [
  ['every written path passes', 'alice', { scores: 4, totals: 5 }, 'ALLOW'],
  ['a sibling path in the same update changes what .validate reads', 'alice', { scores: 4, totals: 9 }, 'DENY'],
  ['one written path fails .validate', 'alice', { scores: 'x', flag: true }, 'DENY'],
  ['a nested multi-path key', 'alice', { 'rooms/r1/title': 'hello', 'rooms/r2/title': 'hi' }, 'ALLOW'],
  ['a nested path whose rule denies', 'alice', { 'rooms/r1/title': 'hello', 'rooms/r2/title': 'banned' }, 'DENY'],
  ['an unauthenticated update', null, { scores: 1 }, 'DENY'],
];

describe('RTDB simulate agrees with the sandbox on multi-path updates', () => {
  for (const [label, as, patch, expected] of updateCases) {
    test(label, async () => {
      const verdict = await sandboxVerdict(as, (db) => update(ref(db), patch as never));
      const [result] = rtdbRules(reachRules).simulate([
        { expectation: expected, operation: 'update', path: '/', auth: as, newData: patch },
      ]).cases;
      expect(verdict).toBe(expected);
      expect(result.decision).toBe(verdict);
      expect(result.unsupported).toBe(false);
    });
  }
});

const queryCases: Array<{
  label: string;
  path: string;
  query: RtdbCaseQuery;
  constraints: QueryConstraint[];
  expected: Verdict;
}> = [
  { label: 'equalTo the caller on the owner child', path: '/items', query: { orderByChild: 'owner', equalTo: 'alice' }, constraints: [orderByChild('owner'), equalTo('alice')], expected: 'ALLOW' },
  { label: 'equalTo another user', path: '/items', query: { orderByChild: 'owner', equalTo: 'bob' }, constraints: [orderByChild('owner'), equalTo('bob')], expected: 'DENY' },
  { label: 'orderByKey within the limit', path: '/feed', query: { orderByKey: true, limitToFirst: 10 }, constraints: [orderByKey(), limitToFirst(10)], expected: 'ALLOW' },
  { label: 'orderByKey over the limit', path: '/feed', query: { orderByKey: true, limitToFirst: 11 }, constraints: [orderByKey(), limitToFirst(11)], expected: 'DENY' },
  { label: 'a range that matches', path: '/ranged', query: { orderByValue: true, startAt: 5, endAt: 9 }, constraints: [orderByValue(), startAt(5), endAt(9)], expected: 'ALLOW' },
  { label: 'a range that does not match', path: '/ranged', query: { orderByValue: true, startAt: 1, endAt: 9 }, constraints: [orderByValue(), startAt(1), endAt(9)], expected: 'DENY' },
];

describe('RTDB simulate agrees with the sandbox on query reads', () => {
  for (const c of queryCases) {
    test(c.label, async () => {
      const verdict = await sandboxVerdict('alice', (db) => get(query(ref(db, c.path.slice(1)), ...c.constraints)));
      const [result] = rtdbRules(reachRules).simulate([
        { expectation: c.expected, operation: 'read', path: c.path, auth: 'alice', query: c.query },
      ]).cases;
      expect(verdict).toBe(c.expected);
      expect(result.decision).toBe(verdict);
      expect(result.unsupported).toBe(false);
    });
  }

  test('the same read without a query is DENY in both', async () => {
    const verdict = await sandboxVerdict('alice', (db) => get(ref(db, 'items')));
    const [result] = rtdbRules(reachRules).simulate([
      { expectation: 'DENY', operation: 'read', path: '/items', auth: 'alice' },
    ]).cases;
    expect(verdict).toBe('DENY');
    expect(result.decision).toBe('DENY');
  });
});

const scalarCases: Array<[label: string, path: string, value: unknown, expected: Verdict]> = [
  ['a number where a number is required', '/scores', 5, 'ALLOW'],
  ['a string where a number is required', '/scores', 'five', 'DENY'],
  ['true where true is required', '/flag', true, 'ALLOW'],
  ['false where true is required', '/flag', false, 'DENY'],
];

describe('RTDB simulate agrees with the sandbox on scalar writes', () => {
  for (const [label, path, value, expected] of scalarCases) {
    test(label, async () => {
      const verdict = await sandboxVerdict('alice', (db) => set(ref(db, path.slice(1)), value as never));
      const [result] = rtdbRules(reachRules).simulate([
        { expectation: expected, operation: 'write', path, auth: 'alice', newData: value },
      ]).cases;
      expect(verdict).toBe(expected);
      expect(result.decision).toBe(verdict);
    });
  }
});

// The server resolves a written server value before any rule runs: a
// `serverTimestamp()` is `now`, and an `increment(n)` is the stored value plus
// n. simulate takes the same `{ ".sv": ... }` value a client writes.
const sentinelRules = {
  rules: {
    stamp: { '.write': 'auth != null', '.validate': 'newData.val() == now' },
    count: { '.write': 'auth != null', '.validate': 'data.exists() && newData.val() == data.val() + 1' },
    room: { '.write': 'auth != null', at: { '.validate': 'newData.val() == now' } },
  },
};

const sentinelCases: Array<[label: string, path: string, value: unknown, sent: unknown, expected: Verdict]> = [
  ['a server timestamp under newData.val() == now', '/stamp', { '.sv': 'timestamp' }, serverTimestamp(), 'ALLOW'],
  ['a client time under newData.val() == now', '/stamp', 1_000_000_000_000, 1_000_000_000_000, 'DENY'],
  ['a nested server timestamp', '/room', { at: { '.sv': 'timestamp' } }, { at: serverTimestamp() }, 'ALLOW'],
  ['an increment of 1 under a step of 1', '/count', { '.sv': { increment: 1 } }, increment(1), 'ALLOW'],
  ['an increment of 2 under a step of 1', '/count', { '.sv': { increment: 2 } }, increment(2), 'DENY'],
];

describe('RTDB simulate resolves server values as the sandbox does', () => {
  for (const [label, path, value, sent, expected] of sentinelCases) {
    test(label, async () => {
      const box = initializeSandbox();
      const admin = getDatabase(box.withAuth({ uid: 'admin' }));
      sandbox.setRules(admin, sentinelRules);
      sandbox.setData(admin, { '/count': 5 });
      let verdict: Verdict = 'ALLOW';
      try {
        await set(ref(getDatabase(box.withAuth({ uid: 'alice' })), path.slice(1)), sent as never);
      } catch {
        verdict = 'DENY';
      }
      const [result] = rtdbRules(sentinelRules).simulate([
        { expectation: expected, operation: 'write', path, auth: 'alice', data: { count: 5 }, newData: value },
      ]).cases;
      expect(verdict).toBe(expected);
      expect(result.decision).toBe(expected);
    });
  }
});

// Write-boundary normalization (`src/database/sandbox/normalize.ts`): arrays
// coerce to integer-keyed objects, empty arrays/objects prune to null, and a
// pruned node drops its `.priority`. `simulate()` normalizes write payloads
// the same way the sandbox does.
const normalizationRules = {
  rules: {
    arr: { '.write': "auth != null && newData.hasChildren() && newData.child('0').val() === 'a' && newData.child('1').val() === 'b'" },
    emptyArr: { '.write': 'auth != null && !newData.exists()' },
    emptyObjPrio: { '.write': 'auth != null && !newData.exists() && newData.getPriority() === null' },
    prioArr: { '.write': "auth != null && newData.hasChildren() && newData.child('0').val() === 'a' && newData.getPriority() === 5" },
  },
};

const normalizationCases: Array<[label: string, path: string, value: unknown, expected: Verdict]> = [
  ['array write coerced to integer-keyed object', '/arr', ['a', 'b'], 'ALLOW'],
  ['empty array write pruned to null', '/emptyArr', [], 'ALLOW'],
  ['prioritized empty object pruned to null with null priority', '/emptyObjPrio', { '.value': {}, '.priority': 5 }, 'ALLOW'],
  ['prioritized array write preserves priority and coerces elements', '/prioArr', { '.value': ['a', 'b'], '.priority': 5 }, 'ALLOW'],
];

describe('RTDB simulate normalizes arrays, empty objects, and pruned priorities as the sandbox does (MET-3)', () => {
  for (const [label, path, value, expected] of normalizationCases) {
    test(label, async () => {
      const box = initializeSandbox();
      const admin = getDatabase(box.withAuth({ uid: 'admin' }));
      sandbox.setRules(admin, normalizationRules);
      let verdict: Verdict = 'ALLOW';
      try {
        await set(ref(getDatabase(box.withAuth({ uid: 'u1' })), path.slice(1)), value as never);
      } catch {
        verdict = 'DENY';
      }
      const [result] = rtdbRules(normalizationRules).simulate([
        { expectation: expected, operation: 'write', path, auth: 'u1', newData: value },
      ]).cases;
      expect(verdict).toBe(expected);
      expect(result.decision).toBe(verdict);
    });
  }

  test('multi-path update normalizes array and empty-object values across sibling paths', async () => {
    const box = initializeSandbox();
    const admin = getDatabase(box.withAuth({ uid: 'admin' }));
    sandbox.setRules(admin, normalizationRules);
    const patch = { arr: ['a', 'b'], emptyArr: [], emptyObjPrio: { '.value': {}, '.priority': 5 } };
    let verdict: Verdict = 'ALLOW';
    try {
      await update(ref(getDatabase(box.withAuth({ uid: 'u1' }))), patch as never);
    } catch {
      verdict = 'DENY';
    }
    const [result] = rtdbRules(normalizationRules).simulate([
      { expectation: 'ALLOW', operation: 'update', path: '/', auth: 'u1', newData: patch },
    ]).cases;
    expect(verdict).toBe('ALLOW');
    expect(result.decision).toBe(verdict);
  });

  test('empty multi-path update {} resolves as ALLOW in both sandbox and simulate/explain', async () => {
    const box = initializeSandbox();
    const admin = getDatabase(box.withAuth({ uid: 'admin' }));
    sandbox.setRules(admin, rules);
    await update(ref(getDatabase(box.withAuth(null)), 'rooms/r1'), {});
    const [simResult] = rtdbRules(rules).simulate([
      { expectation: 'ALLOW', operation: 'update', path: '/rooms/r1', auth: null, newData: {} },
    ]).cases;
    expect(simResult.decision).toBe('ALLOW');
    expect(simResult.unsupported).toBe(false);
    const explainResult = rtdbRules(rules).explain({
      expectation: 'ALLOW',
      operation: 'update',
      path: '/rooms/r1',
      auth: null,
      newData: {},
    });
    expect(explainResult.decision).toBe('ALLOW');
  });
});

describe('RTDB inline and explicit .priority server values resolve before validation', () => {
  test('denies serverTimestamp() and increment() priorities under newData.getPriority() === null', async () => {
    const fixedNow = 1_700_000_000_000;
    const nullPriorityRules = {
      rules: {
        items: {
          $id: {
            '.read': true,
            '.write': 'auth != null',
            '.validate': 'newData.getPriority() === null',
          },
        },
      },
    };

    const box = initializeSandbox();
    getClock(box).set(fixedNow);
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    const admin = getAdminDatabase(box);
    sandbox.setRules(db, nullPriorityRules);

    const simTs = rtdbRules(nullPriorityRules).explain({
      operation: 'write',
      path: '/items/i1',
      auth: { uid: 'u1', token: {} },
      now: fixedNow,
      newData: { title: 'doc', '.priority': serverTimestamp() },
      expectation: 'DENY',
    });
    expect(simTs.decision).toBe('DENY');

    await expect(
      set(ref(db, 'items/i1'), { title: 'doc', '.priority': serverTimestamp() }),
    ).rejects.toThrow('PERMISSION_DENIED');
    expect((await get(ref(admin, 'items/i1'))).exists()).toBe(false);

    await expect(
      set(ref(db, 'items/i2'), { '.value': 'doc', '.priority': increment(5) }),
    ).rejects.toThrow('PERMISSION_DENIED');
    expect((await get(ref(admin, 'items/i2'))).exists()).toBe(false);
  });

  test('resolves serverTimestamp() priority to now across set, update, runTransaction, onDisconnect, setWithPriority, and setPriority', async () => {
    const fixedNow = 1_700_000_000_000;
    const priorityNowRules = {
      rules: {
        items: {
          $id: {
            '.read': true,
            '.write': 'auth != null',
            '.validate': 'newData.getPriority() === now',
          },
        },
      },
    };

    const box = initializeSandbox();
    getClock(box).set(fixedNow);
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    const admin = getAdminDatabase(box);
    sandbox.setRules(db, priorityNowRules);

    const simAllow = rtdbRules(priorityNowRules).explain({
      operation: 'write',
      path: '/items/i1',
      auth: { uid: 'u1', token: {} },
      now: fixedNow,
      newData: { title: 'doc', '.priority': serverTimestamp() },
      expectation: 'ALLOW',
    });
    expect(simAllow.decision).toBe('ALLOW');

    await set(ref(db, 'items/i1'), { title: 'doc', '.priority': serverTimestamp() });
    expect((await get(ref(admin, 'items/i1'))).priority).toBe(fixedNow);

    await update(ref(db, 'items'), {
      i2: { title: 'doc', '.priority': serverTimestamp() },
    });
    expect((await get(ref(admin, 'items/i2'))).priority).toBe(fixedNow);

    const tx = await runTransaction(ref(db, 'items/i3'), () => ({
      title: 'doc',
      '.priority': serverTimestamp(),
    }));
    expect(tx.committed).toBe(true);
    expect(tx.snapshot.priority).toBe(fixedNow);

    await onDisconnect(ref(db, 'items/i4')).set({
      title: 'doc',
      '.priority': serverTimestamp(),
    });
    goOffline(db);
    const odSnap = await get(ref(admin, 'items/i4'));
    expect(odSnap.exists()).toBe(true);
    expect(odSnap.priority).toBe(fixedNow);

    const boxExplicit = initializeSandbox();
    getClock(boxExplicit).set(fixedNow);
    const dbExplicit = getDatabase(boxExplicit.withAuth({ uid: 'u1' }));
    const adminExplicit = getAdminDatabase(boxExplicit);
    await set(ref(adminExplicit, 'items/i6'), { title: 'seeded' });
    sandbox.setRules(dbExplicit, priorityNowRules);

    await setWithPriority(ref(dbExplicit, 'items/i5'), { title: 'doc' }, serverTimestamp() as unknown as number);
    expect((await get(ref(adminExplicit, 'items/i5'))).priority).toBe(fixedNow);

    await setPriority(ref(dbExplicit, 'items/i6'), serverTimestamp() as unknown as number);
    expect((await get(ref(adminExplicit, 'items/i6'))).priority).toBe(fixedNow);
  });

  test('resolves increment(delta) in inline .priority from 0 and from prior leaf or object priority in both simulate and sandbox', async () => {
    const incRules = {
      rules: {
        items: {
          $id: {
            '.read': true,
            '.write': 'auth != null',
            '.validate': 'newData.getPriority() === (data.exists() ? data.getPriority() + 5 : 5)',
          },
        },
      },
    };

    const simLeafStep = rtdbRules(incRules).explain({
      operation: 'write',
      path: '/items/i1',
      auth: { uid: 'u1', token: {} },
      data: { items: { i1: { '.value': 'doc', '.priority': 5 } } },
      newData: { '.value': 'doc2', '.priority': increment(5) },
      expectation: 'ALLOW',
    });
    expect(simLeafStep.decision).toBe('ALLOW');

    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    const admin = getAdminDatabase(box);
    sandbox.setRules(db, incRules);

    await set(ref(db, 'items/i1'), { '.value': 'doc', '.priority': increment(5) });
    expect((await get(ref(admin, 'items/i1'))).priority).toBe(5);

    await set(ref(db, 'items/i1'), { '.value': 'doc2', '.priority': increment(5) });
    expect((await get(ref(admin, 'items/i1'))).priority).toBe(10);

    await set(ref(db, 'items/i2'), { title: 'obj', '.priority': increment(5) });
    expect((await get(ref(admin, 'items/i2'))).priority).toBe(5);

    await update(ref(db, 'items'), {
      i2: { title: 'obj2', '.priority': increment(5) },
    });
    expect((await get(ref(admin, 'items/i2'))).priority).toBe(10);
  });
});

