import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, get, ref, set, sandbox } from 'pyric/database';
import { rtdbRules } from 'pyric/rules';

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
