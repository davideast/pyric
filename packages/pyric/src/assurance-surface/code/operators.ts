/**
 * Abstract evaluation of JavaScript unary, binary, logical, coalescing,
 * `typeof`, `in`, and `==`/`===` operators with constant folding.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import { hole, interpolate } from './paths.js';
import {
  alternatives,
  concatParts,
  definiteTruthiness,
  lit,
  literalText,
  union,
  unknown,
  type AVal,
  type Env,
} from './values.js';

export function unwrapExpr(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

export function typeofLeaf(a: AVal): AVal {
  switch (a.k) {
    case 'str':
      return lit('string');
    case 'num':
      return lit('number');
    case 'bool':
      return lit('boolean');
    case 'undefined':
      return lit('undefined');
    case 'fn':
    case 'class':
      return lit('function');
    case 'obj':
    case 'arr':
    case 'null':
    case 'ref':
    case 'fieldValue':
    case 'instance':
    case 'db':
    case 'auth':
    case 'authUser':
    case 'credential':
    case 'batch':
    case 'tx':
    case 'onDisconnect':
    case 'constraint':
    case 'ns':
      return lit('object');
    default:
      return { k: 'str', parts: [hole('typeof')] };
  }
}

export function evalTypeOf(ev: Evaluator, expr: ts.Expression, env: Env | undefined): AVal {
  const alts = alternatives(ev.force(ev.eval(expr, env)));
  if (alts.length === 0) return { k: 'str', parts: [hole('typeof')] };
  return union(alts.map((a) => typeofLeaf(a)));
}

export function evalPrefixUnary(ev: Evaluator, node: ts.PrefixUnaryExpression, env: Env | undefined): AVal {
  if (node.operator === ts.SyntaxKind.ExclamationToken) {
    const t = definiteTruthiness(ev.force(ev.eval(node.operand, env)));
    if (t !== undefined) return { k: 'bool', value: !t };
    return { k: 'bool' };
  }
  if (node.operator === ts.SyntaxKind.MinusToken) {
    const op = ev.force(ev.eval(node.operand, env));
    if (op.k === 'num' && op.value !== undefined) return { k: 'num', value: -op.value };
    return { k: 'num' };
  }
  if (node.operator === ts.SyntaxKind.PlusToken) {
    const op = ev.force(ev.eval(node.operand, env));
    if (op.k === 'num' && op.value !== undefined) return op;
    return { k: 'num' };
  }
  return { k: 'num' };
}

export function evalBinary(ev: Evaluator, node: ts.BinaryExpression, env: Env | undefined): AVal {
  const op = node.operatorToken.kind;
  if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.BarBarEqualsToken) {
    const leftRaw = ev.eval(node.left, env);
    const left = ev.force(leftRaw);
    const lt = definiteTruthiness(left);
    if (lt === true && !ts.isOptionalChain(node.left)) return leftRaw;
    if (lt === false) return ev.eval(node.right, env);
    const rightRaw = ev.eval(node.right, env);
    const right = ev.force(rightRaw);
    const lAlts = alternatives(left);
    const rAlts = alternatives(right);
    if (lAlts.length > 0 && rAlts.length > 0 && lAlts.every((a) => a.k === 'bool') && rAlts.every((a) => a.k === 'bool')) {
      if (definiteTruthiness(right) === true) return { k: 'bool', value: true };
      return { k: 'bool' };
    }
    const keptLeft = lAlts.filter((a) => definiteTruthiness(a) !== false);
    return union([...keptLeft, rightRaw]);
  }
  if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    const leftRaw = ev.eval(node.left, env);
    const left = ev.force(leftRaw);
    const lAlts = alternatives(left);
    const canBeNullish =
      ts.isOptionalChain(node.left) ||
      lAlts.length === 0 ||
      lAlts.some((a) => a.k === 'null' || a.k === 'undefined' || a.k === 'unknown');
    if (!canBeNullish) return leftRaw;
    const nonNullish = lAlts.filter((a) => a.k !== 'null' && a.k !== 'undefined');
    if (nonNullish.length === 0 && !ts.isOptionalChain(node.left)) return ev.eval(node.right, env);
    return union([...nonNullish, ev.eval(node.right, env)]);
  }
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
    const leftRaw = ev.eval(node.left, env);
    const left = ev.force(leftRaw);
    const lt = definiteTruthiness(left);
    if (lt === false) return left;
    if (lt === true) return ev.eval(node.right, env);
    const rightRaw = ev.eval(node.right, env);
    const right = ev.force(rightRaw);
    const lAlts = alternatives(left);
    const rAlts = alternatives(right);
    if (rAlts.length > 0 && rAlts.every((a) => a.k === 'bool')) {
      if (definiteTruthiness(right) === false && lAlts.length > 0 && lAlts.every((a) => a.k === 'bool')) {
        return { k: 'bool', value: false };
      }
      return { k: 'bool' };
    }
    return rightRaw;
  }
  if (op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken) {
    return ev.eval(node.right, env);
  }
  if (op === ts.SyntaxKind.PlusToken) {
    const l = ev.force(ev.eval(node.left, env));
    const r = ev.force(ev.eval(node.right, env));
    if (l.k === 'num' && r.k === 'num') {
      if (l.value !== undefined && r.value !== undefined) return { k: 'num', value: l.value + r.value };
      return { k: 'num' };
    }
    if (l.k === 'str' || r.k === 'str') {
      return {
        k: 'str',
        parts: concatParts(interpolate(l, node.left, (x) => ev.force(x)), interpolate(r, node.right, (x) => ev.force(x))),
      };
    }
    return unknown('`+` of values that are not strings');
  }
  if (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken
  ) {
    const l = ev.force(ev.eval(node.left, env));
    const r = ev.force(ev.eval(node.right, env));
    const strict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const negate = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
    return evalEquality(l, r, strict, negate);
  }
  if (op === ts.SyntaxKind.InKeyword) {
    return evalInKeyword(ev, node, env);
  }
  if (
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken ||
    op === ts.SyntaxKind.InstanceOfKeyword
  ) {
    return { k: 'bool' };
  }
  return { k: 'num' };
}

function evalInKeyword(ev: Evaluator, node: ts.BinaryExpression, env: Env | undefined): AVal {
  const keyText = literalText(ev.force(ev.eval(node.left, env)));
  const rAlts = alternatives(ev.force(ev.eval(node.right, env)));
  if (keyText !== null && rAlts.length > 0) {
    if (rAlts.every((a) => a.k === 'obj' && a.props.has(keyText) && !a.optional.has(keyText))) {
      return { k: 'bool', value: true };
    }
    const notArrayProp = keyText !== 'length' && !/^\d+$/.test(keyText);
    const definitelyAbsent = rAlts.every(
      (a) =>
        (a.k === 'obj' && !a.props.has(keyText) && !a.open && a.computed.length === 0) ||
        (a.k === 'arr' && notArrayProp) ||
        a.k === 'fieldValue' ||
        a.k === 'ref',
    );
    if (definitelyAbsent) return { k: 'bool', value: false };
  }
  return { k: 'bool' };
}

type JsEqKind = 'null' | 'undefined' | 'bool' | 'num' | 'str' | 'fn' | 'obj' | 'unknown';

function jsEqKind(a: AVal): JsEqKind {
  switch (a.k) {
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'bool':
      return 'bool';
    case 'num':
      return 'num';
    case 'str':
      return 'str';
    case 'fn':
    case 'class':
      return 'fn';
    case 'obj':
    case 'arr':
    case 'ref':
    case 'fieldValue':
    case 'instance':
    case 'db':
    case 'auth':
    case 'authUser':
    case 'credential':
    case 'batch':
    case 'tx':
    case 'onDisconnect':
    case 'constraint':
    case 'ns':
      return 'obj';
    default:
      return 'unknown';
  }
}

function primitiveOf(a: AVal): string | number | boolean | undefined {
  if (a.k === 'bool') return a.value;
  if (a.k === 'num') return a.value;
  if (a.k === 'str') return literalText(a) ?? undefined;
  return undefined;
}

function pairEqual(a: AVal, b: AVal, strict: boolean): boolean | undefined {
  const ka = jsEqKind(a);
  const kb = jsEqKind(b);
  if (ka === 'unknown' || kb === 'unknown') return undefined;
  if (!strict) {
    if ((ka === 'null' || ka === 'undefined') && (kb === 'null' || kb === 'undefined')) return true;
    if (ka === 'null' || ka === 'undefined' || kb === 'null' || kb === 'undefined') return false;
  }
  if (ka !== kb) {
    if (strict) return false;
    const pa = primitiveOf(a);
    const pb = primitiveOf(b);
    if (pa !== undefined && pb !== undefined) return (pa as unknown) == (pb as unknown);
    return undefined;
  }
  switch (ka) {
    case 'null':
    case 'undefined':
      return true;
    case 'bool':
      if (a.k === 'bool' && b.k === 'bool' && a.value !== undefined && b.value !== undefined) return a.value === b.value;
      return undefined;
    case 'num':
      if (a.k === 'num' && b.k === 'num' && a.value !== undefined && b.value !== undefined) return a.value === b.value;
      return undefined;
    case 'str': {
      if (a.k !== 'str' || b.k !== 'str') return undefined;
      const ta = literalText(a);
      const tb = literalText(b);
      if (ta !== null && tb !== null) return ta === tb;
      if (
        a.parts[0]?.kind === 'lit' &&
        b.parts[0]?.kind === 'lit' &&
        !a.parts[0].text.startsWith(b.parts[0].text) &&
        !b.parts[0].text.startsWith(a.parts[0].text)
      ) {
        return false;
      }
      return undefined;
    }
    case 'obj':
    case 'fn':
      if (a.k !== b.k) return false;
      return undefined;
  }
}

export function evalEquality(left: AVal, right: AVal, strict: boolean, negate: boolean): AVal {
  const lAlts = alternatives(left);
  const rAlts = alternatives(right);
  if (lAlts.length === 0 || rAlts.length === 0) return { k: 'bool' };
  let allTrue = true;
  let allFalse = true;
  for (const a of lAlts) {
    for (const b of rAlts) {
      const eq = pairEqual(a, b, strict);
      if (eq !== true) allTrue = false;
      if (eq !== false) allFalse = false;
    }
  }
  if (allTrue) return { k: 'bool', value: !negate };
  if (allFalse) return { k: 'bool', value: negate };
  return { k: 'bool' };
}
