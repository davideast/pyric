import { describe, test, expect } from 'bun:test';
import { evaluate, type SimulationContext, type SimResource } from '../../../src/rules/simulator/evaluator.js';
import type { Expression, FunctionDef } from '../../../src/rules/grammar/FirestoreAST.js';
import { Path } from '../../../src/rules/simulator/wrappers/path.js';
import { Timestamp } from '../../../src/rules/simulator/wrappers/timestamp.js';

function mkRes(data: Record<string, unknown>, id = 'doc1'): SimResource {
  return { data, id, __name__: Path.fromString(`/test/${id}`) };
}

// ═══ Helpers ═══

function lit(value: string | number | boolean | null): Expression {
  return { type: 'literal', value, raw: String(value) };
}
// RULES-B5: a FLOAT literal — the grammar marks float-ness via a `.` in `raw`
// (the `number_float` ohm rule). `litFloat(1)` models the source `1.0`, which
// `lit(1)` (raw "1") cannot express because `String(1.0) === "1"`.
function litFloat(value: number): Expression {
  const raw = Number.isInteger(value) ? `${value}.0` : String(value);
  return { type: 'literal', value, raw };
}
function isType(value: Expression, typeName: string): Expression {
  return { type: 'isExpr', value, typeName };
}
function id(name: string): Expression {
  return { type: 'identifier', name };
}
function binOp(op: string, left: Expression, right: Expression): Expression {
  return { type: 'binaryOp', op, left, right };
}
function member(obj: Expression, prop: string): Expression {
  return { type: 'memberAccess', object: obj, property: prop };
}
function bracket(obj: Expression, index: Expression): Expression {
  return { type: 'bracketAccess', object: obj, index };
}
function call(name: string, args: Expression[] = []): Expression {
  return { type: 'functionCall', name, args };
}
function methodCall(obj: Expression, method: string, args: Expression[] = []): Expression {
  return { type: 'methodCall', object: obj, method, args };
}
function inExpr(element: Expression, collection: Expression): Expression {
  return { type: 'inExpr', element, collection };
}
function unaryOp(op: string, operand: Expression): Expression {
  return { type: 'unaryOp', op, operand };
}
function ternary(cond: Expression, then: Expression, else_: Expression): Expression {
  return { type: 'ternary', condition: cond, consequent: then, alternate: else_ };
}
function listLit(elements: Expression[]): Expression {
  return { type: 'listLiteral', elements };
}

function baseCtx(overrides: Partial<SimulationContext> = {}): SimulationContext {
  return {
    request: {
      auth: { uid: 'user1', token: {} },
      resource: { data: {} },
      method: 'update',
      path: Path.fromString('/test/doc1'),
      query: {},
      time: Timestamp.fromMillis(Date.now()),
    },
    resource: mkRes({}),
    mockDocuments: new Map(),
    pathVariables: {},
    functions: new Map(),
    database: '(default)',
    afterStatePath: Path.fromString('/test/doc1'),
    afterState: null,
    existsAfter: false,
    ...overrides,
  };
}

// ═══ Layer 1: Literals, identifiers, binary ops ═══

describe('Layer 1: Basics', () => {
  test('string literal', () => {
    expect(evaluate(lit('hello'), baseCtx())).toBe('hello');
  });

  test('number literal', () => {
    expect(evaluate(lit(42), baseCtx())).toBe(42);
  });

  test('boolean literal', () => {
    expect(evaluate(lit(true), baseCtx())).toBe(true);
  });

  test('null literal', () => {
    expect(evaluate(lit(null), baseCtx())).toBe(null);
  });

  test('request.auth != null (authenticated)', () => {
    const expr = binOp('!=', member(member(id('request'), 'auth'), 'uid'), lit(null));
    expect(evaluate(expr, baseCtx())).toBe(true);
  });

  test('request.auth == null (unauthenticated)', () => {
    const ctx = baseCtx({ request: { ...baseCtx().request, auth: null } });
    const expr = binOp('==', member(id('request'), 'auth'), lit(null));
    expect(evaluate(expr, ctx)).toBe(true);
  });

  test('&& short-circuit — false && anything = false', () => {
    // The right side accesses a non-existent path that would error without short-circuit
    const expr = binOp('&&', lit(false), member(member(id('nonexistent'), 'foo'), 'bar'));
    expect(evaluate(expr, baseCtx())).toBe(false);
  });

  test('|| short-circuit — true || anything = true', () => {
    const expr = binOp('||', lit(true), member(member(id('nonexistent'), 'foo'), 'bar'));
    expect(evaluate(expr, baseCtx())).toBe(true);
  });

  test('== with strings', () => {
    expect(evaluate(binOp('==', lit('host'), lit('host')), baseCtx())).toBe(true);
    expect(evaluate(binOp('==', lit('host'), lit('guest')), baseCtx())).toBe(false);
  });

  test('arithmetic', () => {
    expect(evaluate(binOp('+', lit(1), lit(2)), baseCtx())).toBe(3);
    expect(evaluate(binOp('-', lit(5), lit(3)), baseCtx())).toBe(2);
  });

  test('unary not', () => {
    expect(evaluate(unaryOp('!', lit(true)), baseCtx())).toBe(false);
    expect(evaluate(unaryOp('!', lit(false)), baseCtx())).toBe(true);
  });

  test('ternary', () => {
    expect(evaluate(ternary(lit(true), lit('yes'), lit('no')), baseCtx())).toBe('yes');
    expect(evaluate(ternary(lit(false), lit('yes'), lit('no')), baseCtx())).toBe('no');
  });

  test('firestore#138a requires boolean control-flow operands', () => {
    expect(() => evaluate(binOp('&&', lit(1), lit(true)), baseCtx()))
      .toThrow(/boolean/);
    expect(() => evaluate(binOp('||', lit(0), lit(false)), baseCtx()))
      .toThrow(/boolean/);
    expect(() => evaluate(ternary(lit(1), lit('yes'), lit('no')), baseCtx()))
      .toThrow(/boolean/);
  });
});

// ═══ Layer 2: Member access, bracket access, in ═══

describe('Layer 2: Access patterns', () => {
  test('resource.data.field', () => {
    const ctx = baseCtx({ resource: mkRes({ status: 'playing' }) });
    const expr = member(member(id('resource'), 'data'), 'status');
    expect(evaluate(expr, ctx)).toBe('playing');
  });

  test('resource.data[dynamicKey] — field value as key', () => {
    const ctx = baseCtx({
      resource: mkRes({ moveFrom: 'e2', e2: 'P' }),
    });
    // resource.data[resource.data.moveFrom] → resource.data['e2'] → 'P'
    const expr = bracket(member(id('resource'), 'data'), member(member(id('resource'), 'data'), 'moveFrom'));
    expect(evaluate(expr, ctx)).toBe('P');
  });

  test('request.resource.data.field', () => {
    const ctx = baseCtx();
    ctx.request.resource.data = { moveTo: 'e4' };
    const expr = member(member(member(id('request'), 'resource'), 'data'), 'moveTo');
    expect(evaluate(expr, ctx)).toBe('e4');
  });

  test('value in map — key exists', () => {
    const ctx = baseCtx({ resource: mkRes({ moves: { e3: true, e4: true } }) });
    // 'e3' in resource.data.moves
    const expr = inExpr(lit('e3'), member(member(id('resource'), 'data'), 'moves'));
    expect(evaluate(expr, ctx)).toBe(true);
  });

  test('value in map — key missing', () => {
    const ctx = baseCtx({ resource: mkRes({ moves: { e3: true } }) });
    const expr = inExpr(lit('e5'), member(member(id('resource'), 'data'), 'moves'));
    expect(evaluate(expr, ctx)).toBe(false);
  });

  test('value in null/undefined — false, no error', () => {
    const expr = inExpr(lit('x'), lit(null));
    expect(evaluate(expr, baseCtx())).toBe(false);
  });

  // RULES-B2 FLIP: these two previously asserted null-on-null-access — the
  // exact bug. Production (CEL field/index selection has no overload for
  // null) ERRORS on `null.foo` / `null['foo']` and DENYs the request.
  // Confirmed: Firebase docs (rules-conditions / rules-fields) — "Calling
  // request.resource.data.foo on a document where foo doesn't exist results
  // in an error, and therefore any security rule making that call will deny
  // the request"; CEL spec field-selection has no null overload.
  test('bracket access on null — ERRORS (RULES-B2)', () => {
    const expr = bracket(lit(null), lit('foo'));
    expect(() => evaluate(expr, baseCtx())).toThrow(/null/);
  });

  test('member access on null — ERRORS (RULES-B2)', () => {
    const expr = member(lit(null) as Expression & { type: 'literal' }, 'foo');
    expect(() => evaluate(expr, baseCtx())).toThrow(/null/);
  });
});

// ═══ Layer 3: Function calls, let bindings ═══

describe('Layer 3: Functions', () => {
  test('user-defined function with no params', () => {
    const fn: FunctionDef = {
      name: 'isPlaying',
      parameters: [],
      exported: false,
      lets: [],
      body: binOp('==', member(member(id('resource'), 'data'), 'status'), lit('playing')),
    };
    const ctx = baseCtx({ resource: mkRes({ status: 'playing' }) });
    ctx.functions.set('isPlaying', fn);
    expect(evaluate(call('isPlaying'), ctx)).toBe(true);
  });

  test('user-defined function with parameter', () => {
    const fn: FunctionDef = {
      name: 'isOwner',
      parameters: ['userId'],
      exported: false,
      lets: [],
      body: binOp('==', member(member(id('request'), 'auth'), 'uid'), id('userId')),
    };
    const ctx = baseCtx();
    ctx.functions.set('isOwner', fn);
    expect(evaluate(call('isOwner', [lit('user1')]), ctx)).toBe(true);
    expect(evaluate(call('isOwner', [lit('user2')]), ctx)).toBe(false);
  });

  test('function with let bindings', () => {
    // function check() { let mf = request.resource.data.moveFrom; return mf == 'e2'; }
    const fn: FunctionDef = {
      name: 'check',
      parameters: [],
      exported: false,
      lets: [{ name: 'mf', value: member(member(member(id('request'), 'resource'), 'data'), 'moveFrom') }],
      body: binOp('==', id('mf'), lit('e2')),
    };
    const ctx = baseCtx();
    ctx.request.resource.data = { moveFrom: 'e2' };
    ctx.functions.set('check', fn);
    expect(evaluate(call('check'), ctx)).toBe(true);
  });

  test('function calling another function', () => {
    const isAuth: FunctionDef = {
      name: 'isAuth', parameters: [], exported: false, lets: [],
      body: binOp('!=', member(id('request'), 'auth'), lit(null)),
    };
    const isMyTurn: FunctionDef = {
      name: 'isMyTurn', parameters: [], exported: false, lets: [],
      body: binOp('&&', call('isAuth'), binOp('==', member(member(id('resource'), 'data'), 'currentTurn'), lit('host'))),
    };
    const ctx = baseCtx({ resource: mkRes({ currentTurn: 'host' }) });
    ctx.functions.set('isAuth', isAuth);
    ctx.functions.set('isMyTurn', isMyTurn);
    expect(evaluate(call('isMyTurn'), ctx)).toBe(true);
  });
});

// ═══ Layer 4: Method calls + MapDiff ═══

describe('Layer 4: MapDiff', () => {
  test('request.resource.data.diff(resource.data).affectedKeys().hasOnly()', () => {
    const ctx = baseCtx({
      resource: mkRes({ a: 1, b: 2, c: 3 }),
    });
    ctx.request.resource.data = { a: 1, b: 99, c: 3 }; // b changed

    // request.resource.data.diff(resource.data).affectedKeys().hasOnly(['b'])
    const diff = methodCall(
      member(member(id('request'), 'resource'), 'data'),
      'diff',
      [member(id('resource'), 'data')],
    );
    const affected = methodCall(diff, 'affectedKeys');
    const hasOnly = methodCall(affected, 'hasOnly', [listLit([lit('b')])]);

    expect(evaluate(hasOnly, ctx)).toBe(true);
  });

  test('affectedKeys includes added keys', () => {
    const ctx = baseCtx({ resource: mkRes({ a: 1 }) });
    ctx.request.resource.data = { a: 1, b: 2 };

    const diff = methodCall(member(member(id('request'), 'resource'), 'data'), 'diff', [member(id('resource'), 'data')]);
    const size = methodCall(methodCall(diff, 'affectedKeys'), 'size');
    expect(evaluate(size, ctx)).toBe(1);
  });

  test('hasOnly fails when extra keys affected', () => {
    const ctx = baseCtx({ resource: mkRes({ a: 1, b: 2 }) });
    ctx.request.resource.data = { a: 99, b: 88 };

    const diff = methodCall(member(member(id('request'), 'resource'), 'data'), 'diff', [member(id('resource'), 'data')]);
    const hasOnly = methodCall(methodCall(diff, 'affectedKeys'), 'hasOnly', [listLit([lit('a')])]);
    expect(evaluate(hasOnly, ctx)).toBe(false); // b also changed
  });

  test('hasOnly with dynamic field values', () => {
    const ctx = baseCtx({
      resource: mkRes({ a1: 'R', b1: 'N', moveFrom: '', moveTo: '', currentTurn: 'host' }),
    });
    ctx.request.resource.data = { a1: 'R', b1: '', moveFrom: 'b1', moveTo: 'c3', currentTurn: 'guest' };

    // hasOnly(['moveFrom', 'moveTo', 'currentTurn', request.resource.data.moveFrom, request.resource.data.moveTo])
    const diff = methodCall(member(member(id('request'), 'resource'), 'data'), 'diff', [member(id('resource'), 'data')]);
    const hasOnly = methodCall(
      methodCall(diff, 'affectedKeys'),
      'hasOnly',
      [listLit([
        lit('moveFrom'), lit('moveTo'), lit('currentTurn'),
        member(member(member(id('request'), 'resource'), 'data'), 'moveFrom'),
        member(member(member(id('request'), 'resource'), 'data'), 'moveTo'),
      ])],
    );
    expect(evaluate(hasOnly, ctx)).toBe(true);
  });
});

// ═══ Layer 5: get()/exists() ═══

describe('Layer 5: get()/exists()', () => {
  test('get() returns mock document data', () => {
    const ctx = baseCtx();
    ctx.mockDocuments.set('gameConfig/chess', { moves: { N: { b1: { c3: true } } } });

    // get(/databases/$(database)/documents/gameConfig/chess).data.moves.N.b1.c3
    const getCall = call('get', [{ type: 'pathLiteral', raw: '/databases/$(database)/documents/gameConfig/chess', segments: ['databases', '(default)', 'documents', 'gameConfig', 'chess'] }]);
    const result = member(member(member(member(member(getCall, 'data'), 'moves'), 'N'), 'b1'), 'c3');
    expect(evaluate(result, ctx)).toBe(true);
  });

  test('exists() returns true for mock document', () => {
    const ctx = baseCtx();
    ctx.mockDocuments.set('gameConfig/chess', {});
    const existsCall = call('exists', [{ type: 'pathLiteral', raw: '/databases/$(database)/documents/gameConfig/chess', segments: ['databases', '(default)', 'documents', 'gameConfig', 'chess'] }]);
    expect(evaluate(existsCall, ctx)).toBe(true);
  });

  test('exists() returns false for missing document', () => {
    const ctx = baseCtx();
    const existsCall = call('exists', [{ type: 'pathLiteral', raw: '/databases/$(database)/documents/nonexistent/doc', segments: ['databases', '(default)', 'documents', 'nonexistent', 'doc'] }]);
    expect(evaluate(existsCall, ctx)).toBe(false);
  });

  test('3-level nesting on get() result — config().moves[piece][from][to]', () => {
    const ctx = baseCtx();
    ctx.mockDocuments.set('gameConfig/chess', {
      moves: { N: { b1: { c3: true, a3: true } } },
    });
    ctx.resource.data = { b1: 'N' };
    ctx.request.resource.data = { moveFrom: 'b1', moveTo: 'c3' };

    // Simulate: config().moves[resource.data[moveFrom]][moveFrom][moveTo] == true
    // where config() = get(...).data
    const configFn: FunctionDef = {
      name: 'config', parameters: [], exported: false, lets: [],
      body: member(call('get', [{ type: 'pathLiteral', raw: '/databases/$(database)/documents/gameConfig/chess', segments: ['databases', '(default)', 'documents', 'gameConfig', 'chess'] }]), 'data'),
    };
    ctx.functions.set('config', configFn);

    const mf = member(member(member(id('request'), 'resource'), 'data'), 'moveFrom');
    const mt = member(member(member(id('request'), 'resource'), 'data'), 'moveTo');
    const piece = bracket(member(id('resource'), 'data'), mf);

    // config().moves[piece][mf][mt] == true
    const lookup = bracket(bracket(bracket(member(call('config'), 'moves'), piece), mf), mt);
    const expr = binOp('==', lookup, lit(true));

    expect(evaluate(expr, ctx)).toBe(true);
  });

  test('in operator on get() result — ks in config().moves[piece][pos]', () => {
    const ctx = baseCtx();
    ctx.mockDocuments.set('gameConfig/chess', {
      moves: { N: { f2: { d1: true, d3: true, e4: true, g4: true, h1: true, h3: true } } },
    });

    const configFn: FunctionDef = {
      name: 'cfg', parameters: [], exported: false, lets: [],
      body: member(call('get', [{ type: 'pathLiteral', raw: '/databases/$(database)/documents/gameConfig/chess', segments: ['databases', '(default)', 'documents', 'gameConfig', 'chess'] }]), 'data'),
    };
    ctx.functions.set('cfg', configFn);

    // 'e4' in cfg().moves.N.f2 → true (knight at f2 attacks e4)
    const attacks = member(member(member(call('cfg'), 'moves'), 'N'), 'f2');
    expect(evaluate(inExpr(lit('e4'), attacks), ctx)).toBe(true);

    // 'd5' in cfg().moves.N.f2 → false (knight at f2 doesn't attack d5)
    expect(evaluate(inExpr(lit('d5'), attacks), ctx)).toBe(false);
  });
});

// ═══ Integration: real rule patterns ═══

describe('Integration: real rule patterns', () => {
  test('request.auth != null && resource.data.status == "playing"', () => {
    const ctx = baseCtx({ resource: mkRes({ status: 'playing' }) });
    const expr = binOp('&&',
      binOp('!=', member(id('request'), 'auth'), lit(null)),
      binOp('==', member(member(id('resource'), 'data'), 'status'), lit('playing')),
    );
    expect(evaluate(expr, ctx)).toBe(true);
  });

  test('unauthenticated user denied', () => {
    const ctx = baseCtx();
    ctx.request.auth = null;
    const expr = binOp('!=', member(id('request'), 'auth'), lit(null));
    expect(evaluate(expr, ctx)).toBe(false);
  });

  test('moveCount increment check', () => {
    const ctx = baseCtx({ resource: mkRes({ moveCount: 5 }) });
    ctx.request.resource.data = { moveCount: 6 };
    // request.resource.data.moveCount == resource.data.moveCount + 1
    const expr = binOp('==',
      member(member(member(id('request'), 'resource'), 'data'), 'moveCount'),
      binOp('+', member(member(id('resource'), 'data'), 'moveCount'), lit(1)),
    );
    expect(evaluate(expr, ctx)).toBe(true);
  });
});

// ═══ RULES-B2: undefined-field access ERRORS (not null) ═══
//
// Prod truth (Firebase docs rules-conditions / rules-fields): "Calling
// request.resource.data.foo on a document where foo doesn't exist results in
// an error, and therefore any security rule making that call will deny the
// request." CEL field selection has no overload for a missing key or for
// null. The pre-fix evaluator returned null, inverting the commonest
// rules-debug case: `resource.data.typo == null` ALLOWed where prod DENYs.
describe('RULES-B2: undefined-field access errors', () => {
  test("missing key on existing map ERRORS — resource.data.typo", () => {
    const ctx = baseCtx({ resource: mkRes({ status: 'playing' }) });
    const expr = member(member(id('resource'), 'data'), 'typo');
    expect(() => evaluate(expr, ctx)).toThrow(/No field 'typo'/);
  });

  test("the masked inversion: resource.data.typo == null no longer ALLOWs", () => {
    // Pre-fix: typo read as null → `null == null` → true (ALLOW). Post-fix:
    // the access errors before the comparison; the rule cannot wrongly allow.
    const ctx = baseCtx({ resource: mkRes({ status: 'playing' }) });
    const expr = binOp('==', member(member(id('resource'), 'data'), 'typo'), lit(null));
    expect(() => evaluate(expr, ctx)).toThrow(/No field 'typo'/);
  });

  test('present-but-null field returns null (key exists)', () => {
    const ctx = baseCtx({ resource: mkRes({ nickname: null }) });
    const expr = member(member(id('resource'), 'data'), 'nickname');
    expect(evaluate(expr, ctx)).toBe(null);
  });

  test("missing key on map via DYNAMIC bracket access returns null (not an error)", () => {
    // RULES-B2 scope: dynamic index access (`data[expr]`) is the documented
    // "may-be-absent lookup" idiom; flagship rules (e.g. chess
    // `cfg().paths[from][to]`) rely on null-on-miss. Only DOTTED field access
    // errors. (See the bracketAccess scope note in evaluator.ts.)
    const ctx = baseCtx({ resource: mkRes({ a: 1 }) });
    const expr = bracket(member(id('resource'), 'data'), lit('b'));
    expect(evaluate(expr, ctx)).toBe(null);
  });

  test('field access on a null member ERRORS — request.auth.uid when auth null', () => {
    const ctx = baseCtx();
    ctx.request.auth = null;
    const expr = member(member(id('request'), 'auth'), 'uid');
    expect(() => evaluate(expr, ctx)).toThrow();
  });

  test('undefined variable ERRORS', () => {
    const expr = id('nonexistentVar');
    expect(() => evaluate(expr, baseCtx())).toThrow(/Undefined variable/);
  });

  test("the `in` guard makes a possibly-absent field safe", () => {
    // `'typo' in resource.data && resource.data.typo == 1` must NOT error —
    // the false LHS absorbs the (never-reached) RHS access.
    const ctx = baseCtx({ resource: mkRes({ status: 'x' }) });
    const expr = binOp('&&',
      inExpr(lit('typo'), member(id('resource'), 'data')),
      binOp('==', member(member(id('resource'), 'data'), 'typo'), lit(1)),
    );
    expect(evaluate(expr, ctx)).toBe(false);
  });
});

// ═══ RULES-B3: commutative error-absorption in && / || ═══
//
// Prod truth (CEL spec): && and || are commutative — "if any of their
// operands uniquely determines the result (false for &&, true for ||) the
// other operand may or may not be evaluated, and if that evaluation produces
// a runtime error, it will be ignored." Pre-fix the sim re-threw the error
// (DENY) where prod absorbs it (the determining operand wins).
describe('RULES-B3: && / || absorb errors commutatively', () => {
  // An expression that always errors at eval time (missing field access).
  const boom = (): Expression => member(member(id('resource'), 'data'), 'missing');

  test('error || true → true (RHS absorbs)', () => {
    expect(evaluate(binOp('||', boom(), lit(true)), baseCtx())).toBe(true);
  });

  test('true || error → true (LHS determines, RHS skipped)', () => {
    expect(evaluate(binOp('||', lit(true), boom()), baseCtx())).toBe(true);
  });

  test('error && false → false (RHS absorbs)', () => {
    expect(evaluate(binOp('&&', boom(), lit(false)), baseCtx())).toBe(false);
  });

  test('false && error → false (LHS determines, RHS skipped)', () => {
    expect(evaluate(binOp('&&', lit(false), boom()), baseCtx())).toBe(false);
  });

  test('error || false → propagates (no operand determines) ', () => {
    expect(() => evaluate(binOp('||', boom(), lit(false)), baseCtx())).toThrow();
  });

  test('error && true → propagates (no operand determines)', () => {
    expect(() => evaluate(binOp('&&', boom(), lit(true)), baseCtx())).toThrow();
  });

  test('true && error → propagates (LHS does not determine &&)', () => {
    expect(() => evaluate(binOp('&&', lit(true), boom()), baseCtx())).toThrow();
  });
});

// ═══ RULES-B8: get() of a missing doc ERRORS; resource carries id/__name__ ═══
//
// Prod truth (Firebase rules-conditions docs): get()/exists() execute a real
// read; get() of a non-existent document errors (deny). The safe pattern is
// `exists(p) && get(p).data...`. Pre-fix the sim returned null on a miss,
// which let `get(p).data.x` read null silently. The returned resource also
// exposes the document identity (`id`, `__name__`), which was never populated.
describe('RULES-B8: get() missing-doc + resource identity', () => {
  function ctxWithDoc(path: string, data: Record<string, unknown>): SimulationContext {
    const ctx = baseCtx();
    ctx.mockDocuments.set(path, data);
    return ctx;
  }
  // get(path) takes a path literal — model it as a string literal arg (the
  // evaluator String()-coerces). normalizePath strips the /databases prefix.

  test('get() of an existing mock doc returns its data', () => {
    const ctx = ctxWithDoc('config/app', { maxPlayers: 4 });
    const expr = member(call('get', [lit('/databases/(default)/documents/config/app')]), 'data');
    expect(evaluate(expr, ctx)).toEqual({ maxPlayers: 4 });
  });

  test('get() of a MISSING doc ERRORS (was silent null)', () => {
    const expr = call('get', [lit('/databases/(default)/documents/config/missing')]);
    expect(() => evaluate(expr, baseCtx())).toThrow(/non-existent document/);
  });

  test('exists() guard absorbs the get() error — exists(p) && get(p).data.x', () => {
    // Missing doc: exists() is false → && returns false, the get() error is
    // absorbed commutatively (RULES-B3). No throw, evaluates to false.
    const p = '/databases/(default)/documents/config/missing';
    const expr = binOp('&&',
      call('exists', [lit(p)]),
      member(member(call('get', [lit(p)]), 'data'), 'x'),
    );
    expect(evaluate(expr, baseCtx())).toBe(false);
  });

  test('get(path).id is the last path segment (RULES-B8 identity)', () => {
    const ctx = ctxWithDoc('users/alice', { role: 'admin' });
    const expr = member(call('get', [lit('/databases/(default)/documents/users/alice')]), 'id');
    expect(evaluate(expr, ctx)).toBe('alice');
  });

  test('get(path).__name__ is a Path wrapper', () => {
    const ctx = ctxWithDoc('users/alice', { role: 'admin' });
    const expr = member(call('get', [lit('/databases/(default)/documents/users/alice')]), '__name__');
    const v = evaluate(expr, ctx);
    expect(v).toBeInstanceOf(Path);
  });
});

// ═══ RULES-B4: matches() full-string RE2; replace/split are regex+all ═══
//
// Prod truth (Firebase Rules String API + RE2 docs): regexes follow RE2;
// matches()/regexMatch "returns true if the value FULLY matches pattern";
// replace() replaces ALL non-overlapping occurrences; split()'s delimiter is a
// regex. Pre-fix the sim used partial JS .test(), literal-string split, and a
// first-only replace.
describe('RULES-B4: matches/replace/split regex semantics', () => {
  const matches = (s: string, re: string): Expression => methodCall(lit(s), 'matches', [lit(re)]);

  test('matches() is FULL-STRING — partial match no longer passes', () => {
    // Pre-fix: /a/.test('xax') → true. Post-fix anchored: 'xax' does not
    // fully match 'a' → false.
    expect(evaluate(matches('xax', 'a'), baseCtx())).toBe(false);
  });

  test('matches() full-string positive', () => {
    expect(evaluate(matches('hello', 'h.*o'), baseCtx())).toBe(true);
  });

  test('matches() anchored email pattern', () => {
    expect(evaluate(matches('a@b.com', '[a-z]+@[a-z]+\\.[a-z]+'), baseCtx())).toBe(true);
    expect(evaluate(matches('a@b.com EXTRA', '[a-z]+@[a-z]+\\.[a-z]+'), baseCtx())).toBe(false);
  });

  test('replace() replaces ALL occurrences (regex), not just the first', () => {
    // Pre-fix literal-first replace: 'a-a-a'.replace('a','X') → 'X-a-a'.
    // Post-fix regex-global: → 'X-X-X'.
    const expr = methodCall(lit('a-a-a'), 'replace', [lit('a'), lit('X')]);
    expect(evaluate(expr, baseCtx())).toBe('X-X-X');
  });

  test('replace() treats the pattern as a regex', () => {
    const expr = methodCall(lit('a1b2c3'), 'replace', [lit('[0-9]'), lit('#')]);
    expect(evaluate(expr, baseCtx())).toBe('a#b#c#');
  });

  test('split() treats the delimiter as a regex', () => {
    const expr = methodCall(lit('a1b22c'), 'split', [lit('[0-9]+')]);
    expect(evaluate(expr, baseCtx())).toEqual(['a', 'b', 'c']);
  });

  test('invalid regex ERRORS', () => {
    expect(() => evaluate(matches('x', '('), baseCtx())).toThrow(/Invalid regex/);
  });
});

// ═══ RULES-B7: no JS prototype-chain key leakage ═══
//
// Prod truth: a Firestore map has only its own keys — there is no `toString`,
// `constructor`, `hasOwnProperty`, etc. The pre-fix sim used JS `in` and
// property reads, so `'toString' in resource.data` ALLOWed and
// `resource.data.constructor` returned the Object constructor.
describe('RULES-B7: prototype keys do not leak', () => {
  test("'toString' in resource.data → false (inherited key not present)", () => {
    const ctx = baseCtx({ resource: mkRes({ name: 'x' }) });
    const expr = inExpr(lit('toString'), member(id('resource'), 'data'));
    expect(evaluate(expr, ctx)).toBe(false);
  });

  test("'constructor' in resource.data → false", () => {
    const ctx = baseCtx({ resource: mkRes({ name: 'x' }) });
    const expr = inExpr(lit('constructor'), member(id('resource'), 'data'));
    expect(evaluate(expr, ctx)).toBe(false);
  });

  test('resource.data.constructor ERRORS (no own key — RULES-B2/B7)', () => {
    const ctx = baseCtx({ resource: mkRes({ name: 'x' }) });
    const expr = member(member(id('resource'), 'data'), 'constructor');
    expect(() => evaluate(expr, ctx)).toThrow(/No field 'constructor'/);
  });

  test("data.hasAll(['toString']) → false (inherited key not owned)", () => {
    const ctx = baseCtx({ resource: mkRes({ name: 'x' }) });
    const expr = methodCall(member(id('resource'), 'data'), 'hasAll', [listLit([lit('toString')])]);
    expect(evaluate(expr, ctx)).toBe(false);
  });

  test("data.get('toString', 'def') → default (inherited key not owned)", () => {
    const ctx = baseCtx({ resource: mkRes({ name: 'x' }) });
    const expr = methodCall(member(id('resource'), 'data'), 'get', [lit('toString'), lit('def')]);
    expect(evaluate(expr, ctx)).toBe('def');
  });
});

// ═══ RULES-B9: list hasAll/hasAny/hasOnly use VALUE equality ═══
//
// Prod truth: list membership compares by value. Pre-fix the list methods used
// JS `Array.includes` (identity), inconsistent with `in` / `removeAll` which
// already used deep value equality — so two equal-valued Timestamp wrappers
// (distinct instances) were treated as different members.
describe('RULES-B9: list membership value equality', () => {
  // Two distinct Timestamp instances wrapping the same instant.
  const tA = (): Timestamp => Timestamp.fromMillis(1000);
  const tB = (): Timestamp => Timestamp.fromMillis(1000);
  // Inject wrapper values via scope by binding them through a let-style ctx:
  // simplest is to stash them on resource.data and read via member access.
  function ctxWithLists(): SimulationContext {
    return baseCtx({ resource: mkRes({ have: [tA()], want: [tB()], other: [Timestamp.fromMillis(2000)] }) });
  }
  const have = member(member(id('resource'), 'data'), 'have');
  const want = member(member(id('resource'), 'data'), 'want');
  const other = member(member(id('resource'), 'data'), 'other');

  test('hasAll matches equal-valued wrapper instances', () => {
    expect(evaluate(methodCall(have, 'hasAll', [want]), ctxWithLists())).toBe(true);
  });

  test('hasAny matches equal-valued wrapper instances', () => {
    expect(evaluate(methodCall(have, 'hasAny', [want]), ctxWithLists())).toBe(true);
  });

  test('hasOnly matches equal-valued wrapper instances', () => {
    expect(evaluate(methodCall(have, 'hasOnly', [want]), ctxWithLists())).toBe(true);
  });

  test('hasAny is false for a genuinely different value', () => {
    expect(evaluate(methodCall(have, 'hasAny', [other]), ctxWithLists())).toBe(false);
  });

  test('in operator already used value equality (regression guard)', () => {
    const ctx = ctxWithLists();
    // tB() value in resource.data.have
    const expr = inExpr(member(member(id('resource'), 'data'), 'want'), have);
    // want is a list, not an element — instead test element membership:
    const el = bracket(want, lit(0));
    expect(evaluate(inExpr(el, have), ctx)).toBe(true);
    void expr;
  });
});

// ═══ RULES-B6 (partial): `+` requires matching operand types ═══
//
// Prod truth (CEL langdef): `+` has no mixed-type overload — both operands
// must be the same type. Allowed: int+int, double+double, string+string,
// bytes+bytes, list+list (concat). `'a' + 1` is an ERROR (no string+int
// overload), not the silent `String(rv)` coercion the old impl did.
// (Full RULES-B6 — strict bool in &&/||/ternary, int()/bool() parsing — is
// deferred; see step-08 doc. This step covers only the unambiguous `+` rule.)
describe('RULES-B6: + operator type rules', () => {
  test("'a' + 1 ERRORS (mixed string+int)", () => {
    expect(() => evaluate(binOp('+', lit('a'), lit(1)), baseCtx())).toThrow(/not defined between/);
  });

  test('1 + "a" ERRORS (mixed int+string)', () => {
    expect(() => evaluate(binOp('+', lit(1), lit('a')), baseCtx())).toThrow(/not defined between/);
  });

  test("string + string concatenates", () => {
    expect(evaluate(binOp('+', lit('a'), lit('b')), baseCtx())).toBe('ab');
  });

  test('number + number adds', () => {
    expect(evaluate(binOp('+', lit(2), lit(3)), baseCtx())).toBe(5);
  });

  test('list + list concatenates (CEL list concat)', () => {
    const expr = binOp('+', listLit([lit(1)]), listLit([lit(2)]));
    expect(evaluate(expr, baseCtx())).toEqual([1, 2]);
  });
});

// ═══ RULES-B12 (partial): cross-type ordering errors; is map exclusions ═══
//
// Prod truth (CEL): ordered comparisons (< > <= >=) have no cross-type overload
// — `'a' < 1` is an error, not the JS-coerced false the bare casts produced.
// MapDiff / FirestoreSet are internal types, not user maps, so `x is map` is
// false for them. (string()-of-float `.0`, resource-null-on-create, and
// FirestoreSet member coercion remain — see step-09 doc.)
describe('RULES-B12: cross-type ordering + is map exclusions', () => {
  test("'a' < 1 ERRORS (cross-type ordering)", () => {
    expect(() => evaluate(binOp('<', lit('a'), lit(1)), baseCtx())).toThrow(/not defined between/);
  });

  test('1 > "a" ERRORS (cross-type ordering)', () => {
    expect(() => evaluate(binOp('>', lit(1), lit('a')), baseCtx())).toThrow(/not defined between/);
  });

  test('same-type ordering still works', () => {
    expect(evaluate(binOp('<', lit(1), lit(2)), baseCtx())).toBe(true);
    expect(evaluate(binOp('<', lit('a'), lit('b')), baseCtx())).toBe(true);
  });

  test('diff() result is NOT a map (is map → false)', () => {
    const ctx = baseCtx({ resource: mkRes({ a: 1 }) });
    ctx.request.resource.data = { a: 2 };
    const diff = methodCall(member(member(id('request'), 'resource'), 'data'), 'diff', [member(id('resource'), 'data')]);
    const expr: Expression = { type: 'isExpr', value: diff, typeName: 'map' };
    expect(evaluate(expr, ctx)).toBe(false);
  });

  test('keys() FirestoreSet is NOT a map (is map → false)', () => {
    const ctx = baseCtx({ resource: mkRes({ a: 1, b: 2 }) });
    const keys = methodCall(member(id('resource'), 'data'), 'keys');
    const expr: Expression = { type: 'isExpr', value: keys, typeName: 'map' };
    expect(evaluate(expr, ctx)).toBe(false);
  });
});

// ═══ RULES-B5: int/float type distinction + integer division ═══
//
// Prod truth (Firestore rules / CEL): int and float are DISTINCT types.
// `1.5 is int` → false, `1 is float` → false, `1.0 is float` → true. `/`
// between two ints is INTEGER division (truncate toward zero): `10 / 4 == 2`.
// A float operand makes it float division (`10 / 4.0 == 2.5`). int÷0 ERRORS
// (deny); float÷0 is IEEE (±Infinity / NaN). `string(1.0)` → "1.0".
// Docs: rules.Float (distinct Float type) + CEL int/float division spec; the
// invertase #4766 thread + the search-confirmed "integer division truncated,
// error on zero divisor for INT64; FLOAT64 ÷0 → NaN" pin the division split.
describe('RULES-B5: int/float distinction + integer division', () => {
  // ── is int / is float / is number ──
  test('1.5 is int → false', () => {
    expect(evaluate(isType(litFloat(1.5), 'int'), baseCtx())).toBe(false);
  });
  test('1 is float → false', () => {
    expect(evaluate(isType(lit(1), 'float'), baseCtx())).toBe(false);
  });
  test('1.0 is float → true (integral float keeps its type)', () => {
    expect(evaluate(isType(litFloat(1), 'float'), baseCtx())).toBe(true);
  });
  test('1 is int → true', () => {
    expect(evaluate(isType(lit(1), 'int'), baseCtx())).toBe(true);
  });
  test('1.5 is float → true', () => {
    expect(evaluate(isType(litFloat(1.5), 'float'), baseCtx())).toBe(true);
  });
  test('both int and float are number (is number)', () => {
    expect(evaluate(isType(lit(1), 'number'), baseCtx())).toBe(true);
    expect(evaluate(isType(litFloat(1.5), 'number'), baseCtx())).toBe(true);
  });

  // ── integer division (truncation) ──
  test('10 / 4 == 2 (int ÷ int truncates, NOT 2.5)', () => {
    expect(evaluate(binOp('/', lit(10), lit(4)), baseCtx())).toBe(2);
  });
  test('7 / 2 == 3 (truncate toward zero)', () => {
    expect(evaluate(binOp('/', lit(7), lit(2)), baseCtx())).toBe(3);
  });
  test('-7 / 2 == -3 (truncate toward zero, not floor)', () => {
    expect(evaluate(binOp('/', lit(-7), lit(2)), baseCtx())).toBe(-3);
  });

  // ── float division (a float operand promotes to float math) ──
  test('10 / 4.0 == 2.5 (float divisor → float division)', () => {
    const r = evaluate(binOp('/', lit(10), litFloat(4)), baseCtx());
    expect(Number(r)).toBe(2.5);
  });
  test('10.0 / 4 == 2.5 (float dividend → float division)', () => {
    const r = evaluate(binOp('/', litFloat(10), lit(4)), baseCtx());
    expect(Number(r)).toBe(2.5);
  });
  test('float result is float-typed (10.0 / 4 is float)', () => {
    expect(evaluate(isType(binOp('/', litFloat(10), lit(4)), 'float'), baseCtx())).toBe(true);
  });

  // ── division / modulo by zero ──
  test('1 / 0 ERRORS (int div-by-zero denies, not Infinity)', () => {
    expect(() => evaluate(binOp('/', lit(1), lit(0)), baseCtx())).toThrow(/[Dd]ivision by zero/);
  });
  test('5 % 0 ERRORS (int modulo-by-zero denies)', () => {
    expect(() => evaluate(binOp('%', lit(5), lit(0)), baseCtx())).toThrow(/[Mm]odulo by zero/);
  });
  test('1.0 / 0.0 does NOT error (float ÷0 is IEEE)', () => {
    // Float division by zero is IEEE (±Infinity), not an error like int÷0.
    expect(() => evaluate(binOp('/', litFloat(1), litFloat(0)), baseCtx())).not.toThrow();
  });

  // ── mixed-int/float arithmetic preserves operand order + float type ──
  test('5 - 2.0 == 3.0 and is float', () => {
    expect(evaluate(isType(binOp('-', lit(5), litFloat(2)), 'float'), baseCtx())).toBe(true);
    expect(Number(evaluate(binOp('-', lit(5), litFloat(2)), baseCtx()))).toBe(3);
  });
  test('int + int stays int (2 + 3 is int)', () => {
    expect(evaluate(isType(binOp('+', lit(2), lit(3)), 'int'), baseCtx())).toBe(true);
  });

  // ── int/float numeric equality (CEL: 1 == 1.0) ──
  test('1 == 1.0 → true (value equality across int/float)', () => {
    expect(evaluate(binOp('==', lit(1), litFloat(1)), baseCtx())).toBe(true);
  });

  // ── string() float formatting (RULES-B12/B6 sub-item) ──
  test('string(1.0) == "1.0" (decimal preserved)', () => {
    expect(evaluate(call('string', [litFloat(1)]), baseCtx())).toBe('1.0');
  });
  test('string(1.5) == "1.5"', () => {
    expect(evaluate(call('string', [litFloat(1.5)]), baseCtx())).toBe('1.5');
  });
  test('string(1) == "1" (int has no decimal)', () => {
    expect(evaluate(call('string', [lit(1)]), baseCtx())).toBe('1');
  });
});

// ═══ RULES-B6 (remainder): strict int()/bool() parsing ═══
//
// CEL conversion builtins are strict — they reject malformed strings rather
// than salvaging a prefix (parseInt) or applying JS truthiness (Boolean).
// Docs: rules.Integer / rules.Boolean string converters require a valid literal.
describe('RULES-B6 remainder: strict int()/bool()/float() parsing', () => {
  test("int('12abc') ERRORS (no parseInt prefix grab)", () => {
    expect(() => evaluate(call('int', [lit('12abc')]), baseCtx())).toThrow(/cannot convert/);
  });
  test("int('12') == 12 (valid integer string)", () => {
    expect(evaluate(call('int', [lit('12')]), baseCtx())).toBe(12);
  });
  test('int(1.9) == 1 (float truncates toward zero)', () => {
    expect(evaluate(call('int', [litFloat(1.9)]), baseCtx())).toBe(1);
  });
  test('int(true) == 1, int(false) == 0', () => {
    expect(evaluate(call('int', [lit(true)]), baseCtx())).toBe(1);
    expect(evaluate(call('int', [lit(false)]), baseCtx())).toBe(0);
  });
  test("bool('false') == false (NOT JS Boolean('false') === true)", () => {
    expect(evaluate(call('bool', [lit('false')]), baseCtx())).toBe(false);
  });
  test("bool('true') == true", () => {
    expect(evaluate(call('bool', [lit('true')]), baseCtx())).toBe(true);
  });
  test("bool('yes') ERRORS (only 'true'/'false' are valid)", () => {
    expect(() => evaluate(call('bool', [lit('yes')]), baseCtx())).toThrow(/cannot convert/);
  });
  test('float("1.5") is a float-typed value', () => {
    expect(evaluate(isType(call('float', [lit('1.5')]), 'float'), baseCtx())).toBe(true);
  });
  test("float('abc') ERRORS", () => {
    expect(() => evaluate(call('float', [lit('abc')]), baseCtx())).toThrow(/cannot convert/);
  });
});
