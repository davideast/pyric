import { describe, expect, test } from 'bun:test';
import { DataSnapshot, evaluateRtdbExpression } from '../../../src/rules/rtdb/grammar/simulator.js';
import { parseExpression } from '../../../src/rules/rtdb/grammar/RtdbExprParser.js';
import { lintExpression } from '../../../src/rules/rtdb/grammar/linter.js';
import type { EvalContext } from '../../../src/rules/rtdb/grammar/simulator.js';

describe('RTDB Soundness & Grammar Alignment (Track A)', () => {
  describe('Finding 1: Evaluation Context Isolation (Statelessness)', () => {
    test('unauthenticated evaluation does not see leftover auth context from prior call', () => {
      const authedCtx: EvalContext = {
        auth: { uid: 'user_alice', token: { email: 'alice@example.com' } },
        data: new DataSnapshot(null),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 1000,
        pathVariableBindings: {},
      };

      const unauthedCtx: EvalContext = {
        auth: null,
        data: new DataSnapshot(null),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 1000,
        pathVariableBindings: {},
      };

      const authedResult = evaluateRtdbExpression('auth != null', authedCtx);
      expect(authedResult).toBe(true);

      const unauthedResult = evaluateRtdbExpression('auth != null', unauthedCtx);
      expect(unauthedResult).toBe(false);

      const authedUid = evaluateRtdbExpression('auth.uid', authedCtx);
      expect(authedUid).toBe('user_alice');

      const unauthedUid = evaluateRtdbExpression('auth.uid', unauthedCtx);
      expect(unauthedUid).toBeNull();
    });

    test('evaluations with differing data snapshots remain strictly isolated', () => {
      const ctxDocA: EvalContext = {
        auth: null,
        data: new DataSnapshot({ owner: 'alice', counter: 10 }),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 1000,
        pathVariableBindings: {},
      };

      const ctxDocB: EvalContext = {
        auth: null,
        data: new DataSnapshot({ owner: 'bob', counter: 20 }),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 1000,
        pathVariableBindings: {},
      };

      expect(evaluateRtdbExpression("data.child('owner').val()", ctxDocA)).toBe('alice');
      expect(evaluateRtdbExpression("data.child('owner').val()", ctxDocB)).toBe('bob');
      expect(evaluateRtdbExpression("data.child('counter').val()", ctxDocA)).toBe(10);
      expect(evaluateRtdbExpression("data.child('counter').val()", ctxDocB)).toBe(20);
    });

    test('evaluations with differing pathVariableBindings do not leak bindings', () => {
      const ctxAlice: EvalContext = {
        auth: null,
        data: new DataSnapshot(null),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 1000,
        pathVariableBindings: { $userId: 'user_123' },
      };

      const ctxBob: EvalContext = {
        auth: null,
        data: new DataSnapshot(null),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 1000,
        pathVariableBindings: { $userId: 'user_456' },
      };

      const ctxEmpty: EvalContext = {
        auth: null,
        data: new DataSnapshot(null),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 1000,
        pathVariableBindings: {},
      };

      expect(evaluateRtdbExpression('$userId', ctxAlice)).toBe('user_123');
      expect(evaluateRtdbExpression('$userId', ctxBob)).toBe('user_456');
      expect(evaluateRtdbExpression('$userId', ctxEmpty)).toBeUndefined();
    });

    test('interleaved evaluations across disparate contexts maintain strict isolation', () => {
      const ctx1: EvalContext = {
        auth: { uid: 'uid_1', token: {} },
        data: new DataSnapshot('value_1'),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 100,
        pathVariableBindings: { $id: 'first' },
      };

      const ctx2: EvalContext = {
        auth: { uid: 'uid_2', token: {} },
        data: new DataSnapshot('value_2'),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 200,
        pathVariableBindings: { $id: 'second' },
      };

      for (let i = 0; i < 5; i++) {
        expect(evaluateRtdbExpression('auth.uid', ctx1)).toBe('uid_1');
        expect(evaluateRtdbExpression('auth.uid', ctx2)).toBe('uid_2');
        expect(evaluateRtdbExpression('data.val()', ctx1)).toBe('value_1');
        expect(evaluateRtdbExpression('data.val()', ctx2)).toBe('value_2');
        expect(evaluateRtdbExpression('$id', ctx1)).toBe('first');
        expect(evaluateRtdbExpression('$id', ctx2)).toBe('second');
        expect(evaluateRtdbExpression('now', ctx1)).toBe(100);
        expect(evaluateRtdbExpression('now', ctx2)).toBe(200);
      }
    });
  });

  describe('Finding 2: Grammar & Linter Alignment', () => {
    test('rejects strict equality (===) as syntax error', () => {
      const parsed = parseExpression('auth.uid === "user123"');
      expect(parsed.valid).toBe(false);
      expect(parsed.errors.length).toBeGreaterThan(0);
    });

    test('rejects strict inequality (!==) as syntax error', () => {
      const parsed = parseExpression('auth !== null');
      expect(parsed.valid).toBe(false);
      expect(parsed.errors.length).toBeGreaterThan(0);
    });

    test('accepts standard equality (==) without errors or warnings', () => {
      const parsed = parseExpression('auth.uid == "user123"');
      expect(parsed.valid).toBe(true);
      expect(parsed.errors).toHaveLength(0);

      const warnings = lintExpression('auth.uid == "user123"');
      const equalityWarnings = warnings.filter(
        (w) => w.code === 'LOOSE_EQUALITY' || w.code === 'LOOSE_INEQUALITY',
      );
      expect(equalityWarnings).toHaveLength(0);
    });

    test('accepts standard inequality (!=) without errors or warnings', () => {
      const parsed = parseExpression('auth != null');
      expect(parsed.valid).toBe(true);
      expect(parsed.errors).toHaveLength(0);

      const warnings = lintExpression('auth != null');
      const inequalityWarnings = warnings.filter(
        (w) => w.code === 'LOOSE_EQUALITY' || w.code === 'LOOSE_INEQUALITY',
      );
      expect(inequalityWarnings).toHaveLength(0);
    });

    test('evaluates == and != correctly across types', () => {
      const ctx: EvalContext = {
        auth: { uid: 'user1', token: {} },
        data: new DataSnapshot({
          str: 'hello',
          num: 42,
          bool: true,
          nil: null,
        }),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 1000,
        pathVariableBindings: {},
      };

      expect(evaluateRtdbExpression("data.child('str').val() == 'hello'", ctx)).toBe(true);
      expect(evaluateRtdbExpression("data.child('str').val() != 'world'", ctx)).toBe(true);
      expect(evaluateRtdbExpression("data.child('num').val() == 42", ctx)).toBe(true);
      expect(evaluateRtdbExpression("data.child('num').val() != 99", ctx)).toBe(true);
      expect(evaluateRtdbExpression("data.child('bool').val() == true", ctx)).toBe(true);
      expect(evaluateRtdbExpression("data.child('bool').val() != false", ctx)).toBe(true);
      expect(evaluateRtdbExpression("data.child('nil').val() == null", ctx)).toBe(true);
      expect(evaluateRtdbExpression("data.child('nonexistent').val() == null", ctx)).toBe(true);
      expect(evaluateRtdbExpression("data.child('str').val() != null", ctx)).toBe(true);
    });
  });

  describe('Finding 3: Fail-Closed Boolean Type Enforcement on Unary Negation', () => {
    const ctx: EvalContext = {
      auth: null,
      data: new DataSnapshot({
        zero: 0,
        one: 1,
        emptyStr: '',
        str: 'abc',
        boolTrue: true,
        boolFalse: false,
      }),
      newData: new DataSnapshot(null),
      root: new DataSnapshot(null),
      now: 1000,
      pathVariableBindings: {},
    };

    test('!true evaluates to false', () => {
      expect(evaluateRtdbExpression('!true', ctx)).toBe(false);
      expect(evaluateRtdbExpression("!data.child('boolTrue').val()", ctx)).toBe(false);
    });

    test('!false evaluates to true', () => {
      expect(evaluateRtdbExpression('!false', ctx)).toBe(true);
      expect(evaluateRtdbExpression("!data.child('boolFalse').val()", ctx)).toBe(true);
    });

    test('!null evaluates to false (fail-closed, never true)', () => {
      expect(evaluateRtdbExpression('!null', ctx)).toBe(false);
      expect(evaluateRtdbExpression("!data.child('missing').val()", ctx)).toBe(false);
    });

    test('negation of non-boolean primitives evaluates to false (fail-closed)', () => {
      // Numbers: !0 and !1 must both evaluate to false
      expect(evaluateRtdbExpression('!0', ctx)).toBe(false);
      expect(evaluateRtdbExpression('!1', ctx)).toBe(false);
      expect(evaluateRtdbExpression("!data.child('zero').val()", ctx)).toBe(false);
      expect(evaluateRtdbExpression("!data.child('one').val()", ctx)).toBe(false);

      // Strings: !"" and !"hello" must both evaluate to false
      expect(evaluateRtdbExpression('!""', ctx)).toBe(false);
      expect(evaluateRtdbExpression('!"hello"', ctx)).toBe(false);
      expect(evaluateRtdbExpression("!data.child('emptyStr').val()", ctx)).toBe(false);
      expect(evaluateRtdbExpression("!data.child('str').val()", ctx)).toBe(false);
    });

    test('negation on boolean method returns functions correctly', () => {
      expect(evaluateRtdbExpression('!data.exists()', ctx)).toBe(false);
      expect(evaluateRtdbExpression("!data.child('missing').exists()", ctx)).toBe(true);
      expect(evaluateRtdbExpression("!data.child('str').isString()", ctx)).toBe(false);
      expect(evaluateRtdbExpression("!data.child('str').isNumber()", ctx)).toBe(true);
    });
  });
});
