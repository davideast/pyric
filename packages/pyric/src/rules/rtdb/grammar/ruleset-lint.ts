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
import type { Semantics } from 'ohm-js';
import type { ValidationFinding } from '../../grammar/FirestoreValidator.js';
import {
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import type { RtdbNode, RtdbRuleExpression } from '../types.js';

export type RtdbSecurityCode =
  | 'RTDB-SEC-1'
  | 'RTDB-SEC-2'
  | 'RTDB-SEC-3'
  | 'RTDB-SEC-4'
  | 'RTDB-SEC-5'
  | 'RTDB-SEC-6'
  | 'RTDB-SEC-7';

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
  /** Occurrences of `newData` as a root identifier. */
  newDataReads: number;
  /** Occurrences of `newData.exists()`. */
  newDataExistsCalls: number;
  /** `newData.hasChild(...)` or `newData.hasChildren([...])`: a check on named children. */
  checksNamedChildren: boolean;
}

interface FactsAccumulator {
  readsAuth: boolean;
  readsData: boolean;
  newDataReads: number;
  newDataExistsCalls: number;
  checksNamedChildren: boolean;
}

let factsSemantics: Semantics | undefined;

function getFactsSemantics(): Semantics {
  if (factsSemantics) return factsSemantics;
  const semantics = createRtdbExpressionSemantics();
  semantics.addOperation('collect(acc)', {
    _nonterminal(...children) {
      children.forEach((c) => (c as any).collect(this.args.acc));
    },
    _iter(...children) {
      children.forEach((c) => (c as any).collect(this.args.acc));
    },
    _terminal() {},
    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const acc = this.args.acc as FactsAccumulator;
      if (receiver.sourceString === 'newData') {
        const method = methodName.sourceString;
        if (method === 'exists') acc.newDataExistsCalls++;
        if (method === 'hasChild') acc.checksNamedChildren = true;
        if (method === 'hasChildren' && args.asIteration().children.length > 0) {
          acc.checksNamedChildren = true;
        }
      }
      // The method name is not an identifier; only the receiver and the
      // arguments are read.
      (receiver as any).collect(acc);
      args.asIteration().children.forEach((a: any) => a.collect(acc));
    },
    CallExpr_memberAccess(receiver, _dot, _member) {
      (receiver as any).collect(this.args.acc);
    },
    ident(_dollar, _start, _rest) {
      const acc = this.args.acc as FactsAccumulator;
      const name = this.sourceString;
      if (name === 'auth') acc.readsAuth = true;
      else if (name === 'data') acc.readsData = true;
      else if (name === 'newData') acc.newDataReads++;
    },
  });
  semantics.addOperation('constant', {
    _nonterminal(...children) {
      return children.length === 1 ? (children[0] as any).constant() : undefined;
    },
    _iter() {
      return undefined;
    },
    _terminal() {
      return undefined;
    },
    Primary_paren(_open, inner, _close) {
      return (inner as any).constant();
    },
    bool_true(_true) {
      return true;
    },
    bool_false(_false) {
      return false;
    },
    UnaryExpr_not(_bang, operand) {
      const value = (operand as any).constant() as boolean | undefined;
      return value === undefined ? undefined : !value;
    },
    LogicalAnd_and(left, _op, right) {
      const l = (left as any).constant() as boolean | undefined;
      if (l === false) return false;
      const r = (right as any).constant() as boolean | undefined;
      // `X && false` never grants: X is false, true, or an error, and an
      // error fails the rule.
      if (r === false) return false;
      return l === true ? r : undefined;
    },
    LogicalOr_or(left, _op, right) {
      const l = (left as any).constant() as boolean | undefined;
      if (l === true) return true;
      // An error on the left of `||` fails the rule, so `X || true` is not
      // constant unless X is.
      if (l === false) return (right as any).constant();
      return undefined;
    },
    Ternary_ternary(condition, _q, whenTrue, _c, whenFalse) {
      const c = (condition as any).constant() as boolean | undefined;
      if (c === true) return (whenTrue as any).constant();
      if (c === false) return (whenFalse as any).constant();
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
  const acc: FactsAccumulator = {
    readsAuth: false,
    readsData: false,
    newDataReads: 0,
    newDataExistsCalls: 0,
    checksNamedChildren: false,
  };
  node.collect(acc);
  return { constant: node.constant() as boolean | undefined, ...acc };
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
  return {
    node,
    read: factsOf(node.read),
    write: factsOf(node.write),
    validate: factsOf(node.validate),
    children: node.children.map(annotate),
  };
}

/** A rule that grants for at least some requests: present, parsed, and not constant false. */
function grants(facts: ExpressionFacts | undefined): facts is ExpressionFacts {
  return facts !== undefined && facts.constant !== false;
}

function hasValidateAtOrBelow(n: LintNode): boolean {
  return n.node.validate !== undefined || n.children.some(hasValidateAtOrBelow);
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
  if (validate !== undefined && (validate.readsData || validate.newDataExistsCalls > 0)) {
    const deleter = [...state.ancestors, n].find((a) => grants(a.write) && a.write.newDataReads === 0);
    if (deleter !== undefined) {
      const deleterPath = deleter.node.path;
      findings.push({
        code: 'RTDB-SEC-5',
        severity: 'high',
        path,
        rule: '.validate',
        message: `${path} .validate does not run when ${path} is deleted: .validate runs only on a non-null new value, and ${deleterPath} .write grants without reading newData, so a client it admits can delete ${path} (write null at ${deleterPath}) and bypass "${ruleText(n.node.validate!)}".`,
        fix: `Add "newData.exists()" to ${deleterPath} .write to refuse deletes, or write the delete condition there, such as "newData.exists() || <who may delete>".`,
      });
    }
  }

  // RTDB-SEC-6: a write with no shape or size check.
  let unboundedAbove = state.unboundedAbove;
  if (
    !unboundedAbove &&
    grants(write) &&
    write.newDataReads === write.newDataExistsCalls &&
    !hasValidateAtOrBelow(n)
  ) {
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
  const namedValidated = n.children
    .filter((c) => !isWildcard(c) && c.node.validate !== undefined)
    .map((c) => lastSegment(c.node.path));
  const constrainsChildren = namedValidated.length > 0 || validate?.checksNamedChildren === true;
  const hasWildcard = n.children.some(isWildcard);
  const writable = [...state.ancestors, n].some((a) => grants(a.write));
  if (constrainsChildren && !hasWildcard && writable) {
    const named = namedValidated.length > 0
      ? `names ${namedValidated.join(', ')} with .validate rules`
      : 'checks named children in .validate';
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
