import { describe, expect, test } from 'bun:test';
import {
  DataSnapshot,
  RtdbRuleRuntimeError,
  evaluateRtdbExpression,
  type EvalContext,
} from '../../../src/rtdb/grammar/simulator.js';
import { compileRtdbRules } from '../../../src/rtdb/compiled-rules.js';
import { SimulateHandler, collectAncestors } from '../../../src/rtdb/simulation/handler.js';
import { rtdbRules } from '../../../src/api/rtdb.js';

const NOT_BOOLEAN_MESSAGE = '! only operates on booleans.';

function makeCtx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    auth: null,
    data: new DataSnapshot({
      str: 'hello',
      emptyStr: '',
      num: 42,
      zero: 0,
      obj: { nested: true },
      boolTrue: true,
      boolFalse: false,
      nil: null,
    }),
    newData: new DataSnapshot({ val: 'proposed' }),
    root: new DataSnapshot({}),
    now: 1_700_000_000_000,
    pathVariableBindings: {},
    ...overrides,
  };
}

describe('RTDB UnaryExpr_not fail-closed semantics', () => {
  const nonBooleanExprs = [
    'null',
    '0',
    '1',
    '""',
    '"hello"',
    "data.child('missing').val()",
    "data.child('str').val()",
    "data.child('emptyStr').val()",
    "data.child('num').val()",
    "data.child('zero').val()",
    "data.child('obj').val()",
    'data',
    'newData',
    'root',
    'auth',
    '$unbound',
  ];

  test('throws RtdbRuleRuntimeError with oracle message for every non-boolean operand of !', () => {
    const ctx = makeCtx({ auth: { uid: 'u1', token: {} } });
    for (const operand of nonBooleanExprs) {
      let caught: unknown;
      try {
        evaluateRtdbExpression(`!${operand}`, ctx);
      } catch (err) {
        caught = err;
      }
      expect(caught, `!${operand}`).toBeInstanceOf(RtdbRuleRuntimeError);
      expect((caught as Error).message, `!${operand}`).toBe(NOT_BOOLEAN_MESSAGE);
    }
  });

  test('closes false-ALLOW compositions (!x) || true, !!x, (!x) == false, (!x) ? false : true', () => {
    const ctx = makeCtx({ auth: { uid: 'u1', token: {} } });
    for (const operand of nonBooleanExprs) {
      const expressions = [
        `(!${operand}) || true`,
        `!!${operand}`,
        `(!${operand}) == false`,
        `(!${operand}) === false`,
        `(!${operand}) != true`,
        `(!${operand}) ? false : true`,
        `(!${operand}) && false`,
      ];
      for (const expr of expressions) {
        expect(() => evaluateRtdbExpression(expr, ctx), expr).toThrow(NOT_BOOLEAN_MESSAGE);
      }
    }
  });

  test('preserves valid boolean negation and left-to-right short-circuiting', () => {
    const ctx = makeCtx();
    expect(evaluateRtdbExpression('!true', ctx)).toBe(false);
    expect(evaluateRtdbExpression('!false', ctx)).toBe(true);
    expect(evaluateRtdbExpression('!!true', ctx)).toBe(true);
    expect(evaluateRtdbExpression('!!false', ctx)).toBe(false);
    expect(evaluateRtdbExpression("!data.child('boolTrue').val()", ctx)).toBe(false);
    expect(evaluateRtdbExpression("!data.child('boolFalse').val()", ctx)).toBe(true);
    expect(evaluateRtdbExpression('!data.exists()', ctx)).toBe(false);
    expect(evaluateRtdbExpression("!data.child('missing').exists()", ctx)).toBe(true);
    expect(evaluateRtdbExpression("true || (!data.child('str').val())", ctx)).toBe(true);
    expect(evaluateRtdbExpression("false && (!data.child('str').val())", ctx)).toBe(false);
  });

  test('fails closed across .read, .write, and .validate rules in SimulateHandler and rtdbRules.simulate', () => {
    // Direct SimulateHandler runtime check with parsed.valid=true exercises
    // evaluateRule -> UnaryExpr_not -> RtdbRuleRuntimeError -> ERROR verdict.
    const runtimeExpr = (raw: string) => ({
      raw,
      parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: [] },
    });
    const runtimeTree = {
      path: '/',
      pathVariables: [],
      children: [
        { path: '/orBypass', pathVariables: [], read: runtimeExpr('(!data.val()) || true'), children: [] },
        { path: '/doubleNot', pathVariables: [], read: runtimeExpr('!!data.val()'), children: [] },
        { path: '/eqFalse', pathVariables: [], read: runtimeExpr('(!data.val()) == false'), children: [] },
        { path: '/snapshotNot', pathVariables: [], read: runtimeExpr('(!data) || true'), children: [] },
        { path: '/writeBypass', pathVariables: [], write: runtimeExpr('(!newData.val()) || true'), children: [] },
        {
          path: '/validateBypass',
          pathVariables: [],
          write: runtimeExpr('true'),
          validate: runtimeExpr('(!newData.val()) || true'),
          children: [],
        },
        { path: '/validBool', pathVariables: [], read: runtimeExpr('(!data.val()) || false'), children: [] },
      ],
    };

    const handler = new SimulateHandler();
    const denyCases = [
      { operation: 'read' as const, path: '/orBypass', mockData: { orBypass: 'text' } },
      { operation: 'read' as const, path: '/orBypass', mockData: { orBypass: 0 } },
      { operation: 'read' as const, path: '/orBypass', mockData: {} },
      { operation: 'read' as const, path: '/doubleNot', mockData: { doubleNot: 'text' } },
      { operation: 'read' as const, path: '/doubleNot', mockData: {} },
      { operation: 'read' as const, path: '/eqFalse', mockData: { eqFalse: 123 } },
      { operation: 'read' as const, path: '/snapshotNot', mockData: { snapshotNot: true } },
      { operation: 'write' as const, path: '/writeBypass', mockData: {}, newData: 'text' },
      { operation: 'write' as const, path: '/validateBypass', mockData: {}, newData: 'text' },
    ];

    for (const testCase of denyCases) {
      const result = handler.execute(runtimeTree, { ...testCase, auth: null });
      expect(result.success, testCase.path).toBe(true);
      if (result.success) {
        expect(result.data.allowed, testCase.path).toBe(false);
        expect(result.data.unsupported, testCase.path).not.toBe(true);
        const errorEntry = result.data.trace.find((entry) => entry.verdict === 'ERROR');
        expect(errorEntry?.message, testCase.path).toBe(NOT_BOOLEAN_MESSAGE);
      }
    }

    const allowBool = handler.execute(runtimeTree, {
      operation: 'read',
      path: '/validBool',
      auth: null,
      mockData: { validBool: false },
    });
    expect(allowBool.success).toBe(true);
    if (allowBool.success) {
      expect(allowBool.data.allowed).toBe(true);
    }

    const denyBool = handler.execute(runtimeTree, {
      operation: 'read',
      path: '/validBool',
      auth: null,
      mockData: { validBool: true },
    });
    expect(denyBool.success).toBe(true);
    if (denyBool.success) {
      expect(denyBool.data.allowed).toBe(false);
    }

    // End-to-end rtdbRules.simulate still grants valid boolean negation and never grants invalid `!data.val()`.
    const compiled = rtdbRules({
      rules: {
        validExists: { '.read': '!data.exists()' },
        invalidNot: { '.read': '(!data.val()) || true' },
      },
    });
    const summary = compiled.simulate([
      { expectation: 'ALLOW', operation: 'read', path: '/validExists', data: {} },
      { expectation: 'DENY', operation: 'read', path: '/validExists', data: { validExists: 'present' } },
      { expectation: 'DENY', operation: 'read', path: '/invalidNot', data: { invalidNot: 'text' } },
    ]);
    expect(summary.cases[0]?.decision).toBe('ALLOW');
    expect(summary.cases[1]?.decision).toBe('DENY');
    expect(summary.cases[2]?.decision).not.toBe('ALLOW');
  });

  test('unary minus also throws RtdbRuleRuntimeError on non-numeric operands', () => {
    const ctx = makeCtx();
    for (const operand of ['null', '"42"', 'true', 'data', "data.child('str').val()"]) {
      expect(() => evaluateRtdbExpression(`-${operand}`, ctx), `-${operand}`).toThrow(
        RtdbRuleRuntimeError,
      );
      expect(() => evaluateRtdbExpression(`(-${operand} == 0) || true`, ctx), operand).toThrow(
        RtdbRuleRuntimeError,
      );
    }
    expect(evaluateRtdbExpression("-data.child('num').val()", ctx)).toBe(-42);
  });
});

describe('RTDB null-prototype $ wildcard bindings', () => {
  const prototypeNames = [
    '$constructor',
    '$toString',
    '$valueOf',
    '$hasOwnProperty',
    '$isPrototypeOf',
    '$propertyIsEnumerable',
    '$toLocaleString',
    '$__proto__',
  ];

  test('unbound prototype-named $ variables return undefined even with a plain-prototype bindings map', () => {
    const plainCtx = makeCtx({ pathVariableBindings: { $uid: 'alice' } });
    for (const name of prototypeNames) {
      expect(evaluateRtdbExpression(name, plainCtx), name).toBeUndefined();
    }
    // Bound keys with or without leading '$' still resolve via own-property lookup.
    expect(evaluateRtdbExpression('$uid', plainCtx)).toBe('alice');
    const bareCtx = makeCtx({ pathVariableBindings: { itemId: 'item-7' } });
    expect(evaluateRtdbExpression('$itemId', bareCtx)).toBe('item-7');
  });

  test('collectAncestors produces null-prototype pathVariableBindings objects', () => {
    const compiled = compileRtdbRules({
      rules: {
        users: {
          $uid: {
            '.read': '$uid == auth.uid',
          },
        },
      },
    });
    const ancestors = collectAncestors(compiled, ['users', 'alice']);
    for (const ancestor of ancestors) {
      expect(Object.getPrototypeOf(ancestor.pathVariableBindings)).toBeNull();
    }
    const leaf = ancestors[ancestors.length - 1];
    expect(leaf?.pathVariableBindings.$uid).toBe('alice');
    expect('constructor' in (leaf?.pathVariableBindings ?? {})).toBe(false);
    expect('toString' in (leaf?.pathVariableBindings ?? {})).toBe(false);
  });

  test('unbound prototype-named $ variables never expose Object.prototype methods or gadgets in SimulateHandler', () => {
    const compiled = compileRtdbRules({
      rules: {
        protoGadget: { '.read': "$__proto__.toString != null" },
        ctorCall: { '.read': "$constructor == auth.uid" },
        toStrLen: { '.read': '$toString.length > 0' },
        notProto: { '.read': '(!$__proto__) || true' },
        validBound: {
          $uid: {
            '.read': '$uid == auth.uid',
          },
        },
      },
    });
    const handler = new SimulateHandler();

    for (const path of ['/protoGadget', '/ctorCall', '/toStrLen', '/notProto']) {
      const result = handler.execute(compiled, {
        operation: 'read',
        path,
        auth: { uid: 'alice' },
        mockData: {},
      });
      expect(result.success, path).toBe(true);
      if (result.success) {
        expect(result.data.allowed, path).toBe(false);
      }
    }

    const allowed = handler.execute(compiled, {
      operation: 'read',
      path: '/validBound/alice',
      auth: { uid: 'alice' },
      mockData: {},
    });
    expect(allowed.success).toBe(true);
    if (allowed.success) {
      expect(allowed.data.allowed).toBe(true);
      expect(allowed.data.pathVariableBindings.$uid).toBe('alice');
    }

    const denied = handler.execute(compiled, {
      operation: 'read',
      path: '/validBound/alice',
      auth: { uid: 'bob' },
      mockData: {},
    });
    expect(denied.success).toBe(true);
    if (denied.success) {
      expect(denied.data.allowed).toBe(false);
    }
  });

  test('explicitly bound $constructor or $__proto__ wildcard resolves to its path segment without polluting Object.prototype', () => {
    const compiled = compileRtdbRules({
      rules: {
        items: {
          $__proto__: {
            '.read': "$__proto__ == 'safe-segment'",
          },
        },
      },
    });
    const handler = new SimulateHandler();
    const matchRes = handler.execute(compiled, {
      operation: 'read',
      path: '/items/safe-segment',
      auth: null,
      mockData: {},
    });
    expect(matchRes.success).toBe(true);
    if (matchRes.success) {
      expect(matchRes.data.allowed).toBe(true);
      expect(Object.getPrototypeOf(matchRes.data.pathVariableBindings)).toBeNull();
      expect(matchRes.data.pathVariableBindings.$__proto__).toBe('safe-segment');
    }
    const mismatchRes = handler.execute(compiled, {
      operation: 'read',
      path: '/items/other-segment',
      auth: null,
      mockData: {},
    });
    expect(mismatchRes.success).toBe(true);
    if (mismatchRes.success) {
      expect(mismatchRes.data.allowed).toBe(false);
    }
  });
});
