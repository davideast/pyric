/**
 * Canonical text for an RTDB rule expression, for asking whether two rule
 * expressions are the same rule spelled differently.
 *
 * Soundness over completeness. Every rewrite here maps an expression to one
 * that production RTDB evaluates identically for every input: the same
 * boolean or value, and an error exactly where the original errors (an error
 * fails the whole rule, with no rescue from `||` or `!`: captures
 * rules-rtdb-r17, r26, r41). Two expressions whose canonical texts are equal
 * therefore decide every request alike. When equivalence is not certain, the
 * expression is left as written, so two equivalent expressions may still print
 * differently; the reverse must never happen.
 *
 * The rewrites, each justified where it is applied below:
 *
 *  1. Whitespace and grouping parentheses are dropped, `&&` and `||`
 *     chains are regrouped left to right, and a string literal written
 *     without a backslash prints in single quotes (`"a"` is `'a'`).
 *  2. `===` is `==` and `!==` is `!=`.
 *  3. `auth.uid == null` (either operand order) is `auth == null`.
 *  4. `x.child('a/b/' + $v + '/c')` is `x.child('a').child('b').child($v).child('c')`
 *     when every concatenated part is a string literal or a `$` path variable
 *     and each `/`-separated segment is one non-empty literal or one variable.
 *  5. `a != b` is `!(a == b)`.
 *  6. The operands of `==` are ordered by their canonical text, when neither
 *     operand can raise anything but a rule runtime error and neither
 *     indexes into or builds an array.
 *
 * Deliberately not rewritten: a concatenated part that is not a literal or a
 * `$` variable, `auth.uid` included (see `childSegments`); a segment that is
 * empty or holds `.`, `#`, `$`, `[` or `]`; any string literal written with
 * a backslash escape (kept exactly as written); double negation (`!!x` is not `x`
 * for a non-boolean `x`); operand order of `&&`, `||` and the ordering
 * operators (short-circuiting and errors depend on it); and any arithmetic or
 * constant folding.
 */
import {
  parseRtdbExpressionTree,
  printRtdbExpressionTree,
  type RtdbExpressionTree,
} from './expression-tree.js';
import { isSupportedRegexFlags } from './type-rules.js';
import { CHAINED_TERMS_MESSAGE } from '../expression-engine.js';

/** Why {@link canonicalRtdbExpression} could not read its input. */
export class RtdbExpressionSyntaxError extends Error {
  constructor(readonly raw: string, message: string) {
    super(`Not an RTDB rule expression: ${message}`);
    this.name = 'RtdbExpressionSyntaxError';
  }
}

/** The methods the rules language defines on a data snapshot (the simulator's set). */
const SNAPSHOT_METHODS = new Set([
  'val', 'exists', 'hasChild', 'hasChildren', 'isString', 'isNumber',
  'isBoolean', 'child', 'parent', 'getPriority',
]);

/** The methods the rules language defines on a string (the simulator's set). */
const STRING_METHODS = new Set([
  'matches', 'contains', 'beginsWith', 'endsWith', 'replace', 'toLowerCase', 'toUpperCase',
]);

/** The bare identifiers the rules language binds. Any other bare name is unbound. */
const BOUND_IDENTIFIERS = new Set(['auth', 'data', 'newData', 'root', 'now', 'query']);

/** Characters that may not appear in a database key. */
const INVALID_KEY_CHARS = /[.#$[\]]/;

/** A string that prints as `'value'` without escapes. */
const PLAIN_STRING_CHARS = /^[^'\\\u0000-\u001f\u007f\u2028\u2029]*$/;

const isPathVariable = (tree: RtdbExpressionTree): tree is { type: 'identifier'; name: string } =>
  tree.type === 'identifier' && tree.name.startsWith('$');

const isAuthUid = (tree: RtdbExpressionTree): boolean =>
  tree.type === 'member' && tree.property === 'uid'
  && tree.object.type === 'identifier' && tree.object.name === 'auth';

/** Whether `tree` may evaluate to `undefined`: an unbound identifier. */
function mayBeUndefined(tree: RtdbExpressionTree): boolean {
  if (tree.type === 'identifier') return tree.name.startsWith('$') || !BOUND_IDENTIFIERS.has(tree.name);
  if (tree.type === 'ternary') return mayBeUndefined(tree.consequent) || mayBeUndefined(tree.alternate);
  return false;
}

/** Whether `tree` may evaluate to a data snapshot. */
function mayBeSnapshot(tree: RtdbExpressionTree): boolean {
  switch (tree.type) {
    case 'identifier': return tree.name === 'root' || tree.name === 'data' || tree.name === 'newData';
    case 'ternary': return mayBeSnapshot(tree.consequent) || mayBeSnapshot(tree.alternate);
    case 'call': return (tree.method === 'child' || tree.method === 'parent') && mayBeSnapshot(tree.receiver);
    default: return false;
  }
}

function regexCompiles(raw: string): boolean {
  const end = raw.lastIndexOf('/');
  const flags = raw.slice(end + 1);
  if (!isSupportedRegexFlags(flags)) return true; // a rule runtime error, not a crash
  try {
    new RegExp(raw.slice(1, end), flags);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether every failure `tree` can raise while it evaluates is a rule runtime
 * error, the error that fails the rule. Evaluation can also stop on a
 * construct the simulator does not evaluate (an unknown method, a method
 * called on an unbound name, a regular expression JavaScript cannot compile);
 * production refuses to deploy each of those. Reordering operands changes
 * which operand raises first, so it is applied only where every raise is the
 * same kind of failure.
 */
function raisesOnlyRuleErrors(tree: RtdbExpressionTree): boolean {
  // An explicit work list, so a long chain costs no call depth.
  const pending: RtdbExpressionTree[] = [tree];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (!raisesOnlyRuleErrorsHere(next)) return false;
    pending.push(...subexpressions(next));
  }
  return true;
}

/** The part of {@link raisesOnlyRuleErrors} that `tree`'s own node decides. */
function raisesOnlyRuleErrorsHere(tree: RtdbExpressionTree): boolean {
  switch (tree.type) {
    case 'index':
    case 'array':
      // Not followed: an array can hold a snapshot (`[data][0]`), and a
      // string method called on what an index reads out of it stops the
      // simulator rather than raising a rule error. Declining here keeps
      // `mayBeSnapshot` from having to track values through arrays.
      return false;
    case 'regex':
      return regexCompiles(tree.raw);
    case 'call':
      if (mayBeUndefined(tree.receiver)) return false;
      if (SNAPSHOT_METHODS.has(tree.method)) return true;
      return STRING_METHODS.has(tree.method) && !mayBeSnapshot(tree.receiver);
    default:
      return true;
  }
}

/** The operands {@link raisesOnlyRuleErrors} goes on to check. */
function subexpressions(tree: RtdbExpressionTree): RtdbExpressionTree[] {
  switch (tree.type) {
    case 'ternary': return [tree.test, tree.consequent, tree.alternate];
    case 'binary': return [tree.left, tree.right];
    case 'unary': return [tree.argument];
    case 'member': return [tree.object];
    case 'call': return [tree.receiver, ...tree.args];
    default: return [];
  }
}

/**
 * The operands of a chain of one logical operator, left to right. Walks with
 * an explicit stack, so a chain of any length costs no call depth.
 */
function logicalOperands(tree: RtdbExpressionTree, operator: '&&' | '||'): RtdbExpressionTree[] {
  const operands: RtdbExpressionTree[] = [];
  const pending: RtdbExpressionTree[] = [tree];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next.type === 'binary' && next.operator === operator) pending.push(next.right, next.left);
    else operands.push(next);
  }
  return operands;
}

/** The parts of a `+` chain, left to right. */
function concatenatedParts(tree: RtdbExpressionTree): RtdbExpressionTree[] {
  if (tree.type === 'binary' && tree.operator === '+') {
    return [...concatenatedParts(tree.left), ...concatenatedParts(tree.right)];
  }
  return [tree];
}

type Segment = { kind: 'literal'; text: string } | { kind: 'variable'; tree: RtdbExpressionTree };

/**
 * The path segments a `child()` argument names, or undefined when they are
 * not certain.
 *
 * Only string literals and `$` path variables qualify. A path variable is
 * bound to exactly one key of the path being evaluated, so it is one
 * non-empty segment with no `/`. Any other dynamic part is declined, and
 * `auth.uid` in particular: production child() given a key with an empty
 * segment (a custom-token uid such as `/x` or `a//b`) is not captured, so
 * `child('m/' + auth.uid)` and `child('m').child(auth.uid)` are not known to
 * agree for every uid. What is captured is that both fail for a signed-out
 * request: `'a' + null` is an error (rules-rtdb-r27-stdlib-core-patterns) and
 * `child(auth.uid)` signed out is an error (rules-rtdb-r32-method-argument-types).
 *
 * Each segment must be one non-empty literal or exactly one variable: an
 * empty segment (a leading, trailing or doubled `/`), a literal glued to a
 * variable (`'user_' + $id`), and a literal holding a character invalid in a
 * key are all declined, since production's handling of each is not captured.
 */
function childSegments(arg: RtdbExpressionTree): Segment[] | undefined {
  const segments: Array<{ text: string; variables: RtdbExpressionTree[] }> = [{ text: '', variables: [] }];
  for (const part of concatenatedParts(arg)) {
    if (part.type === 'string') {
      // A literal written with an escape is declined: production's reading
      // of most escapes is not captured (see printRtdbStringLiteral).
      if (part.raw.includes('\\')) return undefined;
      const pieces = part.value.split('/');
      segments[segments.length - 1]!.text += pieces[0]!;
      for (const piece of pieces.slice(1)) segments.push({ text: piece, variables: [] });
    } else if (isPathVariable(part)) {
      segments[segments.length - 1]!.variables.push(part);
    } else {
      return undefined;
    }
  }
  const out: Segment[] = [];
  for (const segment of segments) {
    if (segment.variables.length === 1 && segment.text === '') {
      out.push({ kind: 'variable', tree: segment.variables[0]! });
    } else if (
      segment.variables.length === 0 && segment.text !== ''
      && !INVALID_KEY_CHARS.test(segment.text) && PLAIN_STRING_CHARS.test(segment.text)
    ) {
      out.push({ kind: 'literal', text: segment.text });
    } else {
      return undefined;
    }
  }
  return out;
}

/** The canonical form of a tree whose children are already canonical. */
function canonicalNode(tree: RtdbExpressionTree): RtdbExpressionTree {
  switch (tree.type) {
    case 'binary': {
      if (tree.operator === '&&' || tree.operator === '||') {
        // Rewrite 1: `a && (b && c)` is `(a && b) && c`. Both evaluate the
        // operands left to right, stop at the first false (true for `||`),
        // and fail at the first operand that is not a boolean, so they
        // agree on every value and every error. The chain is flattened once
        // and each operand canonicalized on its own, so the cost is linear
        // in the chain's length and its depth is not spent on it.
        const operator = tree.operator;
        const operands = logicalOperands(tree, operator)
          .flatMap((operand) => logicalOperands(canonicalTree(operand), operator));
        return operands.reduce((acc, operand) => ({ type: 'binary', operator, left: acc, right: operand }));
      }
      const left = canonicalTree(tree.left);
      const right = canonicalTree(tree.right);
      switch (tree.operator) {
        // Rewrite 2: RTDB's `===` and `!==` are its `==` and `!=`: neither
        // converts types, and the simulator evaluates the pairs with the same
        // operand checks and comparison.
        case '===':
        case '==':
          return canonicalEquality(left, right);
        case '!==':
        case '!=':
          // Rewrite 5: `a != b` is `!(a == b)`. Both evaluate a, then b, with
          // the same operand checks, so they fail on exactly the same inputs
          // (an error under `!` still fails the rule: rules-rtdb-r26 DENIES
          // `!(newData.val().toUpperCase() == 'OK')` for a number, and
          // rules-rtdb-r27 DENIES `data.val() + 1 != 1` with nothing stored).
          // Otherwise `==` yields a boolean, and `!` of a boolean negates it.
          return { type: 'unary', operator: '!', argument: canonicalEquality(left, right) };
        default:
          return { ...tree, left, right };
      }
    }
    case 'call': {
      const receiver = canonicalTree(tree.receiver);
      const args = tree.args.map(canonicalTree);
      if (tree.method === 'child' && args.length === 1 && !mayBeUndefined(receiver)) {
        // Rewrite 4: child() reads its argument as a `/`-separated path, so
        // `x.child('a/' + $v)` and `x.child('a').child($v)` reach the same
        // node. The pieces are literals and path variables, which never fail
        // to evaluate except an unbound variable, and that is a rule runtime
        // error in both forms (`'a/' + undefined` and `child(undefined)`). The
        // receiver must not be unbound, or the split form would fail on the
        // first child() before reaching the variable.
        const segments = childSegments(args[0]!);
        if (segments !== undefined && segments.length > 1) {
          return segments.reduce<RtdbExpressionTree>((acc, segment) => ({
            type: 'call',
            receiver: acc,
            method: 'child',
            args: [segment.kind === 'variable'
              ? segment.tree
              : { type: 'string', raw: `'${segment.text}'`, value: segment.text }],
          }), receiver);
        }
      }
      return { ...tree, receiver, args };
    }
    case 'ternary':
      return {
        type: 'ternary',
        test: canonicalTree(tree.test),
        consequent: canonicalTree(tree.consequent),
        alternate: canonicalTree(tree.alternate),
      };
    case 'unary':
      return { ...tree, argument: canonicalTree(tree.argument) };
    case 'member':
      return { ...tree, object: canonicalTree(tree.object) };
    case 'index':
      return { ...tree, object: canonicalTree(tree.object), index: canonicalTree(tree.index) };
    case 'array':
      return { ...tree, elements: tree.elements.map(canonicalTree) };
    default:
      return tree;
  }
}

/** `left == right` in canonical form, from canonical operands. */
function canonicalEquality(left: RtdbExpressionTree, right: RtdbExpressionTree): RtdbExpressionTree {
  // Rewrite 3: `auth.uid == null` is `auth == null`. `auth` is null exactly
  // for a signed-out request, and then `auth.uid` reads null too; a signed-in
  // `auth` always carries a uid string (production: the ID token's required
  // `sub`; pyric: `SimulationInputSchema` requires `auth.uid` as a string
  // (simulation/spec.ts) and `SimulatedAuth.uid` is a required string,
  // conformance row "`auth` context" in registry/rtdb.ts). Neither operand
  // can fail. The equivalence is a claim about requests as RTDB and pyric's
  // simulate() and sandbox build them: a caller that hands
  // `evaluateRtdbExpression` an `auth` object with no `uid` (`{ token: {} }`)
  // is outside it, and there the two forms differ.
  if ((isAuthUid(left) && right.type === 'null') || (left.type === 'null' && isAuthUid(right))) {
    left = { type: 'identifier', name: 'auth' };
    right = { type: 'null' };
  }
  // Rewrite 6: `a == b` is `b == a`. Equality compares without conversion
  // and is symmetric. The order decides only which operand is evaluated, and
  // can fail, first; when both can fail only with a rule runtime error, the
  // rule fails either way.
  if (raisesOnlyRuleErrors(left) && raisesOnlyRuleErrors(right)) {
    const l = printRtdbExpressionTree(left);
    const r = printRtdbExpressionTree(right);
    if (r < l) [left, right] = [right, left];
  }
  return { type: 'binary', operator: '==', left, right };
}

/** The canonical form of a syntax tree. */
export function canonicalTree(tree: RtdbExpressionTree): RtdbExpressionTree {
  return canonicalNode(tree);
}

/**
 * Canonical text of an RTDB rule expression: two expressions with equal
 * canonical texts evaluate identically for every request. Deterministic and
 * idempotent. Throws {@link RtdbExpressionSyntaxError} for text that is not a
 * rule expression.
 */
export function canonicalRtdbExpression(raw: string): string {
  const parsed = parseRtdbExpressionTree(raw);
  if (!parsed.ok) throw new RtdbExpressionSyntaxError(raw, parsed.message);
  try {
    return printRtdbExpressionTree(canonicalTree(parsed.tree));
  } catch (error) {
    // A long chain of an operator other than `&&` and `||` still descends
    // once per term, as the parser does.
    if (error instanceof RangeError) throw new RtdbExpressionSyntaxError(raw, CHAINED_TERMS_MESSAGE);
    throw error;
  }
}
