/**
 * Production's compile-time structural limits for Firestore and Storage
 * rulesets. Production rejects a ruleset that breaks one of them before any
 * request is evaluated, so the Firestore simulator, the Storage evaluator
 * and the linter read them from here and report production's own messages.
 */
import type { Expression, FirestoreRules, FunctionDef, MatchBlock } from './FirestoreAST.js';
import {
  CALL_DEPTH_LIMIT,
  buildCallGraph,
  callDepthViolations,
  expressionChildren,
} from './call-depth-limits.js';
import { expressionPosition } from './expression-positions.js';
import { moduleSyntaxViolations } from './module-syntax-violations.js';
import { parenthesizedGroups } from './paren-groups.js';
import { allServiceBlocks, isStorageServiceName, topLevelMatches } from './service-blocks.js';
import {
  NESTING_LEVEL_LIMIT,
  boundSourceNesting,
  type SourceNestingFailure,
} from './source-nesting-bound.js';
import { re2PatternProblem } from '../simulator/re2-pattern-check.js';
import { invalidNumberLiteralMessage, outOfRangeLiteral } from '../simulator/rules-int.js';

export {
  CALL_DEPTH_LIMIT,
  NESTING_LEVEL_LIMIT,
  boundSourceNesting,
  type SourceNestingFailure,
};

/** Most `let` bindings one function may declare; 12 is rejected. */
export const LET_LIMIT = 11;

const LET_LIMIT_MESSAGE =
  'Maximum allowed variable count of 10 for a given function has been reached.';
export const NESTING_MESSAGE = 'Expression is too complex to evaluate safely.';
export const SLASH_STARTS_PATH_MESSAGE = "Missing 'match' keyword before path.";
const GLOB_MATCH_MESSAGE =
  'Invalid glob match expression. Only one glob match is permitted in a match declaration path.';
const V1_MID_PATH_GLOB_MESSAGE =
  'Invalid glob match expression. Glob matches are only permitted at the end of a path.';
const DECREMENT_MESSAGE =
  'Increment (++) and decrement (--) operators are not supported.';
const MINUS_AFTER_MINUS_MESSAGE = "Unexpected '-'.";

/** Production's message for a second definition of `name` in one scope. */
function duplicateFunctionMessage(name: string): string {
  return `Function ${name} is already defined.`;
}

/** Production's message for a duplicate parameter `name` on one function. */
function duplicateParameterMessage(name: string): string {
  return `Parameter ${name} is already defined.`;
}

/** Production's message for a variable or path capture `name` bound twice in one scope. */
function duplicateVariableMessage(name: string): string {
  return `Variable ${name} is already bound in the current scope.`;
}

type CompileLimitCode =
  | 'CALL_DEPTH'
  | 'LET_LIMIT'
  | 'NESTING_DEPTH'
  | 'FUNCTION_REDEFINED'
  | 'VARIABLE_REDEFINED'
  | 'SLASH_STARTS_PATH'
  | 'GLOB_MATCH_COUNT'
  | 'UNSUPPORTED_RULES_VERSION'
  | 'UNRESOLVED_MODULES'
  | 'INVALID_REGEX_PATTERN'
  | 'INVALID_NUMBER_LITERAL'
  | 'DOUBLE_MINUS'
  | 'SOURCE_SIZE';

/** One compile rejection, carrying production's message verbatim. */
export interface CompileLimitViolation {
  code: CompileLimitCode;
  message: string;
  /** 1-indexed line production reports the rejection at, when known. */
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

export interface CompileLimitOptions {
  /** Skip `UNRESOLVED_MODULES` when low-level callers (such as `parseStorageRules`) stub imports explicitly. */
  allowUnresolvedImports?: boolean;
}

/**
 * Every compile rejection production reports for the ruleset, in source
 * order. Empty when the ruleset is within every limit.
 */
export function compileLimitViolations(
  ast: FirestoreRules,
  options?: CompileLimitOptions,
): CompileLimitViolation[] {
  const services = allServiceBlocks(ast);
  const graph = buildCallGraph(ast, services);
  const out: CompileLimitViolation[] = [];
  if (ast.version !== '1' && ast.version !== '2' && ast.version !== '2+modules') {
    out.push({
      code: 'UNSUPPORTED_RULES_VERSION',
      message: `Unsupported rules version ${ast.version}.`,
      line: ast.loc?.line ?? 1,
    });
  } else {
    out.push(...moduleSyntaxViolations(ast, graph.map((node) => node.fn), options));
  }
  for (const node of graph) {
    const fn = node.fn;
    const isFirestore = node.isFirestore;
    if (fn.lets.length > LET_LIMIT) {
      const at = fn.returnLoc ?? fn.loc;
      const violation: CompileLimitViolation = {
        code: 'LET_LIMIT',
        message: LET_LIMIT_MESSAGE,
        functionName: fn.name,
      };
      if (at !== undefined) violation.line = at.line;
      if (fn.returnLoc !== undefined) violation.column = fn.returnLoc.col;
      out.push(violation);
    }
    const seenParams = new Set<string>();
    for (const param of fn.parameters) {
      if (seenParams.has(param)) {
        pushViolation(out, 'VARIABLE_REDEFINED', duplicateParameterMessage(param), fn.loc?.line, fn.name);
      } else {
        seenParams.add(param);
      }
    }
    const boundLocals = new Set<string>(seenParams);
    for (const binding of fn.lets) {
      if (boundLocals.has(binding.name)) {
        pushViolation(
          out,
          'VARIABLE_REDEFINED',
          duplicateVariableMessage(binding.name),
          binding.loc?.line ?? fn.loc?.line,
          fn.name,
        );
      } else {
        boundLocals.add(binding.name);
      }
      pushNesting(out, binding.value, binding.loc?.line ?? fn.loc?.line, fn.name);
      pushExpressionViolations(out, binding.value, binding.loc?.line ?? fn.loc?.line, isFirestore, fn.name);
    }
    pushNesting(out, fn.body, fn.loc?.line, fn.name);
    pushExpressionViolations(out, fn.body, fn.returnLoc?.line ?? fn.loc?.line, isFirestore, fn.name);
  }
  const visitRules = (match: MatchBlock, isFirestore: boolean) => {
    for (const rule of match.allows) {
      pushNesting(out, rule.condition, rule.loc?.line);
      pushExpressionViolations(out, rule.condition, rule.loc?.line, isFirestore);
    }
    for (const child of match.children) visitRules(child, isFirestore);
  };
  for (const service of services) {
    const svcIsFirestore = !isStorageServiceName(service.name);
    for (const root of topLevelMatches(service)) {
      visitRules(root, svcIsFirestore);
    }
  }
  out.push(...callDepthViolations(graph));
  out.push(...redefinedFunctions(ast, services));
  const isVersion1 = ast.version === '1';
  for (const service of services) {
    for (const root of topLevelMatches(service)) {
      out.push(...redefinedMatchCaptures(root));
      out.push(...secondGlobMatches(root, 0, isVersion1));
    }
  }
  return out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

function redefinedMatchCaptures(match: MatchBlock): CompileLimitViolation[] {
  const out: CompileLimitViolation[] = [];
  const seen = new Set<string>();
  for (const segment of match.path.segments) {
    if (segment.type === 'literal') continue;
    if (seen.has(segment.name)) {
      const violation: CompileLimitViolation = {
        code: 'VARIABLE_REDEFINED',
        message: duplicateVariableMessage(segment.name),
        scope: match.path.raw,
      };
      if (match.loc !== undefined) violation.line = match.loc.line;
      out.push(violation);
    } else {
      seen.add(segment.name);
    }
  }
  for (const child of match.children) {
    out.push(...redefinedMatchCaptures(child));
  }
  return out;
}

function hasMidPathGlob(match: MatchBlock): boolean {
  const segments = match.path.segments;
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i]!.type === 'recursive') return true;
  }
  return false;
}

function secondGlobMatches(
  match: MatchBlock,
  enclosing: number,
  isVersion1 = false,
): CompileLimitViolation[] {
  const own = match.path.segments.filter((segment) => segment.type === 'recursive').length;
  const out: CompileLimitViolation[] = [];
  if (own > 0 && enclosing + own > 1) {
    const violation: CompileLimitViolation = {
      code: 'GLOB_MATCH_COUNT',
      message: GLOB_MATCH_MESSAGE,
    };
    if (match.loc !== undefined) violation.line = match.loc.line;
    out.push(violation);
  } else if (isVersion1 && hasMidPathGlob(match)) {
    const violation: CompileLimitViolation = {
      code: 'GLOB_MATCH_COUNT',
      message: V1_MID_PATH_GLOB_MESSAGE,
    };
    if (match.loc !== undefined) violation.line = match.loc.line;
    out.push(violation);
  }
  for (const child of match.children) {
    out.push(...secondGlobMatches(child, enclosing + own, isVersion1));
  }
  return out;
}

function redefinedFunctions(
  ast: FirestoreRules,
  services = allServiceBlocks(ast),
): CompileLimitViolation[] {
  const out: CompileLimitViolation[] = [];
  const inScope = (fns: readonly FunctionDef[], scope: string) => {
    const declared = new Set<string>();
    for (const fn of fns) {
      if (declared.has(fn.name)) {
        const violation: CompileLimitViolation = {
          code: 'FUNCTION_REDEFINED',
          message: duplicateFunctionMessage(fn.name),
          functionName: fn.name,
          scope,
        };
        if (fn.loc !== undefined) violation.line = fn.loc.line;
        out.push(violation);
      }
      declared.add(fn.name);
    }
  };
  const inMatch = (match: MatchBlock) => {
    inScope(match.functions, match.path.raw);
    for (const child of match.children) inMatch(child);
  };
  inScope(ast.functions ?? [], 'global scope');
  for (const service of services) {
    inScope(service.functions ?? [], `service ${service.name}`);
    for (const root of topLevelMatches(service)) {
      inMatch(root);
    }
  }
  return out;
}

/** Every rejection, each prefixed with its line when known: `Line 26: Maximum allowed call depth ...`. */
export function describeCompileLimitViolations(violations: readonly CompileLimitViolation[]): string {
  return violations
    .map((v) => (v.line === undefined ? v.message : `Line ${v.line}: ${v.message}`))
    .join(' ');
}

function pushViolation(
  out: CompileLimitViolation[],
  code: CompileLimitCode,
  message: string,
  line: number | undefined,
  functionName?: string,
): void {
  const violation: CompileLimitViolation = { code, message };
  if (line !== undefined) violation.line = line;
  if (functionName !== undefined) violation.functionName = functionName;
  out.push(violation);
}

function pushNesting(
  out: CompileLimitViolation[],
  expr: Expression,
  line: number | undefined,
  functionName?: string,
): void {
  const count = nestingViolations(expr);
  for (let i = 0; i < count; i++) {
    pushViolation(out, 'NESTING_DEPTH', NESTING_MESSAGE, line, functionName);
  }
}

function pushExpressionViolations(
  out: CompileLimitViolation[],
  expr: Expression,
  line: number | undefined,
  isFirestore: boolean,
  functionName?: string,
): void {
  if (expr.type === 'binaryOp' && expr.slashStartsPath) {
    pushViolation(out, 'SLASH_STARTS_PATH', SLASH_STARTS_PATH_MESSAGE, line, functionName);
  }
  const doubleMinus = isFirestore ? doubleMinusMessage(expr) : undefined;
  if (doubleMinus !== undefined) {
    pushViolation(out, 'DOUBLE_MINUS', doubleMinus, line, functionName);
  }
  const literal = invalidNumberLiteral(expr, isFirestore);
  if (literal !== undefined) {
    const baseMessage = invalidNumberLiteralMessage(literal);
    const message = isFirestore ? `${baseMessage}.` : baseMessage;
    pushViolation(out, 'INVALID_NUMBER_LITERAL', message, line, functionName);
  }
  if (
    expr.type === 'methodCall' &&
    (expr.method === 'matches' || expr.method === 'split') &&
    expr.args.length === 1
  ) {
    const arg = expr.args[0];
    let problem: string | null = null;
    if (arg?.type === 'literal' && typeof arg.value === 'string') {
      problem = re2PatternProblem(arg.value);
    }
    if (problem !== null) {
      pushViolation(out, 'INVALID_REGEX_PATTERN', problem, line, functionName);
    }
  }
  if (isNegatedLiteral(expr, isFirestore)) return;
  for (const child of expressionChildren(expr)) {
    pushExpressionViolations(out, child, line, isFirestore, functionName);
  }
}

type LiteralExpression = Extract<Expression, { type: 'literal' }>;
type UnaryExpression = Extract<Expression, { type: 'unaryOp' }>;

export function isNegatedLiteral(
  expr: Expression,
  isFirestore: boolean,
): expr is UnaryExpression & { operand: LiteralExpression } {
  if (expr.type !== 'unaryOp' || expr.op !== '-' || expr.operand.type !== 'literal') return false;
  const operandParenthesized = parenthesizedGroups(expr.operand) > 0;
  return !(isFirestore && operandParenthesized);
}

function isUnaryMinus(expr: Expression): expr is UnaryExpression {
  return expr.type === 'unaryOp' && expr.op === '-';
}

function doubleMinusMessage(expr: Expression): string | undefined {
  if (!isUnaryMinus(expr) || !isUnaryMinus(expr.operand)) return undefined;
  if (parenthesizedGroups(expr.operand) > 0) return undefined;
  const outer = expressionPosition(expr);
  const inner = expressionPosition(expr.operand);
  const sameLine = outer !== undefined && inner !== undefined && outer.line === inner.line;
  const adjacent = sameLine && inner.column === outer.column + 1;
  return adjacent ? DECREMENT_MESSAGE : MINUS_AFTER_MINUS_MESSAGE;
}

function invalidNumberLiteral(expr: Expression, isFirestore: boolean): string | undefined {
  if (isNegatedLiteral(expr, isFirestore)) {
    return outOfRangeLiteral(expr.operand.value, expr.operand.raw, true);
  }
  if (expr.type === 'literal') return outOfRangeLiteral(expr.value, expr.raw, false);
  return undefined;
}

export function nestingViolations(expr: Expression): number {
  return countTooComplex(expr, 1);
}

function countTooComplex(expr: Expression, level: number): number {
  const at = level + parenthesizedGroups(expr);
  if (at > NESTING_LEVEL_LIMIT) return 1;
  const inner = addsLevel(expr) ? at + 1 : at;
  let count = 0;
  for (const child of expressionChildren(expr)) count += countTooComplex(child, inner);
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
