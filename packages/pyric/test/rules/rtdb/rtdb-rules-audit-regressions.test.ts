import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAdminDatabase,
  getDatabase,
  get,
  goOffline,
  onDisconnect,
  ref,
  sandbox as rtdbSandbox,
  set,
  setPriority,
  setWithPriority,
  update,
} from 'pyric/database';
import { rtdbRules } from '../../../src/rules/index.js';
import {
  compileRtdbRules,
  simulateRtdbRules,
} from '../../../src/rules/rtdb/compiled-rules.js';
import {
  defineRtdbRules,
  expr,
} from '../../../src/rules/rtdb/constraints/index.js';
import {
  DataSnapshot,
  evaluateRtdbExpression,
  type EvalContext,
} from '../../../src/rules/rtdb/grammar/simulator.js';
import { validateExpression } from '../../../src/rules/rtdb/grammar/validator.js';

function makeEvalContext(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    auth: { uid: 'alice', token: {} },
    data: new DataSnapshot(null),
    newData: new DataSnapshot(null),
    root: new DataSnapshot(null),
    now: 1700000000000,
    pathVariableBindings: {},
    ...overrides,
  };
}

describe('RTDB rules evaluation and sandbox writes match production', () => {
  describe('operator precedence', () => {
    test('&& binds tighter than || in boolean expressions', () => {
      const ctx = makeEvalContext();
      // In production RTDB (and JS/CEL), `true || false && false` is `true || (false && false)` === true
      expect(evaluateRtdbExpression('true || false && false', ctx)).toBe(true);
      expect(evaluateRtdbExpression('!(true || false && false)', ctx)).toBe(false);

      const compiled = compileRtdbRules({
        rules: {
          items: {
            '.read': '!(true || false && false)',
          },
        },
      });
      const res = simulateRtdbRules(compiled, {
        operation: 'read',
        path: '/items',
        auth: { uid: 'alice', token: {} },
        mockData: {},
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.allowed).toBe(false);
      }
    });

    test('relational operators (<, <=, >, >=) bind tighter than equality (==, !=, ===, !==)', () => {
      const ctx = makeEvalContext();
      // `false == (1 < 2)` -> `false == true` -> false
      expect(evaluateRtdbExpression('false == 1 < 2', ctx)).toBe(false);
      // `(1 < 2) == true` -> `true == true` -> true
      expect(evaluateRtdbExpression('1 < 2 == true', ctx)).toBe(true);
    });
  });

  describe('runtime type errors on .length, relational, and arithmetic operators', () => {
    test('accessing .length on a number or null fails the rule instead of returning null (0)', () => {
      const compiled = compileRtdbRules({
        rules: {
          items: {
            $id: {
              '.write': 'auth != null',
              '.validate': 'newData.val().length <= 8',
            },
          },
          negated: {
            $id: {
              '.write': 'auth != null',
              '.validate': '!(newData.val().length > 2)',
            },
          },
        },
      });

      const resLe = simulateRtdbRules(compiled, {
        operation: 'write',
        path: '/items/item1',
        auth: { uid: 'alice', token: {} },
        mockData: {},
        newData: 5,
      });
      expect(resLe.success).toBe(true);
      if (resLe.success) {
        expect(resLe.data.allowed).toBe(false);
      }

      const resNeg = simulateRtdbRules(compiled, {
        operation: 'write',
        path: '/negated/item1',
        auth: { uid: 'alice', token: {} },
        mockData: {},
        newData: 5,
      });
      expect(resNeg.success).toBe(true);
      if (resNeg.success) {
        expect(resNeg.data.allowed).toBe(false);
      }
    });

    test('relational and arithmetic operators reject null operands instead of coercing null to 0', () => {
      const compiled = compileRtdbRules({
        rules: {
          counter: {
            '.write': 'auth != null',
            '.validate': 'newData.val() == data.val() + 1',
          },
          bounded: {
            '.write': 'auth != null',
            '.validate': "newData.child('x').val() < 10",
          },
        },
      });

      // data does not exist (data.val() is null); null + 1 must error, not equal 1
      const addRes = simulateRtdbRules(compiled, {
        operation: 'write',
        path: '/counter',
        auth: { uid: 'alice', token: {} },
        mockData: {},
        newData: 1,
      });
      expect(addRes.success).toBe(true);
      if (addRes.success) {
        expect(addRes.data.allowed).toBe(false);
      }

      // child 'x' is missing (null); null < 10 must error, not evaluate to true
      const ltRes = simulateRtdbRules(compiled, {
        operation: 'write',
        path: '/bounded',
        auth: { uid: 'alice', token: {} },
        mockData: {},
        newData: { y: 1 },
      });
      expect(ltRes.success).toBe(true);
      if (ltRes.success) {
        expect(ltRes.data.allowed).toBe(false);
      }
    });
  });

  describe('write priority reaches newData.getPriority() and storage', () => {
    test('setWithPriority, setPriority, and onDisconnect().setWithPriority pass priority to newData.getPriority()', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'alice', token: {} }));
      rtdbSandbox.setRules(db, {
        rules: {
          items: {
            $id: {
              '.read': 'true',
              '.write': 'auth != null',
              '.validate': 'newData.getPriority() == 10 || newData.getPriority() == 20',
            },
          },
        },
      });

      const itemRef = ref(db, 'items/a');
      await expect(setWithPriority(itemRef, 'hello', 10)).resolves.toBeUndefined();
      await expect(setPriority(itemRef, 20)).resolves.toBeUndefined();
      await expect(onDisconnect(itemRef).setWithPriority('later', 10)).resolves.toBeUndefined();
    });

    test('an inline .priority wins over the priority argument, for set and for onDisconnect().set', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'alice', token: {} }));
      rtdbSandbox.setRules(db, {
        rules: { items: { $id: { '.read': 'true', '.write': 'true', '.validate': 'newData.getPriority() == 3' } } },
      });

      await expect(setWithPriority(ref(db, 'items/a'), { '.value': 'v', '.priority': 3 }, 10)).resolves.toBeUndefined();
      expect((await get(ref(db, 'items/a'))).priority).toBe(3);
      await expect(onDisconnect(ref(db, 'items/b')).setWithPriority({ '.value': 'v', '.priority': 3 }, 10)).resolves.toBeUndefined();
      goOffline(db);
      expect((await get(ref(getAdminDatabase(sandbox), 'items/b'))).priority).toBe(3);
    });

    test('a priority inside update() children reaches newData.getPriority() and storage', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'alice', token: {} }));
      rtdbSandbox.setRules(db, {
        rules: { items: { $id: { '.read': 'true', '.write': 'true', '.validate': 'newData.getPriority() == 10' } } },
      });

      await expect(update(ref(db, 'items'), {
        leaf: { '.value': 'v', '.priority': 10 },
        node: { x: 1, '.priority': 10 },
      })).resolves.toBeUndefined();
      const leaf = await get(ref(db, 'items/leaf'));
      const node = await get(ref(db, 'items/node'));
      expect([leaf.val(), leaf.priority]).toEqual(['v', 10]);
      expect([node.val(), node.priority]).toEqual([{ x: 1 }, 10]);
      await expect(update(ref(db, 'items'), { other: 'v' })).rejects.toThrow(/PERMISSION_DENIED/);
    });

    test('a nested { ".value", ".priority" } keeps the child priority, and rules read it', async () => {
      const sandbox = initializeSandbox();
      const admin = getAdminDatabase(sandbox);
      const db = getDatabase(sandbox.withAuth({ uid: 'alice', token: {} }));
      rtdbSandbox.setRules(db, {
        rules: {
          leafpriority: { '.read': "data.child('leaf').getPriority() == 2" },
          written: { '.write': 'true', '.validate': "newData.child('leaf').getPriority() == 4" },
        },
      });

      await set(ref(admin, 'leafpriority'), { leaf: { '.value': 'x', '.priority': 2 } });
      const leaf = await get(ref(admin, 'leafpriority/leaf'));
      expect([leaf.val(), leaf.priority]).toEqual(['x', 2]);
      await expect(get(ref(db, 'leafpriority'))).resolves.toBeDefined();
      await expect(set(ref(db, 'written'), { leaf: { '.value': 'y', '.priority': 4 } })).resolves.toBeUndefined();
      expect((await get(ref(admin, 'written/leaf'))).priority).toBe(4);
    });

    test('an inline priority of the wrong type throws the SDK assertion', async () => {
      const admin = getAdminDatabase(initializeSandbox());
      await expect(set(ref(admin, 'items/c'), { '.value': 'v', '.priority': true })).rejects.toThrow(
        'Firebase Database (12.13.0) INTERNAL ASSERT FAILED: Invalid priority type found: boolean',
      );
    });

    test('set(ref, { ".value": v, ".priority": p }) unwraps .value and stores .priority metadata', async () => {
      const sandbox = initializeSandbox();
      const admin = getAdminDatabase(sandbox);
      const itemRef = ref(admin, 'items/b');

      await set(itemRef, { '.value': 'hello', '.priority': 5 });
      const snap = await get(itemRef);
      expect(snap.val()).toBe('hello');
      expect(snap.priority).toBe(5);
    });
  });

  describe('validator and path variable binding', () => {
    test('validateExpression rejects undeclared $variables and bare path variable names without $', () => {
      const undeclaredErrors = validateExpression('$undeclared == auth.uid', 'read', ['$uid']);
      expect(undeclaredErrors.map((e) => e.code)).toContain('UNKNOWN_IDENTIFIER');

      const bareUidErrors = validateExpression('uid == auth.uid', 'read', ['$uid']);
      expect(bareUidErrors.map((e) => e.code)).toContain('UNKNOWN_IDENTIFIER');
    });

    test('validateExpression rejects .length() as a method call and does not duplicate NEWDATA_IN_READ', () => {
      const lengthMethodErrors = validateExpression('newData.val().length() > 0', 'validate', []);
      // Production's deploy validation: "Function call on target that is not a function."
      expect(lengthMethodErrors.map((e) => e.code)).toContain('NOT_A_FUNCTION');

      const newDataReadErrors = validateExpression('newData.exists()', 'read', []);
      expect(newDataReadErrors.map((e) => e.code)).toEqual(['NEWDATA_IN_READ']);
    });

    test('wildcard named $data does not overwrite built-in data DataSnapshot during simulation', () => {
      const compiled = compileRtdbRules({
        rules: {
          items: {
            $data: {
              '.read': "data.exists() && $data == 'foo'",
            },
          },
        },
      });

      const res = simulateRtdbRules(compiled, {
        operation: 'read',
        path: '/items/foo',
        auth: { uid: 'alice', token: {} },
        mockData: { items: { foo: 'bar' } },
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.allowed).toBe(true);
      }
    });
  });

  describe('defineRtdbRules().simulate() and rtdbRules().simulate() forward query constraints', () => {
    test('defineRtdbRules().simulate() forwards query constraints to simulator', () => {
      const doc = defineRtdbRules({
        paths: {
          '/items': {
            read: expr("query.orderByChild == 'score' && query.limitToFirst <= 10"),
          },
        },
      });

      const res = doc.simulate({
        operation: 'read',
        path: '/items',
        auth: { uid: 'alice', token: {} },
        mockData: {},
        query: { orderByChild: 'score', limitToFirst: 5 },
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.allowed).toBe(true);
      }
    });

    test('rtdbRules().simulate() supports query constraints on RtdbCase', () => {
      const ruleset = rtdbRules({
        rules: {
          items: {
            '.read': "query.orderByChild == 'score' && query.limitToFirst <= 10",
          },
        },
      });

      const report = ruleset.simulate([
        {
          auth: { uid: 'alice' },
          operation: 'read',
          path: '/items',
          query: { orderByChild: 'score', limitToFirst: 5 },
          expectation: 'ALLOW',
        },
      ]);
      expect(report.cases[0]?.passed).toBe(true);
    });
  });

  describe('the paths a write checks are the paths it writes', () => {
    test('multi-path update rooted at "/" does not run .validate on untouched branches', () => {
      const compiled = compileRtdbRules({
        rules: {
          '.write': 'true',
          a: {
            '.validate': 'newData.isString()',
          },
          unrelated: {
            '.validate': 'newData.isNumber()',
          },
        },
      });

      const res = simulateRtdbRules(compiled, {
        operation: 'write',
        path: '/',
        auth: { uid: 'alice', token: {} },
        mockData: { unrelated: 'legacy-non-number' },
        updates: [{ path: '/a', value: 'valid-string' }],
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.allowed).toBe(true);
      }
    });

    // The production SDK resolves an empty update without contacting the
    // server, so no rule is evaluated and nothing is written.
    test('update(ref, {}) resolves without evaluating rules and writes nothing', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'alice', token: {} }));
      rtdbSandbox.setRules(db, { rules: { restricted: { '.read': 'false', '.write': 'false' } } });
      const before = rtdbSandbox.snapshotState(db);

      await expect(update(ref(db, 'restricted'), {})).resolves.toBeUndefined();
      expect(rtdbSandbox.snapshotState(db)).toEqual(before);
    });

    test('onDisconnect().update({}) resolves without evaluating rules and leaves the queued write in place', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'alice', token: {} }));
      rtdbSandbox.setRules(db, { rules: { status: { '.read': 'true', '.write': "newData.val() == 'offline'" } } });
      await onDisconnect(ref(db, 'status')).set('offline');

      await expect(onDisconnect(ref(db, 'status')).update({})).resolves.toBeUndefined();
      goOffline(db);
      expect(rtdbSandbox.snapshotState(db)).toEqual({ status: 'offline' });
    });
  });
});
