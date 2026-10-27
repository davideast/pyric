/**
 * A typed syntax tree for RTDB rule expressions, built over the same Ohm
 * grammar (`RtdbExpr.ohm`) the parser, validator and simulator match with.
 *
 * The tree is faithful to the source: it keeps `===` apart from `==`, every
 * literal's source text, and the left-nested shape of `&&`, `||` and the other
 * left-associative operators. It drops only what cannot reach evaluation:
 * whitespace and grouping parentheses, whose effect is the shape of the tree.
 * {@link printRtdbExpressionTree} prints a tree back to expression text that
 * parses to the same tree.
 */
import type { Node, Semantics } from 'ohm-js';
import {
  CHAINED_TERMS_MESSAGE,
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import {
  UNTERMINATED_STRING_LITERAL,
  containsRawNewlineInRtdbString,
  unescapeRtdbStringLiteral,
} from './string-literal.js';

export type RtdbBinaryOperator =
  | '||' | '&&'
  | '===' | '!==' | '==' | '!='
  | '>=' | '<=' | '>' | '<'
  | '+' | '-'
  | '*' | '/' | '%';

export type RtdbExpressionTree =
  | { type: 'ternary'; test: RtdbExpressionTree; consequent: RtdbExpressionTree; alternate: RtdbExpressionTree }
  | { type: 'binary'; operator: RtdbBinaryOperator; left: RtdbExpressionTree; right: RtdbExpressionTree }
  | { type: 'unary'; operator: '!' | '-'; argument: RtdbExpressionTree }
  | { type: 'call'; receiver: RtdbExpressionTree; method: string; args: RtdbExpressionTree[] }
  | { type: 'member'; object: RtdbExpressionTree; property: string }
  | { type: 'index'; object: RtdbExpressionTree; index: RtdbExpressionTree }
  | { type: 'array'; elements: RtdbExpressionTree[] }
  /** `raw` is the literal's source text; `value` is the string a string literal denotes. */
  | { type: 'string'; raw: string; value: string }
  | { type: 'number'; raw: string }
  | { type: 'regex'; raw: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' }
  | { type: 'identifier'; name: string };

export type RtdbExpressionTreeResult =
  | { ok: true; tree: RtdbExpressionTree }
  | { ok: false; message: string };

let treeSemantics: Semantics | undefined;

function binary(operator: RtdbBinaryOperator) {
  return function (this: unknown, left: Node, _op: Node, right: Node): RtdbExpressionTree {
    return { type: 'binary', operator, left: (left as any).tree(), right: (right as any).tree() };
  };
}

/**
 * A `||` or `&&` chain, which the grammar matches flat, as the left-nested
 * binary tree its operators denote. Built in a loop, so a chain of any length
 * costs no stack while it is read.
 */
function chain(operator: '||' | '&&') {
  return function (this: unknown, first: Node, _ops: Node, rest: Node): RtdbExpressionTree {
    let tree: RtdbExpressionTree = first.tree();
    for (const term of rest.children) tree = { type: 'binary', operator, left: tree, right: term.tree() };
    return tree;
  };
}

function passThrough(node: Node): RtdbExpressionTree {
  return (node as any).tree();
}

function getTreeSemantics(): Semantics {
  if (treeSemantics) return treeSemantics;
  const semantics = createRtdbExpressionSemantics();
  semantics.addOperation<RtdbExpressionTree>('tree', {
    Expr: passThrough,
    Ternary_ternary(test, _q, consequent, _c, alternate) {
      return {
        type: 'ternary',
        test: (test as any).tree(),
        consequent: (consequent as any).tree(),
        alternate: (alternate as any).tree(),
      };
    },
    Ternary: passThrough,
    LogicalOr_or: chain('||'),
    LogicalOr: passThrough,
    LogicalAnd_and: chain('&&'),
    LogicalAnd: passThrough,
    Equality_strictEq: binary('==='),
    Equality_strictNeq: binary('!=='),
    Equality_looseEq: binary('=='),
    Equality_looseNeq: binary('!='),
    Equality: passThrough,
    Comparison_gte: binary('>='),
    Comparison_lte: binary('<='),
    Comparison_gt: binary('>'),
    Comparison_lt: binary('<'),
    Comparison: passThrough,
    Additive_add: binary('+'),
    Additive_sub: binary('-'),
    Additive: passThrough,
    Multiplicative_mul: binary('*'),
    Multiplicative_div: binary('/'),
    Multiplicative_mod: binary('%'),
    Multiplicative: passThrough,
    UnaryExpr_not(_op, argument) {
      return { type: 'unary', operator: '!', argument: (argument as any).tree() };
    },
    UnaryExpr_neg(_op, argument) {
      return { type: 'unary', operator: '-', argument: (argument as any).tree() };
    },
    UnaryExpr: passThrough,
    CallExpr_methodCall(receiver, _dot, method, _open, args, _close) {
      return {
        type: 'call',
        receiver: (receiver as any).tree(),
        method: method.sourceString,
        args: (args as any).asIteration().children.map((a: any) => a.tree()),
      };
    },
    CallExpr_memberAccess(receiver, _dot, member) {
      return { type: 'member', object: (receiver as any).tree(), property: member.sourceString };
    },
    CallExpr_indexAccess(receiver, _open, index, _close) {
      return { type: 'index', object: (receiver as any).tree(), index: (index as any).tree() };
    },
    CallExpr: passThrough,
    Primary_paren(_open, expr, _close) { return (expr as any).tree(); },
    Primary: passThrough,
    Array(_open, elements, _close) {
      return { type: 'array', elements: (elements as any).asIteration().children.map((e: any) => e.tree()) };
    },
    literal: passThrough,
    number(_node) { return { type: 'number', raw: this.sourceString }; },
    string(_node) {
      return { type: 'string', raw: this.sourceString, value: unescapeRtdbStringLiteral(this.sourceString) };
    },
    regex(_s1, _body, _s2, _flags) { return { type: 'regex', raw: this.sourceString }; },
    bool_true(_lit) { return { type: 'boolean', value: true }; },
    bool_false(_lit) { return { type: 'boolean', value: false }; },
    bool: passThrough,
    null(_lit) { return { type: 'null' }; },
    ident(_dollar, _start, _rest) { return { type: 'identifier', name: this.sourceString }; },
  });
  treeSemantics = semantics;
  return semantics;
}

/**
 * The syntax tree of one RTDB rule expression, or why it does not parse.
 * Refuses exactly what `parseExpression` refuses: text the grammar does not
 * match, brackets nested past the parser's limit, and a raw line break inside
 * a string literal.
 */
export function parseRtdbExpressionTree(raw: string): RtdbExpressionTreeResult {
  if (containsRawNewlineInRtdbString(raw)) return { ok: false, message: UNTERMINATED_STRING_LITERAL };
  const matched = matchRtdbExpression(raw);
  if (!matched.ok) return { ok: false, message: matched.message };
  try {
    return { ok: true, tree: (getTreeSemantics()(matched.match) as any).tree() as RtdbExpressionTree };
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, message: CHAINED_TERMS_MESSAGE };
    throw error;
  }
}

// ─── Printing ───────────────────────────────────────────────────────

/** Binding strength, loosest first, following the grammar's rule nesting. */
const PRECEDENCE = {
  ternary: 0,
  '||': 1,
  '&&': 2,
  equality: 3,
  comparison: 4,
  additive: 5,
  multiplicative: 6,
  unary: 7,
  postfix: 8,
  primary: 9,
} as const;

function binaryPrecedence(operator: RtdbBinaryOperator): number {
  switch (operator) {
    case '||': return PRECEDENCE['||'];
    case '&&': return PRECEDENCE['&&'];
    case '===': case '!==': case '==': case '!=': return PRECEDENCE.equality;
    case '>=': case '<=': case '>': case '<': return PRECEDENCE.comparison;
    case '+': case '-': return PRECEDENCE.additive;
    default: return PRECEDENCE.multiplicative;
  }
}

function precedenceOf(tree: RtdbExpressionTree): number {
  switch (tree.type) {
    case 'ternary': return PRECEDENCE.ternary;
    case 'binary': return binaryPrecedence(tree.operator);
    case 'unary': return PRECEDENCE.unary;
    case 'call': case 'member': case 'index': return PRECEDENCE.postfix;
    default: return PRECEDENCE.primary;
  }
}

/** A string literal's characters that print unescaped inside single quotes. */
const PLAIN_STRING_CHARS = /^[^'\\\u0000-\u001f\u007f\u2028\u2029]*$/;

/**
 * A string literal as `'value'` when its source has no backslash and the
 * value needs no escape, else its source text unchanged. A literal written
 * with an escape keeps its spelling: the only escapes captured are `\'`,
 * `\xHH` and a raw tab (r44-deploy-string-and-regex-probes, see
 * string-literal.ts); what production makes of `\uHHHH`, `\u{...}` or an
 * escaped ordinary character such as `\d` is not, so folding `'\d'` into
 * `'d'` or `'\u0041'` into `'A'` would claim an equivalence nobody has
 * observed.
 */
export function printRtdbStringLiteral(raw: string, value: string): string {
  return !raw.includes('\\') && PLAIN_STRING_CHARS.test(value) ? `'${value}'` : raw;
}

/**
 * Expression text for `tree`, with single spaces around binary operators and
 * only the parentheses the tree's shape needs. The text parses back to the
 * same tree. String literals written without a backslash print as
 * `'value'`, so `"a"` and `'a'` print alike; every other literal prints as
 * its source text.
 */
export function printRtdbExpressionTree(tree: RtdbExpressionTree): string {
  const wrap = (child: RtdbExpressionTree, minimum: number): string => {
    const text = printRtdbExpressionTree(child);
    return precedenceOf(child) < minimum ? `(${text})` : text;
  };
  switch (tree.type) {
    case 'ternary':
      // test is a LogicalOr; both branches are Ternary.
      return `${wrap(tree.test, PRECEDENCE['||'])} ? ${printRtdbExpressionTree(tree.consequent)} : ${printRtdbExpressionTree(tree.alternate)}`;
    case 'binary': {
      const p = binaryPrecedence(tree.operator);
      // Left-associative: the left operand may sit at the same level, the
      // right may not. A left-nested run of one operator prints in a loop, so
      // a chain of any length costs no call depth.
      const rights: RtdbExpressionTree[] = [];
      let left: RtdbExpressionTree = tree;
      while (left.type === 'binary' && left.operator === tree.operator) {
        rights.push(left.right);
        left = left.left;
      }
      let text = wrap(left, p);
      for (let i = rights.length - 1; i >= 0; i--) text += ` ${tree.operator} ${wrap(rights[i]!, p + 1)}`;
      return text;
    }
    case 'unary':
      return `${tree.operator}${wrap(tree.argument, PRECEDENCE.unary)}`;
    case 'call':
      return `${wrap(tree.receiver, PRECEDENCE.postfix)}.${tree.method}(${tree.args.map(printRtdbExpressionTree).join(', ')})`;
    case 'member':
      return `${wrap(tree.object, PRECEDENCE.postfix)}.${tree.property}`;
    case 'index':
      return `${wrap(tree.object, PRECEDENCE.postfix)}[${printRtdbExpressionTree(tree.index)}]`;
    case 'array':
      return `[${tree.elements.map(printRtdbExpressionTree).join(', ')}]`;
    case 'string':
      return printRtdbStringLiteral(tree.raw, tree.value);
    case 'number':
    case 'regex':
      return tree.raw;
    case 'boolean':
      return tree.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'identifier':
      return tree.name;
  }
}
