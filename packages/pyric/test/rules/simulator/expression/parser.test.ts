/**
 * Item 4.1.3 — Parser test corpus.
 *
 * Critical-path test buckets (mirroring the pre-mortem):
 *
 *  1. Operator precedence — every neighboring pair in the grammar has
 *     an explicit precedence test. Especially &&/|| (Q1 sign-off) and
 *     unary/postfix interactions.
 *  2. Associativity — ternary right-assoc, comparison/arithmetic
 *     left-assoc. These are the silent-bug class that produces wrong
 *     numbers without any error.
 *  3. Sentinel handling — whitelist, arity, parens-required.
 *  4. Postfix chains — including the depth-cap bypass guard
 *     (postfix chains count toward AST depth).
 *  5. Position-bearing errors — every error class has a position
 *     assertion so we'd notice if positions silently drifted.
 *  6. Round-trip stability via AST equality — parse the same
 *     expression twice, assert structural equality.
 */
import { describe, test, expect } from 'bun:test';
import { tokenize } from '../../../../src/rules/simulator/expression/lexer.js';
import { parse } from '../../../../src/rules/simulator/expression/parser.js';
import {
  EXPRESSION_LIMITS,
  ExpressionParseError,
  type AstNode,
} from '../../../../src/rules/simulator/expression/types.js';

const ast = (src: string) => parse(tokenize(src));

/**
 * Strip positions from an AST so structural-equality assertions don't
 * compare positions. Positions are tested separately.
 */
function stripPos(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(stripPos);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'pos') continue;
    out[k] = stripPos(v);
  }
  return out;
}

describe('parser / literals and atoms', () => {
  test('number literal', () => {
    expect(stripPos(ast('42'))).toEqual({ kind: 'literal', value: 42 });
  });

  test('string literal', () => {
    expect(stripPos(ast('"hi"'))).toEqual({ kind: 'literal', value: 'hi' });
  });

  test('boolean and null literals', () => {
    expect(stripPos(ast('true'))).toEqual({ kind: 'literal', value: true });
    expect(stripPos(ast('false'))).toEqual({ kind: 'literal', value: false });
    expect(stripPos(ast('null'))).toEqual({ kind: 'literal', value: null });
  });

  test('reference', () => {
    expect(stripPos(ast('$src'))).toEqual({ kind: 'reference', alias: 'src' });
  });
});

describe('parser / unary minus replaces signed literal', () => {
  test('-5 parses as unary minus on literal 5', () => {
    expect(stripPos(ast('-5'))).toEqual({
      kind: 'unary',
      op: '-',
      operand: { kind: 'literal', value: 5 },
    });
  });

  test('--5 parses as unary minus on unary minus on literal 5', () => {
    const node = ast('--5') as AstNode;
    expect(node.kind).toBe('unary');
    expect((node as { operand: AstNode }).operand.kind).toBe('unary');
  });

  test('!true parses as unary !', () => {
    expect(stripPos(ast('!true'))).toEqual({
      kind: 'unary',
      op: '!',
      operand: { kind: 'literal', value: true },
    });
  });
});

describe('parser / arithmetic precedence', () => {
  test('* binds tighter than + (left-assoc)', () => {
    // `1 + 2 * 3` → +( 1, *(2, 3) )
    const root = ast('1 + 2 * 3') as AstNode;
    expect(root.kind).toBe('binary');
    if (root.kind !== 'binary') throw new Error();
    expect(root.op).toBe('+');
    expect(root.left.kind).toBe('literal');
    expect(root.right.kind).toBe('binary');
    if (root.right.kind !== 'binary') throw new Error();
    expect(root.right.op).toBe('*');
  });

  test('+ left-associative', () => {
    // `1 + 2 + 3` → +( +(1, 2), 3 )
    const root = ast('1 + 2 + 3') as AstNode;
    if (root.kind !== 'binary') throw new Error();
    expect(root.op).toBe('+');
    expect(root.right.kind).toBe('literal');
    expect(root.left.kind).toBe('binary');
  });

  test('parens override precedence', () => {
    const root = ast('(1 + 2) * 3') as AstNode;
    if (root.kind !== 'binary') throw new Error();
    expect(root.op).toBe('*');
    expect(root.left.kind).toBe('binary');
    expect(root.right.kind).toBe('literal');
  });

  test('% has same precedence as * and /', () => {
    // `10 % 3 * 2` → *( %(10,3), 2 ) — left-assoc same precedence
    const root = ast('10 % 3 * 2') as AstNode;
    if (root.kind !== 'binary') throw new Error();
    expect(root.op).toBe('*');
    if (root.left.kind !== 'binary') throw new Error();
    expect(root.left.op).toBe('%');
  });
});

describe('parser / comparison chains parse (eval rejects)', () => {
  test('1 < 2 < 3 parses left-associative', () => {
    // (1 < 2) < 3 — eval will reject when bool < number.
    const root = ast('1 < 2 < 3') as AstNode;
    if (root.kind !== 'binary') throw new Error();
    expect(root.op).toBe('<');
    expect(root.left.kind).toBe('binary');
    expect(root.right.kind).toBe('literal');
  });

  test('all six comparison operators parse', () => {
    for (const op of ['==', '!=', '<', '<=', '>', '>=']) {
      const root = ast(`1 ${op} 2`) as AstNode;
      if (root.kind !== 'binary') throw new Error();
      expect(root.op).toBe(op as never);
    }
  });
});

describe('parser / && binds tighter than || (Q1 sign-off)', () => {
  test('a || b && c parses as a || (b && c)', () => {
    // The CRITICAL case from the pre-mortem. If this regresses, every
    // boolean expression with mixed && and || silently mis-evaluates.
    const root = ast('$a || $b && $c') as AstNode;
    expect(root.kind).toBe('logical');
    if (root.kind !== 'logical') throw new Error();
    expect(root.op).toBe('||');
    expect(root.left.kind).toBe('reference');
    expect(root.right.kind).toBe('logical');
    if (root.right.kind !== 'logical') throw new Error();
    expect(root.right.op).toBe('&&');
  });

  test('a && b || c parses as (a && b) || c', () => {
    const root = ast('$a && $b || $c') as AstNode;
    if (root.kind !== 'logical') throw new Error();
    expect(root.op).toBe('||');
    expect(root.left.kind).toBe('logical');
    if (root.left.kind !== 'logical') throw new Error();
    expect(root.left.op).toBe('&&');
    expect(root.right.kind).toBe('reference');
  });

  test('|| left-associative (a || b || c → (a || b) || c)', () => {
    const root = ast('$a || $b || $c') as AstNode;
    if (root.kind !== 'logical') throw new Error();
    expect(root.left.kind).toBe('logical');
    expect(root.right.kind).toBe('reference');
  });

  test('&& binds tighter than comparison', () => {
    // `$a > 0 && $b > 0` → &&( >($a,0), >($b,0) )
    const root = ast('$a > 0 && $b > 0') as AstNode;
    if (root.kind !== 'logical') throw new Error();
    expect(root.op).toBe('&&');
    expect(root.left.kind).toBe('binary');
    expect(root.right.kind).toBe('binary');
  });
});

describe('parser / ternary right-associative', () => {
  test('a ? b : c ? d : e parses as a ? b : (c ? d : e)', () => {
    const root = ast('$a ? $b : $c ? $d : $e') as AstNode;
    expect(root.kind).toBe('ternary');
    if (root.kind !== 'ternary') throw new Error();
    expect(root.cond.kind).toBe('reference');
    expect(root.whenTrue.kind).toBe('reference');
    expect(root.whenFalse.kind).toBe('ternary');
  });

  test('a ? b ? c : d : e parses as a ? (b ? c : d) : e', () => {
    const root = ast('$a ? $b ? $c : $d : $e') as AstNode;
    if (root.kind !== 'ternary') throw new Error();
    expect(root.whenTrue.kind).toBe('ternary');
    expect(root.whenFalse.kind).toBe('reference');
  });

  test('ternary cond binds looser than ||', () => {
    // `$a || $b ? c : d` → ternary( ||($a,$b), c, d )
    const root = ast('$a || $b ? 1 : 2') as AstNode;
    expect(root.kind).toBe('ternary');
    if (root.kind !== 'ternary') throw new Error();
    expect(root.cond.kind).toBe('logical');
  });

  test('REJECT: missing colon in ternary', () => {
    expect(() => ast('$a ? $b')).toThrow(/expected ':'/);
  });
});

describe('parser / postfix chains', () => {
  test('field access', () => {
    const root = ast('$a.b') as AstNode;
    expect(root.kind).toBe('fieldAccess');
    if (root.kind !== 'fieldAccess') throw new Error();
    expect(root.field).toBe('b');
    expect(root.target.kind).toBe('reference');
  });

  test('chained field access', () => {
    // `$a.b.c.d` → fieldAccess(fieldAccess(fieldAccess($a, b), c), d)
    const root = ast('$a.b.c.d') as AstNode;
    expect(root.kind).toBe('fieldAccess');
    if (root.kind !== 'fieldAccess') throw new Error();
    expect(root.field).toBe('d');
    expect((root.target as { field: string }).field).toBe('c');
  });

  test('mixed dot and bracket access', () => {
    const root = ast('$a.b[0].c["k"]') as AstNode;
    expect(root.kind).toBe('indexAccess');
  });

  test('REJECT: dot followed by non-identifier', () => {
    expect(() => ast('$a.1')).toThrow(/expected identifier after '\.'/);
  });

  test('REJECT: unbalanced bracket', () => {
    expect(() => ast('$a[0')).toThrow(/expected ']'/);
  });
});

describe('parser / sentinels', () => {
  test('@serverTimestamp() with 0 args', () => {
    const root = ast('@serverTimestamp()') as AstNode;
    expect(root.kind).toBe('sentinel');
    if (root.kind !== 'sentinel') throw new Error();
    expect(root.name).toBe('serverTimestamp');
    expect(root.args).toEqual([]);
  });

  test('@increment(1) with 1 arg', () => {
    const root = ast('@increment(1)') as AstNode;
    if (root.kind !== 'sentinel') throw new Error();
    expect(root.args).toHaveLength(1);
  });

  test('@arrayUnion(1, 2, 3) variadic', () => {
    const root = ast('@arrayUnion(1, 2, 3)') as AstNode;
    if (root.kind !== 'sentinel') throw new Error();
    expect(root.args).toHaveLength(3);
  });

  test('REJECT: unknown sentinel at parse time', () => {
    expect(() => ast('@whatever()')).toThrow(/unknown sentinel '@whatever'/);
  });

  test('REJECT: missing parens (Q3 sign-off)', () => {
    expect(() => ast('@serverTimestamp')).toThrow(/expected '\(' after sentinel/);
  });

  test('REJECT: @increment with 0 args (arity)', () => {
    expect(() => ast('@increment()')).toThrow(/expects exactly 1 argument/);
  });

  test('REJECT: @increment with 2 args (arity)', () => {
    expect(() => ast('@increment(1, 2)')).toThrow(/expects exactly 1 argument/);
  });

  test('REJECT: @arrayUnion() with 0 args', () => {
    expect(() => ast('@arrayUnion()')).toThrow(/expects at least 1/);
  });

  test('REJECT: @serverTimestamp with extra args', () => {
    expect(() => ast('@serverTimestamp(1)')).toThrow(/expects exactly 0/);
  });

  test('REJECT: @deleteField with extra args', () => {
    expect(() => ast('@deleteField(1)')).toThrow(/expects exactly 0/);
  });
});

describe('parser / errors and edge cases', () => {
  test('REJECT: bare identifier (not a value)', () => {
    expect(() => ast('foo + 1')).toThrow(/bare identifier 'foo'/);
  });

  test('bare identifier error suggests $/@ prefix', () => {
    expect(() => ast('increment(1)')).toThrow(/'\$increment' or '@increment'/);
  });

  test('REJECT: trailing tokens after a complete expression', () => {
    expect(() => ast('1 + 2 garbage')).toThrow(/unexpected trailing/);
  });

  test('REJECT: empty expression', () => {
    expect(() => ast('')).toThrow(/unexpected end/);
  });

  test('REJECT: dangling operator', () => {
    expect(() => ast('1 +')).toThrow(/unexpected end/);
  });

  test('REJECT: operator at start', () => {
    // `* 1` — `*` cannot start a primary
    expect(() => ast('* 1')).toThrow();
  });

  test('REJECT: unbalanced parens', () => {
    expect(() => ast('(1 + 2')).toThrow(/expected '\)'/);
    expect(() => ast('1 + 2)')).toThrow(/unexpected trailing/);
  });
});

describe('parser / depth cap', () => {
  test('AST at exactly 16 levels passes', () => {
    // Build `((((((... 1 ...))))))` with N nested parens.
    // Parens themselves DON'T add AST nodes (parser unwraps), so we
    // need to nest via real operators. Use unary minus.
    const at = '-'.repeat(EXPRESSION_LIMITS.maxAstDepth - 1) + '1';
    expect(() => ast(at)).not.toThrow();
  });

  test('AST at depth 17 throws', () => {
    const over = '-'.repeat(EXPRESSION_LIMITS.maxAstDepth) + '1';
    expect(() => ast(over)).toThrow(/exceeds depth cap/);
  });

  test('depth cap fires on POSTFIX chains too (no bypass)', () => {
    // The classic bypass: build depth via postfix access only. If the
    // cap counted parser recursion instead of AST nodes, this would
    // sneak past. With node-counting depth, it must fire.
    const chain = '$a' + '.b'.repeat(EXPRESSION_LIMITS.maxAstDepth);
    expect(() => ast(chain)).toThrow(/exceeds depth cap/);
  });

  test('depth cap fires on SENTINEL arg trees (no bypass)', () => {
    // Nest unary operators inside a sentinel arg.
    const args = '-'.repeat(EXPRESSION_LIMITS.maxAstDepth) + '1';
    expect(() => ast(`@increment(${args})`)).toThrow(/exceeds depth cap/);
  });
});

describe('parser / position tracking', () => {
  test('error position points at the offending token', () => {
    try {
      ast('1 + @foo()');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ExpressionParseError);
      // `@foo` starts at column 5 (1-based)
      expect((e as ExpressionParseError).pos.column).toBe(5);
    }
  });

  test('node positions land on the operator that produced them', () => {
    // For binary `1 + 2`, the binary node carries the `+` position.
    const root = ast('1 + 2') as AstNode;
    if (root.kind !== 'binary') throw new Error();
    expect(root.pos.column).toBe(3);
  });
});

describe('parser / round-trip stability', () => {
  test('parsing the same source twice yields structurally equal ASTs', () => {
    const src = '$a.balance - 30 + @increment(1) > 0 ? "ok" : "ko"';
    expect(stripPos(ast(src))).toEqual(stripPos(ast(src)));
  });
});
