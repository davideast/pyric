/**
 * Production's compile-time structural limits for Firestore and Storage
 * rulesets. Production rejects a ruleset that breaks one of them before any
 * request is evaluated, so the Firestore simulator, the Storage evaluator
 * and the linter read them from here and report production's own messages.
 *
 * The boundaries come from the Rules Test API capture in
 * `test/rules/linter/fixtures/compile-limits/captures.json`, identical for
 * Firestore and Storage:
 *
 * - Call depth: a chain of 21 functions on one call stack compiles and 22 is
 *   rejected with "Maximum allowed call depth of 20 is reached for
 *   [f1->...->f21] call stack.", also when no rule calls the chain.
 * - `let` bindings: 11 in one function compile and 12 are rejected with
 *   "Maximum allowed variable count of 10 for a given function has been
 *   reached."
 * - Nesting: 97 parentheses around one comparison and a right-nested `&&`
 *   chain of 49 terms compile; 98 parentheses and 50 terms are rejected with
 *   "Expression is too complex to evaluate safely." A flat chain of 98
 *   comparisons compiles and 99 is rejected with the same message. List
 *   literals, map literals and function calls nest the same way: 97 nested
 *   lists under a comparison compile and 98 are rejected.
 *
 * The production messages count one lower than the boundaries: the call
 * depth message says 20 and names 21 functions, the variable count message
 * says 10 while 11 bindings compile.
 *
 * One more compile rejection lives here because both engines load rulesets
 * through this module: a second definition of one function name in one
 * scope (the global list, the service list, or one match block's list) is
 * rejected with "Function f is already defined.", in Firestore and Storage.
 * A nested match block function that shadows an outer one compiles.
 *
 * And a `/` directly followed by a character other than whitespace is read
 * by production as the start of a path, so `(1/0)` and `a/b` are rejected
 * with "Missing 'match' keyword before path." while `1 / 0` compiles and
 * errors at evaluation with "Divide by zero error." (the `slash-divisor`
 * probes, identical for Firestore and Storage).
 */
import type { Expression, FirestoreRules, FunctionDef, MatchBlock } from './FirestoreAST.js';
import { parenthesizedGroups } from './paren-groups.js';
import { MAX_BRACKET_DEPTH, scanBrackets } from './bracket-scan.js';

/** Most functions one call stack may hold; 22 is rejected. */
export const CALL_DEPTH_LIMIT = 21;

/** Most `let` bindings one function may declare; 12 is rejected. */
export const LET_LIMIT = 11;

/**
 * Deepest nesting level an expression node may sit at; a node at level 100
 * is rejected. See {@link nestingViolations} for how levels count.
 */
export const NESTING_LEVEL_LIMIT = 99;

export const LET_LIMIT_MESSAGE = 'Maximum allowed variable count of 10 for a given function has been reached.';
export const NESTING_MESSAGE = 'Expression is too complex to evaluate safely.';
export const SLASH_STARTS_PATH_MESSAGE = "Missing 'match' keyword before path.";

/** Production's call depth message for a stack of {@link CALL_DEPTH_LIMIT} function names. */
export function callDepthMessage(stack: readonly string[]): string {
  return `Maximum allowed call depth of 20 is reached for [${stack.join('->')}] call stack.`;
}

/** Production's message for a second definition of `name` in one scope. */
export function duplicateFunctionMessage(name: string): string {
  return `Function ${name} is already defined.`;
}

export type CompileLimitCode = 'CALL_DEPTH' | 'LET_LIMIT' | 'NESTING_DEPTH' | 'FUNCTION_REDEFINED' | 'SLASH_STARTS_PATH';

/** One compile rejection, carrying production's message verbatim. */
export interface CompileLimitViolation {
  code: CompileLimitCode;
  message: string;
  /** 1-indexed line production reports the rejection at, or of the declaration, allow rule, or function it applies to, when known. */
  line?: number;
  /** 1-indexed column of the return expression a `let` count rejection is reported at. */
  column?: number;
  /** The function the rejection applies to, when it applies to one. */
  functionName?: string;
  /**
   * For FUNCTION_REDEFINED, the scope that defines the name twice:
   * `global scope`, `service <name>`, or the match block's path.
   */
  scope?: string;
}

/**
 * Every compile rejection production reports for the ruleset, in source
 * order. Empty when the ruleset is within every limit.
 */
export function compileLimitViolations(ast: FirestoreRules): CompileLimitViolation[] {
  const graph = buildCallGraph(ast);
  const out: CompileLimitViolation[] = [];
  for (const node of graph) {
    const fn = node.fn;
    if (fn.lets.length > LET_LIMIT) {
      // Production reports this at the return expression.
      const at = fn.returnLoc ?? fn.loc;
      out.push({
        code: 'LET_LIMIT',
        message: LET_LIMIT_MESSAGE,
        ...lineOf(at),
        ...(fn.returnLoc === undefined ? {} : { column: fn.returnLoc.col }),
        functionName: fn.name,
      });
    }
    for (const binding of fn.lets) {
      pushNesting(out, binding.value, binding.loc?.line ?? fn.loc?.line, fn.name);
      pushSlashPaths(out, binding.value, binding.loc?.line ?? fn.loc?.line, fn.name);
    }
    pushNesting(out, fn.body, fn.loc?.line, fn.name);
    pushSlashPaths(out, fn.body, fn.returnLoc?.line ?? fn.loc?.line, fn.name);
  }
  const visitRules = (match: MatchBlock) => {
    for (const rule of match.allows) {
      pushNesting(out, rule.condition, rule.loc?.line);
      pushSlashPaths(out, rule.condition, rule.loc?.line);
    }
    for (const child of match.children) visitRules(child);
  };
  visitRules(ast.service.match);
  out.push(...callDepthViolations(graph));
  out.push(...redefinedFunctions(ast));
  return out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

function redefinedFunctions(ast: FirestoreRules): CompileLimitViolation[] {
  const out: CompileLimitViolation[] = [];
  const inScope = (fns: readonly FunctionDef[], scope: string) => {
    const declared = new Set<string>();
    for (const fn of fns) {
      if (declared.has(fn.name)) {
        out.push({
          code: 'FUNCTION_REDEFINED',
          message: duplicateFunctionMessage(fn.name),
          ...lineOf(fn.loc),
          functionName: fn.name,
          scope,
        });
      }
      declared.add(fn.name);
    }
  };
  const inMatch = (match: MatchBlock) => {
    inScope(match.functions, match.path.raw);
    for (const child of match.children) inMatch(child);
  };
  inScope(ast.functions ?? [], 'global scope');
  inScope(ast.service.functions ?? [], `service ${ast.service.name}`);
  inMatch(ast.service.match);
  return out;
}

/** Every rejection, each prefixed with its line when known: `Line 26: Maximum allowed call depth ...`. */
export function describeCompileLimitViolations(violations: readonly CompileLimitViolation[]): string {
  return violations.map((v) => (v.line === undefined ? v.message : `Line ${v.line}: ${v.message}`)).join(' ');
}

function lineOf(loc: { line: number } | undefined): { line?: number } {
  return loc === undefined ? {} : { line: loc.line };
}

function pushNesting(out: CompileLimitViolation[], expr: Expression, line: number | undefined, functionName?: string): void {
  const count = nestingViolations(expr);
  for (let i = 0; i < count; i++) {
    out.push({
      code: 'NESTING_DEPTH',
      message: NESTING_MESSAGE,
      ...(line === undefined ? {} : { line }),
      ...(functionName === undefined ? {} : { functionName }),
    });
  }
}

// ── A slash that starts a path ──────────────────────────────────────────

/**
 * One rejection per `/` operator that a character other than whitespace
 * directly follows, reported on the line of the statement that holds it.
 *
 * Production reads a slash followed by a path segment as the start of a
 * path, not as division, wherever it sits: `4/2`, `(1/0)`, `a/b`, `4/(2)`
 * and `4/-2` are rejected with "Missing 'match' keyword before path.",
 * while `4 / 2` and `4/ 2` compile and divide (the capture's
 * `slash-divisor` shape). The rejection lists further issues from
 * production's parser recovery, which depend on the token after the path,
 * such as "Unexpected '/0'." and "mismatched input ')' expecting {'{', '/',
 * PATH_SEGMENT}"; only the first issue is reported here.
 */
function pushSlashPaths(out: CompileLimitViolation[], expr: Expression, line: number | undefined, functionName?: string): void {
  if (expr.type === 'binaryOp' && expr.slashStartsPath) {
    out.push({
      code: 'SLASH_STARTS_PATH',
      message: SLASH_STARTS_PATH_MESSAGE,
      ...(line === undefined ? {} : { line }),
      ...(functionName === undefined ? {} : { functionName }),
    });
  }
  for (const child of children(expr)) pushSlashPaths(out, child, line, functionName);
}

// ── Nesting ─────────────────────────────────────────────────────────────

/**
 * How many nodes of one expression production reports as too complex.
 *
 * The root of an allow condition, a function body, or a `let` value sits at
 * level 1. Each parenthesized group and each binary operator (`&&`, `||`,
 * comparisons, arithmetic, `in`, `is`) puts what it encloses one level
 * deeper. A node past {@link NESTING_LEVEL_LIMIT} is reported once and its
 * operands are not visited.
 *
 * The capture fixes this model, including where production reports: with 98
 * parentheses around `request.auth.uid == 'a'` it reports two issues, at the
 * two operands of `==` (level 100); with 99 it reports one, at the `==`; with
 * 100 or more it reports one, at the hundredth parenthesis. A right-nested
 * chain of 50 terms reports the two operands of the innermost comparison, and
 * of 52 or 60 terms the two operands of the fiftieth `&&`. 97 parentheses and
 * 49 terms put the deepest operand at level 99 and compile. A flat chain of
 * 98 comparisons has 97 `&&` nodes on its left spine, and its operands reach
 * level 99; 99 comparisons reach 100.
 *
 * A member access such as `request.auth.uid` adds no level: 97 parentheses
 * around a comparison of it compile, which one more level would reject.
 *
 * A list literal, a map literal and a function call put their elements, the
 * key and value of each entry, and their arguments one level deeper. Under a
 * comparison, 97 nested list literals compile and 98 are rejected at the
 * innermost element; 129 are rejected at the 99th list of each operand, 129
 * nested maps at the key and value of the 98th map of each operand, and 129
 * nested calls of `id(x)` at the 99th call. Index access adds no level: 129
 * nested lists read back with 129 chained `[0]` are reported once, at the
 * 99th list of the indexed operand, not in the index chain. Firestore and
 * Storage report 129 nested lists at the same positions.
 *
 * The capture does not measure `!`, the ternary, method calls, or slice
 * access. They are counted like member access, adding no level. A bare
 * operand is a level of its own: production compiles `true` in 98
 * parentheses (level 99) and rejects it in 99, reporting at the `true`.
 */
export function nestingViolations(expr: Expression): number {
  return countTooComplex(expr, 1);
}

/** Source the parser cannot read, with where the bracket past its bound opens. */
export interface SourceNestingFailure {
  offset: number;
  /** What the source would need instead, worded for a parse error's `expected`. */
  expected: string;
}

/**
 * The source for the parser to match, with the content of every bracket
 * nested past the nesting limit replaced, or where it nests past the
 * parser's bracket depth bound.
 *
 * A parenthesized group, a list literal, a map literal and a function call's
 * arguments each put what they enclose one level deeper, so the content of
 * such a bracket inside 98 others sits past level {@link NESTING_LEVEL_LIMIT}
 * whatever it holds. {@link nestingViolations} reports each item of that
 * content (a group's expression, a list element, a map entry's key and
 * value, a call argument), or a node enclosing it, and never visits below
 * it. The content is replaced by as many literal items (`1`, or `a:1` in a
 * map), padded with spaces that keep every line break, so the parser does
 * not descend into it, the same rejections are reported, and every later
 * line and column is unchanged. Without this the parser exhausts the host
 * stack around 170 to 250 nested brackets.
 *
 * Past that, any source that nests more than {@link MAX_BRACKET_DEPTH}
 * brackets of any kind is a parse failure: the parser does not read it. The
 * brackets left to reach that bound are index access, method call arguments
 * and blocks, whose production limit is not measured, so the bound is this
 * parser's own.
 */
export function boundSourceNesting(source: string): { source: string } | SourceNestingFailure {
  const spans = scanBrackets(source, { comments: true, regexLiterals: false, multilineStrings: false });
  let rewritten: string[] | undefined;
  let emptiedUntil = -1;
  for (const span of spans) {
    if (span.open < emptiedUntil) continue;
    if (span.depth > MAX_BRACKET_DEPTH) {
      return { offset: span.open, expected: `brackets nested at most ${MAX_BRACKET_DEPTH} levels deep` };
    }
    if (span.levels < NESTING_LEVEL_LIMIT || span.items === 0) continue;
    const end = span.close === -1 ? source.length : span.close;
    const content = source.slice(span.open + 1, end);
    const item = span.kind === 'map' ? 'a:1' : '1';
    const replacement = Array.from({ length: span.items }, () => item).join(',');
    // Content too short for its items is malformed; the parser reports it.
    if (content.replace(/[\n\r]/g, '').length < replacement.length) continue;
    let next = 0;
    const filled = content.replace(/[^\n\r]/g, () => (next < replacement.length ? replacement[next++]! : ' '));
    rewritten ??= [];
    rewritten.push(source.slice(Math.max(emptiedUntil, 0), span.open + 1), filled);
    emptiedUntil = end === source.length ? Infinity : end;
  }
  if (rewritten === undefined) return { source };
  if (emptiedUntil !== Infinity) rewritten.push(source.slice(emptiedUntil));
  return { source: rewritten.join('') };
}

function countTooComplex(expr: Expression, level: number): number {
  const at = level + parenthesizedGroups(expr);
  if (at > NESTING_LEVEL_LIMIT) return 1;
  const inner = addsLevel(expr) ? at + 1 : at;
  let count = 0;
  for (const child of children(expr)) count += countTooComplex(child, inner);
  return count;
}

function addsLevel(expr: Expression): boolean {
  switch (expr.type) {
    case 'binaryOp':
    case 'inExpr':
    case 'isExpr':
    case 'listLiteral':
    case 'mapLiteral':
    case 'functionCall':
      return true;
    default:
      return false;
  }
}

function children(expr: Expression): Expression[] {
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return [];
    case 'memberAccess': return [expr.object];
    case 'methodCall': return [expr.object, ...expr.args];
    case 'bracketAccess': return [expr.object, expr.index];
    case 'sliceAccess': return [expr.object, expr.start, expr.end];
    case 'binaryOp': return [expr.left, expr.right];
    case 'unaryOp': return [expr.operand];
    case 'ternary': return [expr.condition, expr.consequent, expr.alternate];
    case 'inExpr': return [expr.element, expr.collection];
    case 'isExpr': return [expr.value];
    case 'listLiteral': return expr.elements;
    case 'mapLiteral': return expr.entries.flatMap((e) => [e.key, e.value]);
    case 'pathLiteral': return expr.segments.filter((s): s is Expression => typeof s !== 'string');
    case 'functionCall': return expr.args;
  }
}

// ── Call depth ──────────────────────────────────────────────────────────

interface CallNode {
  fn: FunctionDef;
  /** The declared functions this function calls, in call order. */
  callees: CallNode[];
}

/**
 * Every declared function with the declared functions it calls. A call
 * resolves by declaration scope: the functions of the declaring match block
 * and each enclosing one, then service, then global scope, the innermost
 * declaration winning. A name no scope declares is a built-in or an
 * undefined function and is not an edge.
 */
function buildCallGraph(ast: FirestoreRules): CallNode[] {
  interface Scope { names: Map<string, CallNode>; parent: Scope | undefined }
  const nodes: CallNode[] = [];
  const pending: { node: CallNode; scope: Scope }[] = [];
  const declare = (fns: readonly FunctionDef[], parent: Scope | undefined): Scope => {
    const scope: Scope = { names: new Map(), parent };
    for (const fn of fns) {
      const node: CallNode = { fn, callees: [] };
      nodes.push(node);
      scope.names.set(fn.name, node);
      pending.push({ node, scope });
    }
    return scope;
  };
  const serviceScope = declare(ast.service.functions ?? [], declare(ast.functions ?? [], undefined));
  const walk = (match: MatchBlock, parent: Scope) => {
    const scope = declare(match.functions, parent);
    for (const child of match.children) walk(child, scope);
  };
  walk(ast.service.match, serviceScope);

  for (const { node, scope } of pending) {
    const seen = new Set<CallNode>();
    const visit = (expr: Expression) => {
      if (expr.type === 'functionCall') {
        for (let s: Scope | undefined = scope; s; s = s.parent) {
          const callee = s.names.get(expr.name);
          if (callee === undefined) continue;
          if (!seen.has(callee)) {
            seen.add(callee);
            node.callees.push(callee);
          }
          break;
        }
      }
      for (const child of children(expr)) visit(child);
    };
    for (const binding of node.fn.lets) visit(binding.value);
    visit(node.fn.body);
  }
  return nodes;
}

/**
 * One rejection per call chain longer than {@link CALL_DEPTH_LIMIT},
 * reported from the chain's first function: one no other function calls.
 * Production checks every chain at compile time, called by a rule or not.
 * The message names the first 21 functions of the deepest chain and the
 * line is the 22nd function's declaration, where production reports it.
 *
 * A recursive call has no bounded depth, so a function that reaches a cycle
 * is reported like a chain over the limit, its stack repeating the cycle.
 * The capture does not include a recursive ruleset, so production's message
 * for one is not measured.
 */
function callDepthViolations(nodes: readonly CallNode[]): CompileLimitViolation[] {
  const depth = new Map<CallNode, number>();
  const onStack = new Set<CallNode>();
  const longest = (node: CallNode): number => {
    const known = depth.get(node);
    if (known !== undefined) return known;
    if (onStack.has(node)) return Infinity;
    onStack.add(node);
    let deepest = 0;
    for (const callee of node.callees) deepest = Math.max(deepest, longest(callee));
    onStack.delete(node);
    depth.set(node, deepest + 1);
    return deepest + 1;
  };

  const called = new Set<CallNode>();
  for (const node of nodes) for (const callee of node.callees) if (callee !== node) called.add(callee);
  const covered = new Set<CallNode>();
  const cover = (node: CallNode) => {
    if (covered.has(node)) return;
    covered.add(node);
    for (const callee of node.callees) cover(callee);
  };
  const starts: CallNode[] = [];
  for (const node of nodes) {
    if (called.has(node)) continue;
    starts.push(node);
    cover(node);
  }
  // A cycle every member of which another function calls has no first
  // function; start from its first declared member.
  for (const node of nodes) {
    if (covered.has(node) || longest(node) !== Infinity) continue;
    starts.push(node);
    cover(node);
  }

  const out: CompileLimitViolation[] = [];
  for (const start of starts) {
    if (longest(start) <= CALL_DEPTH_LIMIT) continue;
    const chain = [start];
    while (chain.length <= CALL_DEPTH_LIMIT) {
      const tail = chain[chain.length - 1]!;
      let next = tail.callees[0]!;
      for (const callee of tail.callees) if (longest(callee) > longest(next)) next = callee;
      chain.push(next);
    }
    const over = chain[CALL_DEPTH_LIMIT]!;
    out.push({
      code: 'CALL_DEPTH',
      message: callDepthMessage(chain.slice(0, CALL_DEPTH_LIMIT).map((n) => n.fn.name)),
      ...lineOf(over.fn.loc),
      functionName: over.fn.name,
    });
  }
  return out;
}
