/**
 * Hallucination lint rules.
 *
 * Catches JavaScript-style code that compiles in Firestore and Storage rules
 * (because CEL is dynamically typed) but fails at runtime with an evaluation
 * error (`permission-denied`).
 */
import type {
  FirestoreRules,
  Expression,
  MatchBlock,
} from '../grammar/FirestoreAST.js';
import { isStorageServiceName, topLevelMatches } from '../grammar/service-blocks.js';
import type { LintWarning } from './linter.js';
import { stripCommentsAndStrings } from './ast-utils.js';
import {
  BOOL_TOKEN_CLAIMS,
  HALLUCINATED_GLOBALS,
  HALLUCINATED_METHODS,
  KNOWN_BUILTIN_METHODS,
  SYNTAX_HINTS,
  WRONG_CONTEXT_PATHS,
} from './hallucination-catalog.js';
import {
  emitPathInterpolationWarnings,
  markBoundLetPathLiteralsInAst,
  markPathLiteralRoles,
} from './path-interpolation.js';

/**
 * The math-namespace functions production actually compiles.
 * Exported so the stdlib-modules drift test can assert the documented
 * catalog never re-grows a name this validator rejects.
 */
export const VALID_MATH_METHODS = new Set(['abs', 'ceil', 'floor', 'round', 'sqrt', 'pow', 'isNaN']);

export const DEBUG_UNAVAILABLE_MESSAGE =
  "`debug()` is not available in production: it compiles, but every call is a 'Function not found' error at runtime. `|| true` absorbs it; on its own it denies.";

/**
 * Pre-parse syntactic check. Strips comments and string literal contents,
 * scans the source for the SYNTAX_HINTS patterns, emits one `INVALID_OPERATOR`
 * per distinct hit.
 */
export function checkSyntaxHints(source: string): LintWarning[] {
  const warnings: LintWarning[] = [];
  const stripped = stripCommentsAndStrings(source);
  for (const hint of SYNTAX_HINTS) {
    if (hint.pattern.test(stripped)) {
      warnings.push({
        rule: 'INVALID_OPERATOR',
        severity: 'error',
        message: hint.message,
      });
    }
  }
  return warnings;
}

// --- AST walking ---

interface Loc {
  matchPath?: string;
  functionName?: string;
  ruleIndex?: number;
}

type ExprVisitor = (
  expr: Expression,
  loc: Loc,
  scope: ReadonlySet<string>,
  localVars: ReadonlySet<string>,
) => void;

function walkAllExpressions(
  match: MatchBlock,
  inheritedScope: ReadonlySet<string>,
  inheritedVars: ReadonlySet<string>,
  visit: ExprVisitor,
) {
  const path = match.path.raw;
  const scope = new Set(inheritedScope);
  for (const fn of match.functions) scope.add(fn.name);
  const matchVars = new Set(inheritedVars);
  for (const seg of match.path.segments) {
    if (seg.type !== 'literal') matchVars.add(seg.name);
  }
  for (const fn of match.functions) {
    const loc: Loc = { matchPath: path, functionName: fn.name };
    const fnVars = new Set([...matchVars, ...fn.parameters]);
    for (const b of fn.lets) {
      walkExpr(b.value, loc, scope, fnVars, visit);
      fnVars.add(b.name);
    }
    walkExpr(fn.body, loc, scope, fnVars, visit);
  }
  for (let i = 0; i < match.allows.length; i++) {
    const allow = match.allows[i];
    if (allow === undefined) continue;
    walkExpr(allow.condition, { matchPath: path, ruleIndex: i }, scope, matchVars, visit);
  }
  for (const child of match.children) walkAllExpressions(child, scope, matchVars, visit);
}

function walkExpr(
  expr: Expression,
  loc: Loc,
  scope: ReadonlySet<string>,
  localVars: ReadonlySet<string>,
  visit: ExprVisitor,
) {
  visit(expr, loc, scope, localVars);
  switch (expr.type) {
    case 'binaryOp':
      walkExpr(expr.left, loc, scope, localVars, visit);
      walkExpr(expr.right, loc, scope, localVars, visit);
      break;
    case 'unaryOp':
      walkExpr(expr.operand, loc, scope, localVars, visit);
      break;
    case 'methodCall':
      walkExpr(expr.object, loc, scope, localVars, visit);
      expr.args.forEach((a) => walkExpr(a, loc, scope, localVars, visit));
      break;
    case 'memberAccess':
      walkExpr(expr.object, loc, scope, localVars, visit);
      break;
    case 'bracketAccess':
      walkExpr(expr.object, loc, scope, localVars, visit);
      walkExpr(expr.index, loc, scope, localVars, visit);
      break;
    case 'sliceAccess':
      walkExpr(expr.object, loc, scope, localVars, visit);
      walkExpr(expr.start, loc, scope, localVars, visit);
      walkExpr(expr.end, loc, scope, localVars, visit);
      break;
    case 'ternary':
      walkExpr(expr.condition, loc, scope, localVars, visit);
      walkExpr(expr.consequent, loc, scope, localVars, visit);
      walkExpr(expr.alternate, loc, scope, localVars, visit);
      break;
    case 'inExpr':
      walkExpr(expr.element, loc, scope, localVars, visit);
      walkExpr(expr.collection, loc, scope, localVars, visit);
      break;
    case 'isExpr':
      walkExpr(expr.value, loc, scope, localVars, visit);
      break;
    case 'listLiteral':
      expr.elements.forEach((e) => walkExpr(e, loc, scope, localVars, visit));
      break;
    case 'mapLiteral':
      expr.entries.forEach((en) => {
        walkExpr(en.key, loc, scope, localVars, visit);
        walkExpr(en.value, loc, scope, localVars, visit);
      });
      break;
    case 'functionCall':
      expr.args.forEach((a) => walkExpr(a, loc, scope, localVars, visit));
      break;
    case 'pathLiteral':
      expr.segments.forEach((s) => {
        if (typeof s !== 'string') walkExpr(s, loc, scope, localVars, visit);
      });
      break;
  }
}

// --- Post-parse hallucination check ---

function isUnresolvedDebugCall(
  expr: Expression,
  scope: ReadonlySet<string>,
  allowDebug?: boolean,
): boolean {
  if (allowDebug) return false;
  return expr.type === 'functionCall' && expr.name === 'debug' && !scope.has('debug');
}

function isHallucinatedMethodCall(expr: Expression): boolean {
  return expr.type === 'methodCall' && Object.hasOwn(HALLUCINATED_METHODS, expr.method);
}

function isUnsupportedMathMethodCall(expr: Expression): boolean {
  if (expr.type !== 'methodCall') return false;
  if (expr.object.type !== 'identifier' || expr.object.name !== 'math') return false;
  return !VALID_MATH_METHODS.has(expr.method);
}

function isBareMapMembershipCall(expr: Expression): boolean {
  if (expr.type !== 'methodCall') return false;
  if (expr.method !== 'hasAll' && expr.method !== 'hasAny' && expr.method !== 'hasOnly') return false;
  const isKnownMap =
    expr.object.type === 'mapLiteral' ||
    (expr.object.type === 'memberAccess' && expr.object.property === 'data');
  return isKnownMap;
}

function isHallucinatedGlobalMethodCall(expr: Expression, localVars: ReadonlySet<string>): boolean {
  if (expr.type !== 'methodCall') return false;
  if (expr.object.type !== 'identifier') return false;
  if (localVars.has(expr.object.name)) return false;
  return Object.hasOwn(HALLUCINATED_GLOBALS, expr.object.name);
}

function isHallucinatedGlobalFunctionCall(expr: Expression, scope: ReadonlySet<string>): boolean {
  if (expr.type !== 'functionCall') return false;
  if (scope.has(expr.name)) return false;
  return Object.hasOwn(HALLUCINATED_GLOBALS, expr.name);
}

function isHallucinatedGlobalIdentifier(expr: Expression, localVars: ReadonlySet<string>): boolean {
  if (expr.type !== 'identifier') return false;
  if (localVars.has(expr.name)) return false;
  return Object.hasOwn(HALLUCINATED_GLOBALS, expr.name);
}

function isWrongContextPath(
  expr: Expression,
  isStorage = false,
): { path: string; suggestion: string } | undefined {
  if (expr.type !== 'memberAccess') return undefined;
  let recv: string | undefined;
  if (expr.object.type === 'identifier') {
    recv = expr.object.name;
  } else if (expr.object.type === 'memberAccess' && expr.object.object.type === 'identifier') {
    recv = `${expr.object.object.name}.${expr.object.property}`;
  }
  if (!recv) return undefined;
  const prop = expr.property;
  const match = WRONG_CONTEXT_PATHS.find(
    (p) => p.receiver === recv && p.property === prop && (!p.storageOnly || isStorage),
  );
  if (!match) return undefined;
  let suggestion = match.suggestion;
  if (isStorage && match.storageSuggestion !== undefined) {
    suggestion = match.storageSuggestion;
  }
  return {
    path: `${recv}.${prop}`,
    suggestion,
  };
}

function boolTokenClaimName(expr: Expression): string | undefined {
  if (expr.type !== 'memberAccess' || !BOOL_TOKEN_CLAIMS.has(expr.property)) return undefined;
  const token = expr.object;
  if (token.type !== 'memberAccess' || token.property !== 'token') return undefined;
  const auth = token.object;
  if (auth.type !== 'memberAccess' || auth.property !== 'auth') return undefined;
  if (auth.object.type === 'identifier' && auth.object.name === 'request') {
    return expr.property;
  }
  return undefined;
}

function boolTokenClaimStringComparison(
  expr: Expression,
): { claim: string; op: string; literal: string } | undefined {
  if (expr.type !== 'binaryOp' || (expr.op !== '==' && expr.op !== '!=')) return undefined;
  for (const [side, other] of [[expr.left, expr.right], [expr.right, expr.left]] as const) {
    const claim = boolTokenClaimName(side);
    if (claim && other.type === 'literal' && typeof other.value === 'string') {
      return { claim, op: expr.op, literal: other.value };
    }
  }
  return undefined;
}

function isLengthPropertyAccessOnMethod(expr: Expression): boolean {
  return expr.type === 'memberAccess' && expr.property === 'length' && expr.object.type === 'methodCall';
}

function isMethodMissingParens(expr: Expression, isStorage = false): boolean {
  if (expr.type !== 'memberAccess' || !KNOWN_BUILTIN_METHODS.has(expr.property)) return false;
  if (isStorage && expr.property === 'size') {
    const isResourceSize =
      expr.object.type === 'identifier' && expr.object.name === 'resource';
    const isRequestResourceSize =
      expr.object.type === 'memberAccess' &&
      expr.object.property === 'resource' &&
      expr.object.object.type === 'identifier' &&
      expr.object.object.name === 'request';
    if (isResourceSize || isRequestResourceSize) return false;
  }
  const isLikelyData =
    (expr.object.type === 'identifier' &&
      (expr.object.name === 'request' || expr.object.name === 'resource')) ||
    expr.object.type === 'memberAccess' ||
    expr.object.type === 'methodCall' ||
    expr.object.type === 'bracketAccess';
  return isLikelyData;
}

export function checkHallucinations(ast: FirestoreRules, options: { allowDebug?: boolean } = {}): LintWarning[] {
  const warnings: LintWarning[] = [];
  const seen = new Set<string>();
  const isStorage = isStorageServiceName(ast.service?.name);
  let rulesLabel = 'Firestore';
  if (isStorage) {
    rulesLabel = 'Storage';
  }

  function emit(rule: string, key: string, loc: Loc, w: LintWarning) {
    const dedup = `${rule}|${key}|${loc.matchPath || ''}|${loc.functionName || ''}|${loc.ruleIndex ?? ''}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    warnings.push(w);
  }

  const globalScope = new Set<string>();
  for (const imp of ast.imports ?? []) {
    const names = imp.functions ?? (imp as { names?: string[] }).names ?? [];
    for (const name of names) globalScope.add(name);
  }
  for (const fn of ast.functions ?? []) globalScope.add(fn.name);
  const outerScope = new Set<string>(globalScope);
  for (const fn of ast.service.functions ?? []) outerScope.add(fn.name);

  const boundPathLiterals = new WeakSet<Expression>();
  const lookupPathLiterals = new WeakSet<Expression>();
  markBoundLetPathLiteralsInAst(ast, boundPathLiterals);
  const visitNode: ExprVisitor = (expr, loc, scope, localVars) => {
    markPathLiteralRoles(expr, scope, localVars, boundPathLiterals, lookupPathLiterals);
    if (isUnresolvedDebugCall(expr, scope, options.allowDebug)) {
      emit('HALLUCINATED_GLOBAL', 'debug', loc, {
        rule: 'HALLUCINATED_GLOBAL',
        severity: 'error',
        message: DEBUG_UNAVAILABLE_MESSAGE,
        location: loc,
        fix: 'Remove the debug() call and evaluate the inner expression directly.',
      });
    }

    if (isHallucinatedMethodCall(expr)) {
      if (expr.type === 'methodCall') {
        const hint = HALLUCINATED_METHODS[expr.method] ?? '';
        emit('HALLUCINATED_METHOD', expr.method, loc, {
          rule: 'HALLUCINATED_METHOD',
          severity: 'error',
          message: `\`.${expr.method}()\` does not exist in ${rulesLabel} rules. ${hint}`,
          location: loc,
          fix: hint,
        });
      }
    }

    if (isUnsupportedMathMethodCall(expr)) {
      if (expr.type === 'methodCall') {
        emit('HALLUCINATED_METHOD', `math.${expr.method}`, loc, {
          rule: 'HALLUCINATED_METHOD',
          severity: 'error',
          message: `\`math.${expr.method}()\` does not exist in production ${rulesLabel} security rules.`,
          location: loc,
          fix: 'Use supported math namespace functions: abs, ceil, floor, round, sqrt, pow, isNaN.',
        });
      }
    }

    if (isBareMapMembershipCall(expr)) {
      if (expr.type === 'methodCall') {
        emit('HALLUCINATED_METHOD', `map.${expr.method}`, loc, {
          rule: 'HALLUCINATED_METHOD',
          severity: 'error',
          message: `\`.${expr.method}()\` cannot be called directly on a map in ${rulesLabel} rules -- call it on \`.keys()\` instead.`,
          location: loc,
          fix: `Insert \`.keys()\`: e.g. \`data.keys().${expr.method}(...)\`.`,
        });
      }
    }

    if (isHallucinatedGlobalMethodCall(expr, localVars)) {
      if (expr.type === 'methodCall' && expr.object.type === 'identifier') {
        const name = expr.object.name;
        const hint = HALLUCINATED_GLOBALS[name] ?? '';
        emit('HALLUCINATED_GLOBAL', `${name}.${expr.method}`, loc, {
          rule: 'HALLUCINATED_GLOBAL',
          severity: 'error',
          message: `\`${name}.${expr.method}()\` does not exist in ${rulesLabel} rules. ${hint}`,
          location: loc,
          fix: hint,
        });
      }
    }

    if (isHallucinatedGlobalFunctionCall(expr, scope)) {
      if (expr.type === 'functionCall') {
        const hint = HALLUCINATED_GLOBALS[expr.name] ?? '';
        emit('HALLUCINATED_GLOBAL', expr.name, loc, {
          rule: 'HALLUCINATED_GLOBAL',
          severity: 'error',
          message: `\`${expr.name}()\` does not exist in ${rulesLabel} rules. ${hint}`,
          location: loc,
          fix: hint,
        });
      }
    }

    if (isHallucinatedGlobalIdentifier(expr, localVars)) {
      if (expr.type === 'identifier') {
        const hint = HALLUCINATED_GLOBALS[expr.name] ?? '';
        emit('HALLUCINATED_GLOBAL', `ref:${expr.name}`, loc, {
          rule: 'HALLUCINATED_GLOBAL',
          severity: 'error',
          message: `\`${expr.name}\` is not a ${rulesLabel} rules identifier. ${hint}`,
          location: loc,
          fix: hint,
        });
      }
    }

    const wrongContextMatch = isWrongContextPath(expr, isStorage);
    if (wrongContextMatch) {
      emit('WRONG_CONTEXT_PATH', wrongContextMatch.path, loc, {
        rule: 'WRONG_CONTEXT_PATH',
        severity: 'error',
        message: `\`${wrongContextMatch.path}\` is not a valid ${rulesLabel} rules path. ${wrongContextMatch.suggestion}`,
        location: loc,
        fix: wrongContextMatch.suggestion,
      });
    }

    const boolClaim = boolTokenClaimStringComparison(expr);
    if (boolClaim) {
      const { claim, op, literal } = boolClaim;
      let outcomeDesc = 'true (rule silently allows)';
      if (op === '==') {
        outcomeDesc = 'false (rule always denies)';
      }
      let targetBool = 'true';
      if (literal === 'false') {
        targetBool = 'false';
      }
      emit('BOOL_TOKEN_CLAIM', `${claim}|${op}|${literal}`, loc, {
        rule: 'BOOL_TOKEN_CLAIM',
        severity: 'error',
        message:
          `\`request.auth.token.${claim}\` is a bool, but it is compared against the string ` +
          `"${literal}", a cross-type comparison that is always ${outcomeDesc}. ` +
          `Compare against the boolean literal instead: \`request.auth.token.${claim} ${op} true\`.`,
        location: loc,
        fix: `Drop the quotes: \`request.auth.token.${claim} ${op} ${targetBool}\`.`,
      });
    }

    if (isLengthPropertyAccessOnMethod(expr)) {
      emit('LENGTH_PROPERTY', '', loc, {
        rule: 'LENGTH_PROPERTY',
        severity: 'error',
        message: `\`.length\` is not a valid property in ${rulesLabel} rules -- use \`.size()\` (a method, with parentheses).`,
        location: loc,
        fix: 'Replace `.length` with `.size()`.',
      });
    }

    emitPathInterpolationWarnings(expr, loc, boundPathLiterals, lookupPathLiterals, (rule, key, w) => {
      emit(rule, key, loc, w);
    });

    if (isMethodMissingParens(expr, isStorage)) {
      if (expr.type === 'memberAccess') {
        emit('METHOD_MISSING_PARENS', expr.property, loc, {
          rule: 'METHOD_MISSING_PARENS',
          severity: 'warning',
          message: `\`.${expr.property}\` looks like a built-in method called without parentheses. Use \`.${expr.property}()\` if you meant to invoke it (otherwise this is a field access).`,
          location: loc,
          fix: `Add parentheses: \`.${expr.property}()\`.`,
        });
      }
    }
  };

  for (const fn of ast.functions ?? []) {
    const loc: Loc = { functionName: fn.name };
    const fnVars = new Set(fn.parameters);
    for (const b of fn.lets) {
      walkExpr(b.value, loc, globalScope, fnVars, visitNode);
      fnVars.add(b.name);
    }
    walkExpr(fn.body, loc, globalScope, fnVars, visitNode);
  }

  for (const fn of ast.service.functions ?? []) {
    const loc: Loc = { functionName: fn.name };
    const fnVars = new Set(fn.parameters);
    for (const b of fn.lets) {
      walkExpr(b.value, loc, outerScope, fnVars, visitNode);
      fnVars.add(b.name);
    }
    walkExpr(fn.body, loc, outerScope, fnVars, visitNode);
  }

  for (const root of topLevelMatches(ast.service)) {
    walkAllExpressions(root, outerScope, new Set(), visitNode);
  }

  return warnings;
}
