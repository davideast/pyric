import { describe, expect, test } from 'bun:test';
import {
  DataSnapshot,
  evaluateRtdbExpression,
  type EvalContext,
} from '../../../src/rules/rtdb/grammar/simulator.js';
import { parseExpression } from '../../../src/rules/rtdb/grammar/RtdbExprParser.js';
import { lintExpression } from '../../../src/rules/rtdb/grammar/linter.js';

describe('Adversarial Verification — Challenger 1', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // TRACK A — R1: Stateless Evaluation Context & Concurrency Isolation
  // ──────────────────────────────────────────────────────────────────────────
  describe('R1: Evaluation Context Isolation & Concurrency Stress', () => {
    test(
      'asynchronous interleaved evaluations maintain 100% context isolation',
      async () => {
      const NUM_CONTEXTS = 20;
      const EVALS_PER_CONTEXT = 100; // 20 * 100 = 2,000 evaluations (18,000 assertions)

      const contexts: EvalContext[] = Array.from({ length: NUM_CONTEXTS }, (_, i) => ({
        auth: i % 2 === 0 ? { uid: `user_${i}`, token: { role: `role_${i}`, level: i } } : null,
        data: new DataSnapshot({ id: `doc_${i}`, count: i, secret: `secret_${i}` }),
        newData: new DataSnapshot({ id: `doc_${i}`, count: i + 1, updated: true }),
        root: new DataSnapshot({ rootId: `root_${i}` }),
        now: 1700000000000 + i * 1000,
        pathVariableBindings: { $docId: `doc_${i}`, $wildcard: `wild_${i}` },
      }));

      // Generate 10,000 tasks shuffled across contexts
      const tasks: Array<() => Promise<void>> = [];

      for (let c = 0; c < NUM_CONTEXTS; c++) {
        const ctx = contexts[c];
        const isAuthed = c % 2 === 0;

        for (let j = 0; j < EVALS_PER_CONTEXT; j++) {
          tasks.push(async () => {
            // Introduce microtask delay to interleave execution
            await Promise.resolve();

            // 1. Check auth isolation
            const authResult = evaluateRtdbExpression('auth != null', ctx);
            expect(authResult).toBe(isAuthed);

            const uidResult = evaluateRtdbExpression('auth.uid', ctx);
            expect(uidResult).toBe(isAuthed ? `user_${c}` : null);

            const roleResult = evaluateRtdbExpression('auth.token.role', ctx);
            expect(roleResult).toBe(isAuthed ? `role_${c}` : null);

            // 2. Check data snapshot isolation
            const dataId = evaluateRtdbExpression("data.child('id').val()", ctx);
            expect(dataId).toBe(`doc_${c}`);

            const dataCount = evaluateRtdbExpression("data.child('count').val()", ctx);
            expect(dataCount).toBe(c);

            // 3. Check newData snapshot isolation
            const newCount = evaluateRtdbExpression("newData.child('count').val()", ctx);
            expect(newCount).toBe(c + 1);

            // 4. Check root snapshot isolation
            const rootId = evaluateRtdbExpression("root.child('rootId').val()", ctx);
            expect(rootId).toBe(`root_${c}`);

            // 5. Check now timestamp isolation
            const evalNow = evaluateRtdbExpression('now', ctx);
            expect(evalNow).toBe(1700000000000 + c * 1000);

            // 6. Check path variable bindings isolation
            const evalDocId = evaluateRtdbExpression('$docId', ctx);
            expect(evalDocId).toBe(`doc_${c}`);

            const evalWild = evaluateRtdbExpression('$wildcard', ctx);
            expect(evalWild).toBe(`wild_${c}`);
          });
        }
      }

      // Shuffle tasks to maximize interleaving entropy
      for (let i = tasks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
      }

      // Execute in parallel batches of 500
      const BATCH_SIZE = 500;
      for (let b = 0; b < tasks.length; b += BATCH_SIZE) {
        await Promise.all(tasks.slice(b, b + BATCH_SIZE).map((t) => t()));
      }
    }, 20000);

    test('re-entrant evaluation via object getter does not clobber outer evaluation context', () => {
      let reentrantCallCount = 0;

      const innerCtx: EvalContext = {
        auth: { uid: 'inner_user', token: { role: 'inner_admin' } },
        data: new DataSnapshot({ owner: 'inner_owner' }),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 9999,
        pathVariableBindings: { $var: 'inner_val' },
      };

      const outerData = {
        get customProp() {
          reentrantCallCount++;
          // Trigger a re-entrant evaluation of evaluateRtdbExpression during property read
          const innerResult = evaluateRtdbExpression('auth.uid == "inner_user"', innerCtx);
          expect(innerResult).toBe(true);
          return 'outer_prop_value';
        },
      };

      const outerCtx: EvalContext = {
        auth: { uid: 'outer_user', token: { role: 'outer_viewer' } },
        data: new DataSnapshot(outerData),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 1111,
        pathVariableBindings: { $var: 'outer_val' },
      };

      // In expression: outer eval reads data.child('customProp').val(), then reads auth.uid
      const expr = "data.child('customProp').val() == 'outer_prop_value' && auth.uid == 'outer_user'";
      const outerResult = evaluateRtdbExpression(expr, outerCtx);

      expect(reentrantCallCount).toBeGreaterThan(0);
      expect(outerResult).toBe(true);

      // Verify that after re-entrancy, outerCtx still retains its original values
      expect(evaluateRtdbExpression('auth.uid', outerCtx)).toBe('outer_user');
      expect(evaluateRtdbExpression('now', outerCtx)).toBe(1111);
      expect(evaluateRtdbExpression('$var', outerCtx)).toBe('outer_val');
    });

    test('evaluation errors do not poison semantics or leak context to subsequent calls', () => {
      const toxicCtx: EvalContext = {
        auth: { uid: 'toxic_leak_attempt', token: { secret: 'super_secret' } },
        data: new DataSnapshot(null),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 666,
        pathVariableBindings: { $toxic: 'radioactive' },
      };

      const cleanCtx: EvalContext = {
        auth: null,
        data: new DataSnapshot(null),
        newData: new DataSnapshot(null),
        root: new DataSnapshot(null),
        now: 777,
        pathVariableBindings: {},
      };

      // Expression that triggers a runtime method call error
      expect(() => {
        evaluateRtdbExpression("data.nonExistentMethod('bad')", toxicCtx);
      }).toThrow('Unknown DataSnapshot method: nonExistentMethod');

      // Immediately run clean unauthenticated evaluation
      expect(evaluateRtdbExpression('auth == null', cleanCtx)).toBe(true);
      expect(evaluateRtdbExpression('auth.uid', cleanCtx)).toBeNull();
      expect(evaluateRtdbExpression('now', cleanCtx)).toBe(777);
      expect(evaluateRtdbExpression('$toxic', cleanCtx)).toBeUndefined();
    });

    test('empty or partial EvalContext does not crash or access residual state', () => {
      const bareEmptyCtx = {} as EvalContext;

      expect(evaluateRtdbExpression('auth == null', bareEmptyCtx)).toBe(true);
      expect(evaluateRtdbExpression('auth.uid', bareEmptyCtx)).toBeNull();
      expect(evaluateRtdbExpression('$undefinedVar', bareEmptyCtx)).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TRACK A — R2: Production Equality Syntax & Linter Alignment
  // ──────────────────────────────────────────────────────────────────────────
  describe('R2: Strict Equality Rejection & Linter Alignment', () => {
    describe('Parser strictly rejects === in all syntactic positions', () => {
      const strictEqExpressions = [
        // Root / basic positions
        'auth.uid === "user123"',
        '"user123" === auth.uid',
        '1 === 1',
        'true === true',
        'null === null',
        'data.val() === 42',
        // Parenthesized
        '(auth.uid === "user123")',
        '((auth.uid === "user123"))',
        // Logical AND / OR compositions
        'auth != null && auth.uid === "user123"',
        'auth.uid === "user123" && data.exists()',
        'auth == null || auth.uid === "user123"',
        'auth.uid === "user123" || auth.uid === "admin"',
        // Ternary operators
        'auth != null ? auth.uid === "user123" : false',
        'auth.uid === "user123" ? true : false',
        'true ? 1 === 1 : 2 === 2',
        // Method argument positions
        "data.child(auth.uid === 'admin' ? 'admin' : 'user').exists()",
        "newData.val().contains(auth.uid === 'x' ? 'a' : 'b')",
        // Chained / compound comparisons
        'a === b === c',
        'a == b === c',
        'a === b == c',
        // Arithmetic combinations
        'data.val() + 1 === 2',
        'now - 1000 === 0',
        'data.val() === 2 * 3',
        // Unary operand combinations
        '!data.val() === false',
        '-data.val() === -1',
        // Malformed / boundary operators
        '=== a',
        'a ===',
        '!=== a',
        'a === = b',
        // Whitespace variations
        'auth.uid=== "user123"',
        'auth.uid ===  "user123"',
        'auth.uid   ===   "user123"',
        'auth.uid \n === \n "user123"',
        'auth.uid \t === \t "user123"',
      ];

      for (const expr of strictEqExpressions) {
        test(`rejects strict equality syntax: ${JSON.stringify(expr)}`, () => {
          const parsed = parseExpression(expr);
          expect(parsed.valid).toBe(false);
          expect(parsed.errors.length).toBeGreaterThan(0);
          expect(parsed.errors[0].code).toBe('PARSE_ERROR');
        });
      }
    });

    describe('Parser strictly rejects !== in all syntactic positions', () => {
      const strictNeqExpressions = [
        // Root / basic positions
        'auth.uid !== "user123"',
        'auth !== null',
        'data.val() !== null',
        '1 !== 2',
        // Parenthesized
        '(auth !== null)',
        '((data.val() !== 0))',
        // Logical AND / OR compositions
        'auth != null && auth.uid !== "banned"',
        'data.val() !== null || newData.val() !== null',
        // Ternary operators
        'auth !== null ? true : false',
        'true ? auth !== null : false',
        // Method argument positions
        "data.child(auth !== null ? 'user' : 'guest').exists()",
        // Chained comparisons
        'a !== b !== c',
        'a != b !== c',
        'a !== b != c',
        // Malformed operators
        '!== a',
        'a !==',
        'a !== = b',
        // Whitespace variations
        'auth!== null',
        'auth !==  null',
        'auth \n !== \n null',
      ];

      for (const expr of strictNeqExpressions) {
        test(`rejects strict inequality syntax: ${JSON.stringify(expr)}`, () => {
          const parsed = parseExpression(expr);
          expect(parsed.valid).toBe(false);
          expect(parsed.errors.length).toBeGreaterThan(0);
          expect(parsed.errors[0].code).toBe('PARSE_ERROR');
        });
      }
    });

    describe('Parser cleanly accepts standard == and != in all syntactic positions', () => {
      const validEqualityExpressions = [
        'auth.uid == "user123"',
        'auth != null',
        '(auth.uid == "user123")',
        'auth != null && auth.uid == "user123"',
        'auth == null || auth.uid != "banned"',
        'auth != null ? auth.uid == "admin" : false',
        'data.child("count").val() + 1 == 2',
        'data.child(auth.uid == "admin" ? "a" : "b").exists()',
        'data.val() == "val1" || data.val() != "val2"',
      ];

      for (const expr of validEqualityExpressions) {
        test(`accepts valid equality syntax: ${JSON.stringify(expr)}`, () => {
          const parsed = parseExpression(expr);
          expect(parsed.valid).toBe(true);
          expect(parsed.errors).toHaveLength(0);
        });
      }
    });

    describe('Linter emits zero LOOSE_EQUALITY and LOOSE_INEQUALITY warnings', () => {
      const expressionsToLint = [
        'auth.uid == "user123"',
        'auth != null',
        'data.child("status").val() == "active"',
        'data.child("status").val() != "deleted"',
        'auth != null && data.child("owner").val() == auth.uid',
        'data.child("count").val() == 0',
        'newData.child("val").val() == data.child("val").val()',
      ];

      for (const expr of expressionsToLint) {
        test(`zero equality warnings on: ${JSON.stringify(expr)}`, () => {
          const warnings = lintExpression(expr, 'read');
          const eqWarnings = warnings.filter(
            (w) => w.code === 'LOOSE_EQUALITY' || w.code === 'LOOSE_INEQUALITY',
          );
          expect(eqWarnings).toHaveLength(0);
        });
      }

      test('linter still preserves existing valid linter warnings (HARDCODED_TRUE/FALSE, DATA_IN_WRITE)', () => {
        const trueWarnings = lintExpression('true');
        expect(trueWarnings.some((w) => w.code === 'HARDCODED_TRUE')).toBe(true);

        const falseWarnings = lintExpression('false');
        expect(falseWarnings.some((w) => w.code === 'HARDCODED_FALSE')).toBe(true);

        const dataInWriteWarnings = lintExpression('data.val() == "write_test"', 'write');
        expect(dataInWriteWarnings.some((w) => w.code === 'DATA_IN_WRITE')).toBe(true);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TRACK A — R3: Unary Negation Fail-Closed Evaluation on Non-Booleans
  // ──────────────────────────────────────────────────────────────────────────
  describe('R3: Unary Negation Fail-Closed on Non-Booleans', () => {
    const mockCtx: EvalContext = {
      auth: { uid: 'alice', token: { role: 'admin', unassigned: undefined, nullField: null } },
      data: new DataSnapshot({
        numZero: 0,
        numPos: 42,
        numNeg: -1,
        emptyStr: '',
        str: 'hello',
        boolTrue: true,
        boolFalse: false,
        nullVal: null,
        obj: { a: 1 },
        arr: [1, 2, 3],
      }),
      newData: new DataSnapshot(null),
      root: new DataSnapshot(null),
      now: 1700000000000,
      pathVariableBindings: { $var: 'test' },
    };

    const unauthedCtx: EvalContext = {
      auth: null,
      data: new DataSnapshot(null),
      newData: new DataSnapshot(null),
      root: new DataSnapshot(null),
      now: 1700000000000,
      pathVariableBindings: {},
    };

    describe('Direct primitive and literal non-boolean values evaluate to false (fail-closed)', () => {
      const nonBooleanLiterals = [
        { label: '!0 (number zero)', expr: '!0' },
        { label: '!1 (positive number)', expr: '!1' },
        { label: '!-1 (negative number)', expr: '!-1' },
        { label: '!100.5 (floating point number)', expr: '!100.5' },
        { label: '!"" (empty string literal)', expr: '!""' },
        { label: '!"hello" (non-empty string literal)', expr: '!"hello"' },
        { label: '!"0" (string containing zero)', expr: '!"0"' },
        { label: '!"false" (string containing "false")', expr: '!"false"' },
        { label: '!"true" (string containing "true")', expr: '!"true"' },
        { label: '!null (null literal)', expr: '!null' },
        { label: '![] (array literal)', expr: '![]' },
        { label: '![1, 2] (non-empty array literal)', expr: '![1, 2]' },
        { label: '!/regex/ (regex literal)', expr: '!/abc/' },
      ];

      for (const { label, expr } of nonBooleanLiterals) {
        test(`${label} evaluates to false`, () => {
          const result = evaluateRtdbExpression(expr, mockCtx);
          expect(result).toBe(false);
        });
      }
    });

    describe('Snapshot nodes and properties with non-boolean values evaluate to false', () => {
      const nonBooleanDataCases = [
        { label: '!data.child("numZero").val() (0 value)', expr: "!data.child('numZero').val()" },
        { label: '!data.child("numPos").val() (42 value)', expr: "!data.child('numPos').val()" },
        { label: '!data.child("numNeg").val() (-1 value)', expr: "!data.child('numNeg').val()" },
        { label: '!data.child("emptyStr").val() ("" value)', expr: "!data.child('emptyStr').val()" },
        { label: '!data.child("str").val() ("hello" value)', expr: "!data.child('str').val()" },
        { label: '!data.child("nullVal").val() (null value)', expr: "!data.child('nullVal').val()" },
        { label: '!data.child("obj").val() (object value)', expr: "!data.child('obj').val()" },
        { label: '!data.child("arr").val() (array value)', expr: "!data.child('arr').val()" },
        { label: '!data (DataSnapshot object itself)', expr: '!data' },
        { label: '!data.child("numZero") (DataSnapshot)', expr: "!data.child('numZero')" },
        { label: '!data.child("nonexistent").val() (missing node val)', expr: "!data.child('nonexistent').val()" },
        { label: '!data.child("a/b/c").val() (deep missing node val)', expr: "!data.child('a/b/c').val()" },
        { label: '!data.parent() (root parent is null)', expr: '!data.parent()' },
        { label: '!data.getPriority() (null priority)', expr: '!data.getPriority()' },
      ];

      for (const { label, expr } of nonBooleanDataCases) {
        test(`${label} evaluates to false`, () => {
          const result = evaluateRtdbExpression(expr, mockCtx);
          expect(result).toBe(false);
        });
      }
    });

    describe('Auth context non-boolean evaluation evaluates to false', () => {
      test('!auth evaluates to false when authenticated (SimulatedAuth object)', () => {
        expect(evaluateRtdbExpression('!auth', mockCtx)).toBe(false);
      });

      test('!auth evaluates to false when unauthenticated (null auth)', () => {
        expect(evaluateRtdbExpression('!auth', unauthedCtx)).toBe(false);
      });

      test('!auth.uid evaluates to false when authenticated (string uid)', () => {
        expect(evaluateRtdbExpression('!auth.uid', mockCtx)).toBe(false);
      });

      test('!auth.uid evaluates to false when unauthenticated (null safeMemberRead)', () => {
        expect(evaluateRtdbExpression('!auth.uid', unauthedCtx)).toBe(false);
      });

      test('!auth.token evaluates to false (token object)', () => {
        expect(evaluateRtdbExpression('!auth.token', mockCtx)).toBe(false);
      });

      test('!auth.token.role evaluates to false when string role ("admin")', () => {
        expect(evaluateRtdbExpression('!auth.token.role', mockCtx)).toBe(false);
      });

      test('!auth.token.unassigned evaluates to false when undefined claim', () => {
        expect(evaluateRtdbExpression('!auth.token.unassigned', mockCtx)).toBe(false);
      });

      test('!auth.token.nullField evaluates to false when null claim', () => {
        expect(evaluateRtdbExpression('!auth.token.nullField', mockCtx)).toBe(false);
      });

      test('!auth.token.missingProperty evaluates to false when completely absent', () => {
        expect(evaluateRtdbExpression('!auth.token.missingProperty', mockCtx)).toBe(false);
      });
    });

    describe('Snapshot string methods returning non-boolean evaluated under negation evaluate to false', () => {
      test('!data.child("str").val().toLowerCase() evaluates to false', () => {
        expect(evaluateRtdbExpression("!data.child('str').val().toLowerCase()", mockCtx)).toBe(false);
      });

      test('!data.child("str").val().replace(...) evaluates to false', () => {
        expect(evaluateRtdbExpression("!data.child('str').val().replace('h', 'j')", mockCtx)).toBe(false);
      });

      test('!data.child("str").val().length evaluates to false', () => {
        expect(evaluateRtdbExpression("!data.child('str').val().length", mockCtx)).toBe(false);
      });
    });

    describe('Legitimate boolean values and boolean predicates are correctly negated', () => {
      test('!true evaluates to false', () => {
        expect(evaluateRtdbExpression('!true', mockCtx)).toBe(false);
        expect(evaluateRtdbExpression("!data.child('boolTrue').val()", mockCtx)).toBe(false);
      });

      test('!false evaluates to true', () => {
        expect(evaluateRtdbExpression('!false', mockCtx)).toBe(true);
        expect(evaluateRtdbExpression("!data.child('boolFalse').val()", mockCtx)).toBe(true);
      });

      test('negating boolean snapshot methods works correctly', () => {
        // exists()
        expect(evaluateRtdbExpression('!data.exists()', mockCtx)).toBe(false);
        expect(evaluateRtdbExpression("!data.child('nonexistent').exists()", mockCtx)).toBe(true);

        // hasChild()
        expect(evaluateRtdbExpression("!data.hasChild('str')", mockCtx)).toBe(false);
        expect(evaluateRtdbExpression("!data.hasChild('nonexistent')", mockCtx)).toBe(true);

        // hasChildren()
        expect(evaluateRtdbExpression('!data.hasChildren()', mockCtx)).toBe(false);
        expect(evaluateRtdbExpression("!data.child('nonexistent').hasChildren()", mockCtx)).toBe(true);

        // isString(), isNumber(), isBoolean()
        expect(evaluateRtdbExpression("!data.child('str').isString()", mockCtx)).toBe(false);
        expect(evaluateRtdbExpression("!data.child('str').isNumber()", mockCtx)).toBe(true);
        expect(evaluateRtdbExpression("!data.child('numPos').isNumber()", mockCtx)).toBe(false);
        expect(evaluateRtdbExpression("!data.child('numPos').isBoolean()", mockCtx)).toBe(true);
        expect(evaluateRtdbExpression("!data.child('boolTrue').isBoolean()", mockCtx)).toBe(false);
        expect(evaluateRtdbExpression("!data.child('boolTrue').isString()", mockCtx)).toBe(true);

        // String predicates: contains(), beginsWith(), endsWith(), matches()
        expect(evaluateRtdbExpression("!data.child('str').val().contains('ell')", mockCtx)).toBe(false);
        expect(evaluateRtdbExpression("!data.child('str').val().contains('xyz')", mockCtx)).toBe(true);
        expect(evaluateRtdbExpression("!data.child('str').val().beginsWith('hel')", mockCtx)).toBe(false);
        expect(evaluateRtdbExpression("!data.child('str').val().beginsWith('xyz')", mockCtx)).toBe(true);
        expect(evaluateRtdbExpression("!data.child('str').val().endsWith('llo')", mockCtx)).toBe(false);
        expect(evaluateRtdbExpression("!data.child('str').val().endsWith('xyz')", mockCtx)).toBe(true);
        expect(evaluateRtdbExpression("!data.child('str').val().matches(/hello/)", mockCtx)).toBe(false);
        expect(evaluateRtdbExpression("!data.child('str').val().matches(/xyz/)", mockCtx)).toBe(true);
      });
    });

    describe('Compound expressions with non-boolean negation cannot grant false access', () => {
      test('!data.child("missing").val() && true evaluates to false', () => {
        expect(evaluateRtdbExpression("!data.child('missing').val() && true", mockCtx)).toBe(false);
      });

      test('true && !data.child("missing").val() evaluates to false', () => {
        expect(evaluateRtdbExpression("true && !data.child('missing').val()", mockCtx)).toBe(false);
      });

      test('!data.child("missing").val() || false evaluates to false', () => {
        expect(evaluateRtdbExpression("!data.child('missing').val() || false", mockCtx)).toBe(false);
      });

      test('!data.child("missing").val() ? true : false evaluates to false', () => {
        expect(evaluateRtdbExpression("!data.child('missing').val() ? true : false", mockCtx)).toBe(false);
      });

      test('!auth && true in unauthenticated context evaluates to false (cannot bypass auth check)', () => {
        expect(evaluateRtdbExpression('!auth && true', unauthedCtx)).toBe(false);
      });
    });
  });
});
