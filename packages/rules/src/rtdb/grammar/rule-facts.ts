/**
 * What one RTDB rule expression reads and when it is constant, as the
 * security lint in `ruleset-lint.ts` needs it.
 *
 * Constant folding follows the rules language's error semantics: an error
 * while evaluating a rule fails that rule, and `||` does not absorb an error
 * on its left (corpus r26-rule-runtime-error), so `true || X` folds to true
 * but `X || true` does not. Each rule is folded once for a signed-out
 * request and once for a signed-in one: `auth`, `auth.uid` and
 * `auth.token.<claim>` are null for a signed-out client without error
 * (corpus r49), so a rule over `auth` alone has a value in each case.
 */
import type { Node, Semantics } from 'ohm-js';
import { createRtdbExpressionSemantics, matchRtdbExpression } from '../expression-engine.js';
import type { RtdbRuleExpression } from '../types.js';
import { isUnterminatedRtdbStringLiteral, unescapeRtdbStringLiteral } from './string-literal.js';

/** What one parsed rule expression reads, as the checks need it. */
export interface ExpressionFacts {
  /** The whole expression's value when it is the same for every request. */
  constant: boolean | undefined;
  /** Its value for every signed-out request, when that is fixed. */
  signedOut: boolean | undefined;
  /** Its value for every signed-in request, when that is fixed. */
  signedIn: boolean | undefined;
  readsAuth: boolean;
  readsData: boolean;
  readsRoot: boolean;
  /** Occurrences of `newData` as a root identifier. */
  newDataReads: number;
  /** Reads of `newData` that leave the node through `parent()`, reading another node's new value. */
  newDataEscapes: number;
  /** Occurrences of `newData.exists()` or `newData.val() != null`. */
  newDataExistsCalls: number;
  /** `newData.child(...)`, `newData.hasChild(...)`, or `newData.hasChildren([...])`: a check on named children. */
  checksNamedChildren: boolean;
  /** Whether this rule can evaluate to `true` when the descendant at `relSegments` is deleted (`null`). */
  canGrantOnDelete: (relSegments: string[]) => boolean;
}

interface FactsAccumulator {
  readsAuth: boolean;
  readsData: boolean;
  readsRoot: boolean;
  newDataReads: number;
  newDataEscapes: number;
  newDataExistsCalls: number;
  checksNamedChildren: boolean;
}

/**
 * A value known to be non-null and nothing more: a path variable, or `auth`
 * and `auth.uid` for a signed-in client.
 */
const NON_NULL: unique symbol = Symbol('non-null');

type ConstVal = boolean | number | string | null | typeof NON_NULL | undefined;

/**
 * Which requests a fold assumes: any request, a signed-out one (`auth` is
 * null), or a signed-in one (`auth` and `auth.uid` are non-null). Signed out,
 * `auth` and the members r49 reads from it are null without error (r49: "SP-5:
 * auth.uid == null signed out", "SP-5: auth.token.admin != true signed out"
 * and "SP-5 control: auth == null signed out" all ALLOW), so a rule over
 * `auth` alone has a value in each case even where `X || true` would not
 * fold for an X that may error (r26).
 */
type AuthCase = 'any' | 'signed-out' | 'signed-in';

/**
 * A receiver whose member reads null for a signed-out client: `auth` or
 * `auth.token`, so `auth.uid` and `auth.token.admin`, the reads r49
 * captures. Any other read through a null, such as `auth.uid.length`, is not
 * captured (the simulator raises an error there) and is not folded.
 */
const AUTH_MEMBER_RECEIVER = /^auth(\s*\.\s*token)?$/;

/** The `any` case folds as it always has: literals only. */
function identValue(name: string, world: AuthCase): ConstVal {
  if (world === 'any') return undefined;
  if (name.startsWith('$')) return NON_NULL;
  if (name !== 'auth') return undefined;
  return world === 'signed-out' ? null : NON_NULL;
}

function authMemberValue(receiver: Node, member: string, world: AuthCase): ConstVal {
  if (!AUTH_MEMBER_RECEIVER.test(receiver.sourceString)) return undefined;
  if (world === 'signed-out') return null;
  return world === 'signed-in' && member === 'uid' && receiver.sourceString === 'auth' ? NON_NULL : undefined;
}
type DeleteVal = ConstVal | 'exists-false' | 'delete-guard';

const NULL_FALSE_METHODS = new Set(['exists', 'isString', 'isNumber', 'isBoolean', 'hasChild', 'hasChildren']);

function isDeniedOrGuarded(v: DeleteVal): boolean {
  return v === false || v === 'exists-false' || v === 'delete-guard';
}

function isNullWhenDeleted(snapPath: string[], relSegments: string[]): boolean {
  return snapPath.length >= relSegments.length && relSegments.every((seg, i) => snapPath[i] === seg);
}


function isRootNewData(node: Node): boolean {
  const rel = node.newDataRelPath() as string[] | undefined;
  return rel !== undefined && rel.length === 0;
}

function collectNeq(this: Node, left: Node, _op: Node, right: Node): void {
  const acc = this.args.acc as FactsAccumulator;
  if (
    (left.newDataRelPath()?.join('/') === '.val()' && right.constIn('any') === null) ||
    (right.newDataRelPath()?.join('/') === '.val()' && left.constIn('any') === null)
  ) {
    acc.newDataExistsCalls++;
  }
  left.collect(acc);
  right.collect(acc);
}

function constNumOp(calc: (l: number, r: number) => number | undefined) {
  return function (this: Node, left: Node, _op: Node, right: Node): ConstVal {
    const l = left.constIn(this.args.world) as ConstVal;
    const r = right.constIn(this.args.world) as ConstVal;
    if (typeof l !== 'number' || typeof r !== 'number') return undefined;
    const res = calc(l, r);
    return res !== undefined && Number.isFinite(res) ? res : undefined;
  };
}

function constComparison(op: '>' | '>=' | '<' | '<=') {
  return function (this: Node, left: Node, _op: Node, right: Node): ConstVal {
    const l = left.constIn(this.args.world) as ConstVal;
    const r = right.constIn(this.args.world) as ConstVal;
    if (!((typeof l === 'number' && typeof r === 'number') || (typeof l === 'string' && typeof r === 'string'))) return undefined;
    if (op === '>') return l > r;
    if (op === '>=') return l >= r;
    if (op === '<') return l < r;
    return l <= r;
  };
}

function constEquality(equal: boolean) {
  return function (this: Node, left: Node, _op: Node, right: Node): ConstVal {
    const l = left.constIn(this.args.world) as ConstVal;
    const r = right.constIn(this.args.world) as ConstVal;
    if (l === undefined || r === undefined) return undefined;
    if (l === NON_NULL || r === NON_NULL) {
      // A value known only to be non-null equals null never, and anything else unknowably.
      if (l !== null && r !== null) return undefined;
      return !equal;
    }
    return equal ? l === r : l !== r;
  };
}

function evalDeleteComparison(this: Node, left: Node, _op: Node, right: Node): ConstVal {
  const relSegments = this.args.relSegments as string[];
  if (left.evalOnDelete(relSegments) === null || right.evalOnDelete(relSegments) === null) return false;
  return this.constIn('any');
}

function evalDeleteEq(this: Node, left: Node, _op: Node, right: Node): DeleteVal {
  const relSegments = this.args.relSegments as string[];
  const l = left.evalOnDelete(relSegments) as DeleteVal;
  const r = right.evalOnDelete(relSegments) as DeleteVal;
  if (l === null && r === null && (left.constIn('any') === null) !== (right.constIn('any') === null)) return 'delete-guard';
  if (l !== undefined && r !== undefined) return l === r;
  if ((l === null && left.constIn('any') !== null) || (r === null && right.constIn('any') !== null)) return false;
  return undefined;
}

function evalDeleteNeq(this: Node, left: Node, _op: Node, right: Node): ConstVal {
  const relSegments = this.args.relSegments as string[];
  const l = left.evalOnDelete(relSegments) as ConstVal;
  const r = right.evalOnDelete(relSegments) as ConstVal;
  return l !== undefined && r !== undefined ? l !== r : undefined;
}

/**
 * Folds a `||` or `&&` chain, which the grammar matches flat, left to right in
 * a loop: the value the left-nested pairs `((a || b) || c)` would give, at any
 * length. `step` sees the value so far and reads the next term only if it
 * needs it.
 */
function foldChain<V>(first: Node, rest: Node, valueOf: (term: Node) => V, step: (left: V, right: () => V) => V): V {
  let value = valueOf(first);
  for (const term of rest.children) value = step(value, () => valueOf(term));
  return value;
}

function constAnd(l: ConstVal, right: () => ConstVal): ConstVal {
  if (l === false) return false;
  // An error on the left of `&&` fails the rule (corpus r41), so `X && false`
  // is not constant false unless X is constant boolean.
  if (l !== true) return undefined;
  const r = right();
  return typeof r === 'boolean' ? r : undefined;
}

function constOr(l: ConstVal, right: () => ConstVal): ConstVal {
  if (l === true) return true;
  // An error on the left of `||` fails the rule, so `X || true` is not
  // constant unless X is.
  if (l !== false) return undefined;
  const r = right();
  return typeof r === 'boolean' ? r : undefined;
}

function deleteAnd(l: DeleteVal, right: () => DeleteVal): DeleteVal {
  const r = right();
  if (l === false || l === 'exists-false' || r === false || r === 'exists-false') return false;
  if (l === 'delete-guard' || r === 'delete-guard') return 'delete-guard';
  return l === true && r === true ? true : undefined;
}

function deleteOr(l: DeleteVal, right: () => DeleteVal): DeleteVal {
  if (l === true) return true;
  const r = right();
  if (isDeniedOrGuarded(l) && isDeniedOrGuarded(r)) {
    return l === 'delete-guard' || r === 'delete-guard' ? 'delete-guard' : false;
  }
  return isDeniedOrGuarded(l) && r === true ? true : undefined;
}

let factsSemantics: Semantics | undefined;

function getFactsSemantics(): Semantics {
  if (factsSemantics) return factsSemantics;
  const semantics = createRtdbExpressionSemantics();
  semantics.addOperation('newDataRelPath', {
    _nonterminal(...children) { return children.length === 1 ? children[0]!.newDataRelPath() : undefined; },
    _iter() { return undefined; },
    _terminal() { return undefined; },
    Primary_paren(_open, inner, _close) { return inner.newDataRelPath(); },
    ident(_dollar, _start, _rest) { return this.sourceString === 'newData' ? [] : undefined; },
    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const base = receiver.newDataRelPath() as string[] | undefined;
      if (base === undefined || base[0] === '.val()') return undefined;
      const method = methodName.sourceString;
      if (method === 'val' && base.length === 0 && args.asIteration().children.length === 0) return ['.val()'];
      if (method === 'child') {
        const argList = args.asIteration().children;
        const argVal = argList.length === 1 ? (argList[0]!.constIn('any') as ConstVal) : undefined;
        return typeof argVal === 'string' ? [...base, ...argVal.split('/').filter(Boolean)] : undefined;
      }
      return method === 'parent' && base.length > 0 ? base.slice(0, -1) : undefined;
    },
  });
  semantics.addOperation('collect(acc)', {
    _nonterminal(...children) { children.forEach((c) => c.collect(this.args.acc)); },
    _iter(...children) { children.forEach((c) => c.collect(this.args.acc)); },
    _terminal() {},
    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const acc = this.args.acc as FactsAccumulator;
      if (isRootNewData(receiver)) {
        const method = methodName.sourceString;
        if (method === 'exists') acc.newDataExistsCalls++;
        if (method === 'parent') acc.newDataEscapes++;
        if (method === 'hasChild' || method === 'child') acc.checksNamedChildren = true;
        if (method === 'hasChildren' && args.asIteration().children.length > 0) acc.checksNamedChildren = true;
      }
      receiver.collect(acc);
      args.asIteration().children.forEach((a: Node) => a.collect(acc));
    },
    Equality_strictNeq: collectNeq,
    Equality_looseNeq: collectNeq,
    CallExpr_memberAccess(receiver, _dot, _member) { receiver.collect(this.args.acc); },
    ident(_dollar, _start, _rest) {
      const acc = this.args.acc as FactsAccumulator;
      const name = this.sourceString;
      if (name === 'auth') acc.readsAuth = true;
      else if (name === 'data') acc.readsData = true;
      else if (name === 'root') acc.readsRoot = true;
      else if (name === 'newData') acc.newDataReads++;
    },
  });
  semantics.addOperation('constIn(world)', {
    _nonterminal(...children) { return children.length === 1 ? children[0]!.constIn(this.args.world) : undefined; },
    _iter() { return undefined; },
    _terminal() { return undefined; },
    Primary_paren(_open, inner, _close) { return inner.constIn(this.args.world); },
    ident(_dollar, _start, _rest) { return identValue(this.sourceString, this.args.world as AuthCase); },
    CallExpr_memberAccess(receiver, _dot, member) {
      return authMemberValue(receiver, member.sourceString, this.args.world as AuthCase);
    },
    bool_true(_true) { return true; },
    bool_false(_false) { return false; },
    null(_null) { return null; },
    number(_n) {
      const n = Number(this.sourceString);
      return Number.isFinite(n) ? n : undefined;
    },
    string_single(_open, _chars, _close) {
      return isUnterminatedRtdbStringLiteral(this.sourceString) ? undefined : unescapeRtdbStringLiteral(this.sourceString);
    },
    string_double(_open, _chars, _close) {
      return isUnterminatedRtdbStringLiteral(this.sourceString) ? undefined : unescapeRtdbStringLiteral(this.sourceString);
    },
    UnaryExpr_not(_bang, operand) {
      const value = operand.constIn(this.args.world) as ConstVal;
      return typeof value === 'boolean' ? !value : undefined;
    },
    UnaryExpr_neg(_minus, operand) {
      const value = operand.constIn(this.args.world) as ConstVal;
      return typeof value === 'number' && Number.isFinite(-value) ? -value : undefined;
    },
    Multiplicative_mul: constNumOp((l, r) => l * r),
    Multiplicative_div: constNumOp((l, r) => (r === 0 ? undefined : l / r)),
    Multiplicative_mod: constNumOp((l, r) => (r === 0 ? undefined : l % r)),
    Additive_sub: constNumOp((l, r) => l - r),
    Additive_add(left, _op, right) {
      const l = left.constIn(this.args.world) as ConstVal;
      const r = right.constIn(this.args.world) as ConstVal;
      if (typeof l === 'number' && typeof r === 'number') return Number.isFinite(l + r) ? l + r : undefined;
      return typeof l === 'string' && typeof r === 'string' ? l + r : undefined;
    },
    Comparison_gt: constComparison('>'),
    Comparison_gte: constComparison('>='),
    Comparison_lt: constComparison('<'),
    Comparison_lte: constComparison('<='),
    Equality_strictEq: constEquality(true),
    Equality_looseEq: constEquality(true),
    Equality_strictNeq: constEquality(false),
    Equality_looseNeq: constEquality(false),
    LogicalAnd_and(first, _ops, rest) {
      return foldChain(first, rest, (term) => term.constIn(this.args.world) as ConstVal, constAnd);
    },
    LogicalOr_or(first, _ops, rest) {
      return foldChain(first, rest, (term) => term.constIn(this.args.world) as ConstVal, constOr);
    },
    Ternary_ternary(condition, _q, whenTrue, _c, whenFalse) {
      const c = condition.constIn(this.args.world) as ConstVal;
      if (c === true) return whenTrue.constIn(this.args.world);
      if (c === false) return whenFalse.constIn(this.args.world);
      return undefined;
    },
  });
  semantics.addOperation('constant(world)', {
    _nonterminal() {
      const v = this.constIn(this.args.world) as ConstVal;
      return typeof v === 'boolean' ? v : undefined;
    },
    _iter() { return undefined; },
    _terminal() { return undefined; },
  });
  semantics.addOperation('evalOnDelete(relSegments)', {
    _nonterminal(...children) {
      const c = this.constIn('any') as ConstVal;
      if (c !== undefined) return c;
      return children.length === 1 ? children[0]!.evalOnDelete(this.args.relSegments) : undefined;
    },
    _iter() { return undefined; },
    _terminal() { return this.constIn('any'); },
    Primary_paren(_open, inner, _close) { return inner.evalOnDelete(this.args.relSegments); },
    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const relSegments = this.args.relSegments as string[];
      const snapPath = receiver.newDataRelPath() as string[] | undefined;
      const method = methodName.sourceString;
      if (snapPath !== undefined && snapPath[0] !== '.val()') {
        if (isNullWhenDeleted(snapPath, relSegments)) {
          if (method === 'exists') return 'exists-false';
          if (NULL_FALSE_METHODS.has(method)) return false;
          if (method === 'val' || method === 'getPriority') return null;
        }
        const argList = args.asIteration().children;
        let childArgs: Node[] = [];
        if (method === 'hasChild' && argList.length === 1) childArgs = [argList[0]!];
        else if (method === 'hasChildren' && argList.length === 1 && argList[0]!.ctorName === 'Array') {
          childArgs = argList[0]!.children[1]!.asIteration().children;
        }
        for (const el of childArgs) {
          const elVal = el.constIn('any') as ConstVal;
          if (typeof elVal === 'string' && isNullWhenDeleted([...snapPath, ...elVal.split('/').filter(Boolean)], relSegments)) {
            return false;
          }
        }
      }
      return receiver.evalOnDelete(relSegments) === null ? false : undefined;
    },
    CallExpr_memberAccess(receiver, _dot, _member) {
      return receiver.evalOnDelete(this.args.relSegments) === null ? false : undefined;
    },
    UnaryExpr_not(_bang, operand) {
      const v = operand.evalOnDelete(this.args.relSegments) as DeleteVal;
      if (v === 'exists-false') return 'delete-guard';
      if (v === 'delete-guard') return false;
      return typeof v === 'boolean' ? !v : undefined;
    },
    Comparison_gt: evalDeleteComparison,
    Comparison_gte: evalDeleteComparison,
    Comparison_lt: evalDeleteComparison,
    Comparison_lte: evalDeleteComparison,
    Equality_strictEq: evalDeleteEq,
    Equality_looseEq: evalDeleteEq,
    Equality_strictNeq: evalDeleteNeq,
    Equality_looseNeq: evalDeleteNeq,
    LogicalAnd_and(first, _ops, rest) {
      const relSegments = this.args.relSegments as string[];
      return foldChain(first, rest, (term) => term.evalOnDelete(relSegments) as DeleteVal, deleteAnd);
    },
    LogicalOr_or(first, _ops, rest) {
      const relSegments = this.args.relSegments as string[];
      return foldChain(first, rest, (term) => term.evalOnDelete(relSegments) as DeleteVal, deleteOr);
    },
    Ternary_ternary(condition, _q, whenTrue, _c, whenFalse) {
      const relSegments = this.args.relSegments as string[];
      const c = condition.evalOnDelete(relSegments) as DeleteVal;
      if (c === true) return whenTrue.evalOnDelete(relSegments);
      if (c === false || c === 'exists-false') return whenFalse.evalOnDelete(relSegments);
      if (isDeniedOrGuarded(whenTrue.evalOnDelete(relSegments)) && isDeniedOrGuarded(whenFalse.evalOnDelete(relSegments))) return false;
      return undefined;
    },
  });
  factsSemantics = semantics;
  return semantics;
}

/**
 * The facts of a rule expression, or undefined when it does not parse or
 * production refuses it at deploy: a refused rule never runs, so it grants
 * nothing to lint.
 */
export function factsOf(rule: RtdbRuleExpression | undefined): ExpressionFacts | undefined {
  if (rule === undefined || !rule.parsed.valid || rule.parsed.errors.length > 0) return undefined;
  const matched = matchRtdbExpression(rule.raw);
  if (!matched.ok) return undefined;
  const node = getFactsSemantics()(matched.match);
  const acc: FactsAccumulator = { readsAuth: false, readsData: false, readsRoot: false, newDataReads: 0, newDataEscapes: 0, newDataExistsCalls: 0, checksNamedChildren: false };
  node.collect(acc);
  const signedOut = node.constant('signed-out') as boolean | undefined;
  const signedIn = node.constant('signed-in') as boolean | undefined;
  const constant = signedOut !== undefined && signedOut === signedIn ? signedOut : undefined;
  return { constant, signedOut, signedIn, ...acc, canGrantOnDelete: (relSegments: string[]) => constant !== false && !isDeniedOrGuarded(node.evalOnDelete(relSegments) as DeleteVal) };
}
