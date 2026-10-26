/**
 * Security lint over a compiled Realtime Database rules tree.
 *
 * Expression lint (`linter.ts`) reads one rule at a time. These checks read
 * the tree, because RTDB's common security mistakes come from how rules at
 * different depths combine:
 *
 *   - `.read` and `.write` cascade: a grant at a node applies to its whole
 *     subtree, and a deeper rule can only add grants, never revoke one
 *     (corpus r5-cascade-root-grant).
 *   - `.validate` runs only on a non-null new value, so a delete never runs
 *     it (corpus r21-validate-on-delete).
 *   - A key that no rule names and no `$wildcard` sibling matches runs no
 *     `.validate` (corpus r15-validate-ancestor-scope: a write carrying an
 *     unnamed key under a validated node is allowed; corpus
 *     r19-literal-and-wildcard-siblings: `$other: { ".validate": false }`
 *     rejects it).
 *   - An error while evaluating a rule fails that rule; `||` does not absorb
 *     an error on its left (corpus r26-rule-runtime-error). Constant folding
 *     here therefore folds `true || X` to true but never `X || true`.
 *
 * Findings reuse the Firestore validator's finding shape (code, severity,
 * path, message) and add the rule they sit on and a fix, as the Firestore
 * linter's findings carry one. Codes 1, 2, 3 and 6 match the meaning of
 * Firestore's SEC-1, SEC-2, SEC-3 and SEC-6.
 */
import type { Node, Semantics } from 'ohm-js';
import type { ValidationFinding } from '../../grammar/FirestoreValidator.js';
import { createRtdbExpressionSemantics, matchRtdbExpression } from '../expression-engine.js';
import type { RtdbNode, RtdbRuleExpression } from '../types.js';
import { isUnterminatedRtdbStringLiteral, unescapeRtdbStringLiteral } from './string-literal.js';

export type RtdbSecurityCode = 'RTDB-SEC-1' | 'RTDB-SEC-2' | 'RTDB-SEC-3' | 'RTDB-SEC-4' | 'RTDB-SEC-5' | 'RTDB-SEC-6' | 'RTDB-SEC-7';

export interface RtdbSecurityFinding extends ValidationFinding {
  code: RtdbSecurityCode;
  /** The rule at `path` the finding is about. */
  rule: '.read' | '.write' | '.validate';
  /** The change that removes the exposure. */
  fix: string;
}

/** What one parsed rule expression reads, as the checks need it. */
interface ExpressionFacts {
  /** The whole expression's value when it is the same for every request. */
  constant: boolean | undefined;
  readsAuth: boolean;
  readsData: boolean;
  readsRoot: boolean;
  /** Occurrences of `newData` as a root identifier. */
  newDataReads: number;
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
  newDataExistsCalls: number;
  checksNamedChildren: boolean;
}

type ConstVal = boolean | number | string | null | undefined;
type DeleteVal = ConstVal | 'exists-false' | 'delete-guard';

const NULL_FALSE_METHODS = new Set(['exists', 'isString', 'isNumber', 'isBoolean', 'hasChild', 'hasChildren']);

function isDeniedOrGuarded(v: DeleteVal): boolean {
  return v === false || v === 'exists-false' || v === 'delete-guard';
}

function isNullWhenDeleted(snapPath: string[], relSegments: string[]): boolean {
  return snapPath.length >= relSegments.length && relSegments.every((seg, i) => snapPath[i] === seg);
}

function relativeSegments(ancestorPath: string, descendantPath: string): string[] {
  const aSegs = ancestorPath.split('/').filter(Boolean);
  const dSegs = descendantPath.split('/').filter(Boolean);
  return dSegs.slice(aSegs.length);
}

function isRootNewData(node: any): boolean {
  const rel = node.newDataRelPath() as string[] | undefined;
  return rel !== undefined && rel.length === 0;
}

function collectNeq(this: any, left: any, _op: any, right: any): void {
  const acc = this.args.acc as FactsAccumulator;
  if (
    (left.newDataRelPath()?.join('/') === '.val()' && right.constVal() === null) ||
    (right.newDataRelPath()?.join('/') === '.val()' && left.constVal() === null)
  ) {
    acc.newDataExistsCalls++;
  }
  left.collect(acc);
  right.collect(acc);
}

function constNumOp(calc: (l: number, r: number) => number | undefined) {
  return function (left: any, _op: any, right: any): ConstVal {
    const l = left.constVal() as ConstVal;
    const r = right.constVal() as ConstVal;
    if (typeof l !== 'number' || typeof r !== 'number') return undefined;
    const res = calc(l, r);
    return res !== undefined && Number.isFinite(res) ? res : undefined;
  };
}

function constComparison(op: '>' | '>=' | '<' | '<=') {
  return function (left: any, _op: any, right: any): ConstVal {
    const l = left.constVal() as ConstVal;
    const r = right.constVal() as ConstVal;
    if (!((typeof l === 'number' && typeof r === 'number') || (typeof l === 'string' && typeof r === 'string'))) return undefined;
    if (op === '>') return (l as any) > (r as any);
    if (op === '>=') return (l as any) >= (r as any);
    if (op === '<') return (l as any) < (r as any);
    return (l as any) <= (r as any);
  };
}

function constEquality(equal: boolean) {
  return function (left: any, _op: any, right: any): ConstVal {
    const l = left.constVal() as ConstVal;
    const r = right.constVal() as ConstVal;
    if (l === undefined || r === undefined) return undefined;
    return equal ? l === r : l !== r;
  };
}

function evalDeleteComparison(this: any, left: any, _op: any, right: any): ConstVal {
  const relSegments = this.args.relSegments as string[];
  if (left.evalOnDelete(relSegments) === null || right.evalOnDelete(relSegments) === null) return false;
  return this.constVal();
}

function evalDeleteEq(this: any, left: any, _op: any, right: any): DeleteVal {
  const relSegments = this.args.relSegments as string[];
  const l = left.evalOnDelete(relSegments) as DeleteVal;
  const r = right.evalOnDelete(relSegments) as DeleteVal;
  if (l === null && r === null && (left.constVal() === null) !== (right.constVal() === null)) return 'delete-guard';
  if (l !== undefined && r !== undefined) return l === r;
  if ((l === null && left.constVal() !== null) || (r === null && right.constVal() !== null)) return false;
  return undefined;
}

function evalDeleteNeq(this: any, left: any, _op: any, right: any): ConstVal {
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
    _nonterminal(...children) { return children.length === 1 ? (children[0] as any).newDataRelPath() : undefined; },
    _iter() { return undefined; },
    _terminal() { return undefined; },
    Primary_paren(_open, inner, _close) { return (inner as any).newDataRelPath(); },
    ident(_dollar, _start, _rest) { return this.sourceString === 'newData' ? [] : undefined; },
    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const base = (receiver as any).newDataRelPath() as string[] | undefined;
      if (base === undefined || base[0] === '.val()') return undefined;
      const method = methodName.sourceString;
      if (method === 'val' && base.length === 0 && args.asIteration().children.length === 0) return ['.val()'];
      if (method === 'child') {
        const argList = args.asIteration().children;
        const argVal = argList.length === 1 ? ((argList[0] as any).constVal() as ConstVal) : undefined;
        return typeof argVal === 'string' ? [...base, ...argVal.split('/').filter(Boolean)] : undefined;
      }
      return method === 'parent' && base.length > 0 ? base.slice(0, -1) : undefined;
    },
  });
  semantics.addOperation('collect(acc)', {
    _nonterminal(...children) { children.forEach((c) => (c as any).collect(this.args.acc)); },
    _iter(...children) { children.forEach((c) => (c as any).collect(this.args.acc)); },
    _terminal() {},
    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const acc = this.args.acc as FactsAccumulator;
      if (isRootNewData(receiver)) {
        const method = methodName.sourceString;
        if (method === 'exists') acc.newDataExistsCalls++;
        if (method === 'hasChild' || method === 'child') acc.checksNamedChildren = true;
        if (method === 'hasChildren' && args.asIteration().children.length > 0) acc.checksNamedChildren = true;
      }
      (receiver as any).collect(acc);
      args.asIteration().children.forEach((a: any) => a.collect(acc));
    },
    Equality_strictNeq: collectNeq,
    Equality_looseNeq: collectNeq,
    CallExpr_memberAccess(receiver, _dot, _member) { (receiver as any).collect(this.args.acc); },
    ident(_dollar, _start, _rest) {
      const acc = this.args.acc as FactsAccumulator;
      const name = this.sourceString;
      if (name === 'auth') acc.readsAuth = true;
      else if (name === 'data') acc.readsData = true;
      else if (name === 'root') acc.readsRoot = true;
      else if (name === 'newData') acc.newDataReads++;
    },
  });
  semantics.addOperation('constVal', {
    _nonterminal(...children) { return children.length === 1 ? (children[0] as any).constVal() : undefined; },
    _iter() { return undefined; },
    _terminal() { return undefined; },
    Primary_paren(_open, inner, _close) { return (inner as any).constVal(); },
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
      const value = (operand as any).constVal() as ConstVal;
      return typeof value === 'boolean' ? !value : undefined;
    },
    UnaryExpr_neg(_minus, operand) {
      const value = (operand as any).constVal() as ConstVal;
      return typeof value === 'number' && Number.isFinite(-value) ? -value : undefined;
    },
    Multiplicative_mul: constNumOp((l, r) => l * r),
    Multiplicative_div: constNumOp((l, r) => (r === 0 ? undefined : l / r)),
    Multiplicative_mod: constNumOp((l, r) => (r === 0 ? undefined : l % r)),
    Additive_sub: constNumOp((l, r) => l - r),
    Additive_add(left, _op, right) {
      const l = (left as any).constVal() as ConstVal;
      const r = (right as any).constVal() as ConstVal;
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
      return foldChain(first, rest, (term) => (term as any).constVal() as ConstVal, constAnd);
    },
    LogicalOr_or(first, _ops, rest) {
      return foldChain(first, rest, (term) => (term as any).constVal() as ConstVal, constOr);
    },
    Ternary_ternary(condition, _q, whenTrue, _c, whenFalse) {
      const c = (condition as any).constVal() as ConstVal;
      if (c === true) return (whenTrue as any).constVal();
      if (c === false) return (whenFalse as any).constVal();
      return undefined;
    },
  });
  semantics.addOperation('constant', {
    _nonterminal() {
      const v = (this as any).constVal() as ConstVal;
      return typeof v === 'boolean' ? v : undefined;
    },
    _iter() { return undefined; },
    _terminal() { return undefined; },
  });
  semantics.addOperation('evalOnDelete(relSegments)', {
    _nonterminal(...children) {
      const c = (this as any).constVal() as ConstVal;
      if (c !== undefined) return c;
      return children.length === 1 ? (children[0] as any).evalOnDelete(this.args.relSegments) : undefined;
    },
    _iter() { return undefined; },
    _terminal() { return (this as any).constVal(); },
    Primary_paren(_open, inner, _close) { return (inner as any).evalOnDelete(this.args.relSegments); },
    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const relSegments = this.args.relSegments as string[];
      const snapPath = (receiver as any).newDataRelPath() as string[] | undefined;
      const method = methodName.sourceString;
      if (snapPath !== undefined && snapPath[0] !== '.val()') {
        if (isNullWhenDeleted(snapPath, relSegments)) {
          if (method === 'exists') return 'exists-false';
          if (NULL_FALSE_METHODS.has(method)) return false;
          if (method === 'val' || method === 'getPriority') return null;
        }
        const argList = args.asIteration().children;
        let childArgs: any[] = [];
        if (method === 'hasChild' && argList.length === 1) childArgs = [argList[0]!];
        else if (method === 'hasChildren' && argList.length === 1 && argList[0]!.ctorName === 'Array') {
          childArgs = argList[0]!.children[1]!.asIteration().children;
        }
        for (const el of childArgs) {
          const elVal = (el as any).constVal() as ConstVal;
          if (typeof elVal === 'string' && isNullWhenDeleted([...snapPath, ...elVal.split('/').filter(Boolean)], relSegments)) {
            return false;
          }
        }
      }
      return (receiver as any).evalOnDelete(relSegments) === null ? false : undefined;
    },
    CallExpr_memberAccess(receiver, _dot, _member) {
      return (receiver as any).evalOnDelete(this.args.relSegments) === null ? false : undefined;
    },
    UnaryExpr_not(_bang, operand) {
      const v = (operand as any).evalOnDelete(this.args.relSegments) as DeleteVal;
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
      return foldChain(first, rest, (term) => (term as any).evalOnDelete(relSegments) as DeleteVal, deleteAnd);
    },
    LogicalOr_or(first, _ops, rest) {
      const relSegments = this.args.relSegments as string[];
      return foldChain(first, rest, (term) => (term as any).evalOnDelete(relSegments) as DeleteVal, deleteOr);
    },
    Ternary_ternary(condition, _q, whenTrue, _c, whenFalse) {
      const relSegments = this.args.relSegments as string[];
      const c = (condition as any).evalOnDelete(relSegments) as DeleteVal;
      if (c === true) return (whenTrue as any).evalOnDelete(relSegments);
      if (c === false || c === 'exists-false') return (whenFalse as any).evalOnDelete(relSegments);
      if (isDeniedOrGuarded((whenTrue as any).evalOnDelete(relSegments)) && isDeniedOrGuarded((whenFalse as any).evalOnDelete(relSegments))) return false;
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
function factsOf(rule: RtdbRuleExpression | undefined): ExpressionFacts | undefined {
  if (rule === undefined || !rule.parsed.valid || rule.parsed.errors.length > 0) return undefined;
  const matched = matchRtdbExpression(rule.raw);
  if (!matched.ok) return undefined;
  const node = getFactsSemantics()(matched.match) as any;
  const acc: FactsAccumulator = { readsAuth: false, readsData: false, readsRoot: false, newDataReads: 0, newDataExistsCalls: 0, checksNamedChildren: false };
  node.collect(acc);
  const constant = node.constant() as boolean | undefined;
  return { constant, ...acc, canGrantOnDelete: (relSegments: string[]) => constant !== false && !isDeniedOrGuarded(node.evalOnDelete(relSegments) as DeleteVal) };
}

/** A node with the facts of its three rules. */
interface LintNode {
  node: RtdbNode;
  read: ExpressionFacts | undefined;
  write: ExpressionFacts | undefined;
  validate: ExpressionFacts | undefined;
  children: LintNode[];
}

function annotate(node: RtdbNode): LintNode {
  return { node, read: factsOf(node.read), write: factsOf(node.write), validate: factsOf(node.validate), children: node.children.map(annotate) };
}

/** A rule that grants for at least some requests: present, parsed, and not constant false. */
function grants(facts: ExpressionFacts | undefined): facts is ExpressionFacts {
  return facts !== undefined && facts.constant !== false;
}

/** Whether a node's own `.validate` constrains non-null values written to it. */
function hasEffectiveValidate(n: LintNode): boolean {
  const v = n.validate;
  if (v === undefined || v.constant !== undefined) return false;
  return !(v.newDataReads > 0 && v.newDataReads === v.newDataExistsCalls && !v.readsData && !v.readsRoot);
}

function hasValidateAtOrBelow(n: LintNode): boolean {
  if (hasEffectiveValidate(n)) return true;
  if (n.children.length === 0) return false;
  const nonWildcard = n.children.filter((c) => !isWildcard(c));
  return n.children.some(hasValidateAtOrBelow) && nonWildcard.every(hasValidateAtOrBelow);
}

function lastSegment(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

function isWildcard(n: LintNode): boolean {
  return lastSegment(n.node.path).startsWith('$');
}

function ruleText(rule: RtdbRuleExpression): string {
  const raw = rule.raw.trim();
  return raw.length <= 80 ? raw : `${raw.slice(0, 77)}...`;
}

function under(path: string): string {
  return path === '/' ? 'the database' : path;
}

interface WalkState {
  /** Ancestors, root first. */
  ancestors: LintNode[];
  /** An ancestor already reported RTDB-SEC-6 for its subtree. */
  unboundedAbove: boolean;
}

export function lintRtdbRuleset(root: RtdbNode): RtdbSecurityFinding[] {
  const findings: RtdbSecurityFinding[] = [];
  walk(annotate(root), { ancestors: [], unboundedAbove: false }, findings);
  return findings;
}

function walk(n: LintNode, state: WalkState, findings: RtdbSecurityFinding[]): void {
  const path = n.node.path;
  const write = n.write;
  const read = n.read;

  // RTDB-SEC-1: public write.
  if (write?.constant === true) {
    findings.push({
      code: 'RTDB-SEC-1',
      severity: 'critical',
      path,
      rule: '.write',
      message: `${path} .write is true: anyone, signed in or not, can write, replace or delete any value under ${under(path)}.`,
      fix: `Replace ${path} .write true with a condition on auth, such as "auth != null && auth.uid == $uid" on the node each user owns.`,
    });
  }

  // RTDB-SEC-2: public read.
  if (read?.constant === true) {
    const isRoot = path === '/';
    findings.push({
      code: 'RTDB-SEC-2',
      severity: isRoot ? 'critical' : 'medium',
      path,
      rule: '.read',
      message: isRoot
        ? '/ .read is true: anyone, signed in or not, can read the entire database.'
        : `${path} .read is true: anyone, signed in or not, can read everything under ${path}.`,
      fix: isRoot
        ? 'Remove .read from the root and grant .read on the subtrees clients need, with a condition on auth.'
        : `Require auth in ${path} .read ("auth != null"), or keep ${path} only if every value under it is meant to be public.`,
    });
  }

  // RTDB-SEC-3: conditional write that never reads auth.
  if (write !== undefined && write.constant === undefined && !write.readsAuth) {
    findings.push({
      code: 'RTDB-SEC-3',
      severity: 'high',
      path,
      rule: '.write',
      message: `${path} .write does not read auth: a signed-out client can write under ${under(path)} whenever "${ruleText(n.node.write!)}" holds.`,
      fix: `Add an auth condition to ${path} .write, such as "auth != null && (${ruleText(n.node.write!)})".`,
    });
  }

  // RTDB-SEC-4: a deeper rule under an ancestor grant of the same kind.
  for (const kind of ['read', 'write'] as const) {
    const own = n[kind];
    if (own === undefined) continue;
    const ruleName = kind === 'read' ? '.read' : '.write';
    const ancestor = state.ancestors.find((a) => {
      const theirs = a[kind];
      if (!grants(theirs)) return false;
      // Under an ancestor that always grants, any deeper rule other than
      // another `true` is never consulted. Under an ancestor that grants
      // conditionally, a deeper `false` is an attempt to revoke that grant.
      return theirs.constant === true ? own.constant !== true : own.constant === false;
    });
    if (ancestor === undefined) continue;
    const ancestorPath = ancestor.node.path;
    const ancestorRule = ancestor.node[kind]!;
    findings.push({
      code: 'RTDB-SEC-4',
      severity: 'high',
      path,
      rule: ruleName,
      message: ancestor[kind]!.constant === true
        ? `${path} ${ruleName} never restricts access: ${ancestorPath} ${ruleName} is true and grants ${kind} on every path under it, and a deeper rule cannot revoke an ancestor's grant.`
        : `${path} ${ruleName} false does not revoke ${ancestorPath} ${ruleName}: whenever "${ruleText(ancestorRule)}" holds, ${ancestorPath} grants ${kind} on every path under it, including ${path}.`,
      fix: `Move the grant from ${ancestorPath} ${ruleName} down to the children that need it, so that no ancestor of ${path} grants ${kind}.`,
    });
  }

  // RTDB-SEC-5: a .validate that a delete bypasses.
  const validate = n.validate;
  if (validate !== undefined && validate.constant === undefined && (validate.readsData || validate.readsRoot || validate.newDataExistsCalls > 0)) {
    const deleter = [...state.ancestors, n].find((a) => grants(a.write) && a.write.canGrantOnDelete(relativeSegments(a.node.path, path)));
    if (deleter !== undefined) {
      const deleterPath = deleter.node.path;
      const rel = relativeSegments(deleterPath, path);
      const existsGuard = rel.length > 0 && rel.every((seg) => !seg.startsWith('$')) ? `newData.child('${rel.join('/')}').exists()` : 'newData.exists()';
      findings.push({
        code: 'RTDB-SEC-5',
        severity: 'high',
        path,
        rule: '.validate',
        message: `${path} .validate does not run when ${path} is deleted: .validate runs only on a non-null new value, and ${deleterPath} .write grants without requiring ${existsGuard}, so a client it admits can delete ${path} (write null at ${deleterPath}) and bypass "${ruleText(n.node.validate!)}".`,
        fix: `Add "${existsGuard}" to ${deleterPath} .write to refuse deletes, or write the delete condition there, such as "${existsGuard} || <who may delete>".`,
      });
    }
  }

  // RTDB-SEC-6: a write with no shape or size check.
  let unboundedAbove = state.unboundedAbove;
  if (!unboundedAbove && grants(write) && write.newDataReads === write.newDataExistsCalls && !hasValidateAtOrBelow(n)) {
    unboundedAbove = true;
    findings.push({
      code: 'RTDB-SEC-6',
      severity: 'high',
      path,
      rule: '.write',
      message: `${path} .write accepts any value: no .validate rule sits at or below ${path} and the .write rule does not check newData, so a client it admits can store data of any shape and size under ${under(path)}.`,
      fix: `Add .validate rules under ${path} that fix the shape and bound sizes, such as "newData.isString() && newData.val().length <= 100", and "$other": { ".validate": false } for keys you do not name.`,
    });
  }

  // RTDB-SEC-7: named children are validated but unknown keys are not.
  const namedValidated = n.children.filter((c) => !isWildcard(c) && hasValidateAtOrBelow(c)).map((c) => lastSegment(c.node.path));
  const constrainsChildren = namedValidated.length > 0 || validate?.checksNamedChildren === true;
  const hasWildcard = n.children.some((c) => isWildcard(c) && (c.validate?.constant === false || hasValidateAtOrBelow(c)));
  const writable = [...state.ancestors, n].some((a) => grants(a.write));
  if (constrainsChildren && !hasWildcard && writable) {
    const named = namedValidated.length > 0 ? `names ${namedValidated.join(', ')} with .validate rules` : 'checks named children in .validate';
    findings.push({
      code: 'RTDB-SEC-7',
      severity: 'medium',
      path,
      rule: '.validate',
      message: `${path} ${named} but has no $other rule: a write at or above ${path} can add any other key under it, and no .validate rule checks that key.`,
      fix: `Add "$other": { ".validate": false } under ${path} to reject keys it does not name.`,
    });
  }

  const next: WalkState = { ancestors: [...state.ancestors, n], unboundedAbove };
  for (const child of n.children) walk(child, next, findings);
}
