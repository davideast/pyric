import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAdminDatabase,
  getDatabase,
  get,
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

describe('RTDB Security Rules Audit — Regression & Acceptance Suite (Issues 1, 3–7)', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Issue 1: Operator Precedence in RtdbExpr.ohm (&& vs ||, equality vs relational)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Issue 1: Operator precedence in RtdbExpr.ohm', () => {
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

  // ──────────────────────────────────────────────────────────────────────────
  // Issue 3: Silent JS type coercion on .length, relational, and arithmetic ops
  // ──────────────────────────────────────────────────────────────────────────
  describe('Issue 3: Runtime type errors on .length, relational, and arithmetic operators', () => {
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

  // ──────────────────────────────────────────────────────────────────────────
  // Issue 4: Sandbox priority writes & { '.value', '.priority' } normalization
  // ──────────────────────────────────────────────────────────────────────────
  describe('Issue 4: Sandbox priority propagation to rules and .value/.priority normalization', () => {
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

  // ──────────────────────────────────────────────────────────────────────────
  // Issue 5: Expression validator & path variable binding defects
  // ──────────────────────────────────────────────────────────────────────────
  describe('Issue 5: Validator and path variable binding', () => {
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

  // ──────────────────────────────────────────────────────────────────────────
  // Issue 6: defineRtdbRules().simulate() and rtdbRules().simulate() drop query & updates
  // ──────────────────────────────────────────────────────────────────────────
  describe('Issue 6: High-level rules document and rtdbRules() preserve query and updates', () => {
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

  // ──────────────────────────────────────────────────────────────────────────
  // Issue 7: Root multi-path update .validate blast radius & empty update(ref, {}) bypass
  // ──────────────────────────────────────────────────────────────────────────
  describe('Issue 7: Multi-path update validation scope and empty update() authorization', () => {
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

    test('empty update(ref, {}) still enforces .write rules at the target path', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'alice', token: {} }));
      rtdbSandbox.setRules(db, {
        rules: {
          restricted: {
            '.read': 'false',
            '.write': 'false',
          },
        },
      });

      await expect(update(ref(db, 'restricted'), {})).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });
});
