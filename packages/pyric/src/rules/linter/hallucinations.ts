/**
 * Hallucination lint rules.
 *
 * Catches JavaScript-style code that compiles in Firestore rules
 * (because CEL is dynamically typed) but fails at runtime with an
 * opaque `permission-denied` error.
 *
 * These rules are mechanical AST checks against a known-bad set of
 * method names, globals, and context paths. The CEL spec doesn't
 * change often and Firestore's runtime stdlib is small, so the
 * known-bad lists are stable.
 *
 * All rules in this module emit `error` severity by default — a true
 * positive is always a true positive (the named method or global
 * literally does not exist), so blocking deploy is correct behavior.
 * The exceptions are LENGTH_PROPERTY and METHOD_MISSING_PARENS, which
 * could theoretically collide with user-chosen field names; those emit
 * `warning` severity.
 */
import type {
  FirestoreRules,
  Expression,
  MatchBlock,
} from '../grammar/FirestoreAST.js';
import type { LintWarning } from './linter.js';

// ─── Known-bad sets ───────────────────────────────────────────────────

/**
 * JavaScript array/string methods that don't exist on any CEL type
 * used in Firestore rules (List, Map, String, Set, Timestamp, Path).
 *
 * The map value is a hint shown to the user — what to use instead, or
 * why no equivalent exists.
 */
const HALLUCINATED_METHODS: Record<string, string> = {
  // Array methods
  where:       'No equivalent in rules — restructure logic instead of filtering a list',
  filter:      'No equivalent in rules — restructure logic instead of filtering a list',
  find:        'No equivalent in rules',
  findIndex:   'No equivalent in rules',
  map:         'No equivalent in rules — lists are not transformable',
  reduce:      'No equivalent in rules',
  forEach:     'No equivalent in rules',
  every:       'Use `list.hasAll([...])` for "all elements present"',
  some:        'Use `list.hasAny([...])` for "any element present"',
  includes:    'Use `x in list` instead of `list.includes(x)`',
  indexOf:     'No equivalent in rules',
  push:        'Lists are immutable in rules',
  pop:         'Lists are immutable in rules',
  shift:       'Lists are immutable in rules',
  unshift:     'Lists are immutable in rules',
  splice:      'Lists are immutable in rules',
  slice:       'No equivalent in rules',
  sort:        'Lists are immutable in rules',
  reverse:     'Lists are immutable in rules',
  flat:        'No equivalent in rules',
  flatMap:     'No equivalent in rules',
  // String methods
  toLowerCase: 'Use `.lower()` instead of `.toLowerCase()`',
  toUpperCase: 'Use `.upper()` instead of `.toUpperCase()`',
  charAt:      'No equivalent in rules — use `.split("")` and index',
  charCodeAt:  'No equivalent in rules',
  substring:   'No `.substring()` — use `.split()` and reassembly',
  substr:      'No `.substr()` — use `.split()` and reassembly',
  padStart:    'No equivalent in rules',
  padEnd:      'No equivalent in rules',
  trimStart:   'Use `.trim()` (trims both ends)',
  trimEnd:     'Use `.trim()` (trims both ends)',
  // Conversion
  toString:    'Use the `string(x)` cast instead of `.toString()`',
};

/**
 * JavaScript globals or constructors that don't exist as identifiers in
 * Firestore rules. CEL has no module system and a tiny global namespace
 * (just `request`, `resource`, custom functions, and a handful of
 * built-in casts: `string`, `int`, `float`, `timestamp`).
 */
const HALLUCINATED_GLOBALS: Record<string, string> = {
  Object:     'No `Object` in rules — use `data.keys()` / `data.values()` directly',
  Array:      'No `Array` in rules — test list type with `x is list`',
  JSON:       'No `JSON` in rules — rules cannot parse or serialize JSON',
  Math:       'No `Math` in rules — inline arithmetic or ternaries',
  Date:       'No `Date` in rules — use `request.time` (a Timestamp)',
  String:     'Use lowercase `string(x)` for casting',
  Number:     'Use lowercase `int(x)` or `float(x)` for casting',
  Boolean:    'Use direct comparison or validation instead of boolean casting',
  bool:       'No `bool()` cast in rules — boolean casting is not supported in production Firestore rules.',
  parseInt:   'Use `int(x)` instead',
  parseFloat: 'Use `float(x)` instead',
  isNaN:      'No equivalent in rules',
  isFinite:   'No equivalent in rules',
  Promise:    'Rules are synchronous — no Promise support',
  undefined:  '`undefined` does not exist in rules — use `null`',
};

/**
 * The math-namespace functions production Firestore actually compiles.
 * Notably ABSENT: `isInfinite`. Reference docs list it, but production
 * rejects it at compile (`Function not found error: Name: [math.isInfinite]`).
 * Exported so the stdlib-modules drift test can assert the documented
 * catalog never re-grows a name this validator rejects.
 */
export const VALID_MATH_METHODS = new Set(['abs', 'ceil', 'floor', 'round', 'sqrt', 'pow', 'isNaN']);


/**
 * Wrong properties accessed on the well-known top-level rule objects.
 * Detection is unambiguous because `request` and `resource` are reserved
 * identifiers in the rules language — there's no way the user has
 * shadowed them.
 */
interface WrongPath { receiver: string; property: string; suggestion: string }
const WRONG_CONTEXT_PATHS: WrongPath[] = [
  { receiver: 'request',  property: 'data',
    suggestion: 'Use `request.resource.data` (the incoming write payload)' },
  { receiver: 'request',  property: 'uid',
    suggestion: 'Use `request.auth.uid`' },
  { receiver: 'request',  property: 'token',
    suggestion: 'Use `request.auth.token`' },
  { receiver: 'request',  property: 'user',
    suggestion: 'Use `request.auth` (or `request.auth.uid` for the user id)' },
  { receiver: 'resource', property: 'path',
    suggestion: '`resource.path` is not available — bind path captures in the match pattern' },
  { receiver: 'resource', property: 'exists',
    suggestion: 'Use `resource != null` (or `exists()` for cross-document checks)' },
  { receiver: 'resource', property: 'id',
    suggestion: '`resource.id` is not available — capture the document id with `/{docId}` in the match path' },
];

/**
 * Auth-token claims that are typed BOOL in production. Comparing one
 * against a STRING literal compiles fine (CEL is dynamically typed) but
 * the comparison is cross-type, so `== "true"` is always false and
 * `!= "true"` is always true, and the latter silently opens the rule.
 * WRONG_CONTEXT_PATHS can't express this: it matches `receiver.property`
 * at depth 2, while token claims live at `request.auth.token.<claim>`
 * and the bug is in the *comparison*, not the path itself.
 *
 * Only claims verifiably typed bool belong here. `email_verified` is the
 * documented one (`request.auth.token.email_verified: bool`).
 * `firebase.sign_in_provider` is a string, so it is deliberately NOT listed.
 */
const BOOL_TOKEN_CLAIMS = new Set(['email_verified']);

/**
 * Built-in CEL methods that, when accessed without parentheses, are
 * almost certainly a missing-call mistake. Restricted to a small
 * high-confidence set; some method names (e.g. `keys`, `values`) could
 * collide with user field names, so these emit `warning` severity.
 */
const KNOWN_BUILTIN_METHODS = new Set([
  'size', 'keys', 'values', 'lower', 'upper', 'trim',
  'hasAll', 'hasAny', 'hasOnly', 'toSet', 'toUtf8',
]);

// ─── Pre-parse syntactic hints ────────────────────────────────────────

/**
 * Operators and syntax forms that don't exist in CEL but commonly appear
 * in agent-written rules. Detected via regex on the source so they fire
 * even when the file fails to parse — most of these are syntax errors,
 * but the underlying parse error message ("expected )") buries the
 * actual cause.
 */
const SYNTAX_HINTS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /===/,
    message: 'Strict equality `===` is not supported in Firestore rules — use `==`.' },
  { pattern: /!==/,
    message: 'Strict inequality `!==` is not supported in Firestore rules — use `!=`.' },
  { pattern: /\?\./,
    message: 'Optional chaining `?.` is not supported — use `\'field\' in obj && obj.field`.' },
  { pattern: /\?\?/,
    message: 'Nullish coalescing `??` is not supported — use a ternary `cond ? a : b`.' },
  { pattern: /=>/,
    message: 'Arrow functions `=>` are not supported — define functions with `function name() { return ...; }`.' },
  { pattern: /`[^`]*`/,
    message: 'Backtick strings are not supported — use single or double quoted strings with `+` for concatenation.' },
];

/**
 * Pre-parse syntactic check. Strips comments, scans the source for the
 * SYNTAX_HINTS patterns, emits one `INVALID_OPERATOR` per distinct hit.
 */
export function checkSyntaxHints(source: string): LintWarning[] {
  const warnings: LintWarning[] = [];
  const stripped = source
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
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

// ─── AST walking ──────────────────────────────────────────────────────

interface Loc {
  matchPath?: string;
  functionName?: string;
  ruleIndex?: number;
}

/**
 * Visit every expression in the match tree, carrying the set of
 * user-defined function names visible where the expression sits. Scope
 * accumulates outward-in: a block sees its own declarations plus every
 * enclosing scope's, which is the resolution order the simulator
 * implements in `simulator/match-resolution.ts`.
 */
function walkAllExpressions(
  match: MatchBlock,
  inheritedScope: ReadonlySet<string>,
  visit: (expr: Expression, loc: Loc, scope: ReadonlySet<string>) => void,
) {
  const path = match.path.raw;
  const scope = new Set(inheritedScope);
  for (const fn of match.functions) scope.add(fn.name);
  for (const fn of match.functions) {
    const loc: Loc = { matchPath: path, functionName: fn.name };
    walkExpr(fn.body, loc, scope, visit);
    for (const b of fn.lets) walkExpr(b.value, loc, scope, visit);
  }
  for (let i = 0; i < match.allows.length; i++) {
    walkExpr(match.allows[i].condition, { matchPath: path, ruleIndex: i }, scope, visit);
  }
  for (const child of match.children) walkAllExpressions(child, scope, visit);
}

function walkExpr(
  expr: Expression,
  loc: Loc,
  scope: ReadonlySet<string>,
  visit: (expr: Expression, loc: Loc, scope: ReadonlySet<string>) => void,
) {
  visit(expr, loc, scope);
  switch (expr.type) {
    case 'binaryOp': walkExpr(expr.left, loc, scope, visit); walkExpr(expr.right, loc, scope, visit); break;
    case 'unaryOp': walkExpr(expr.operand, loc, scope, visit); break;
    case 'methodCall': walkExpr(expr.object, loc, scope, visit); expr.args.forEach(a => walkExpr(a, loc, scope, visit)); break;
    case 'memberAccess': walkExpr(expr.object, loc, scope, visit); break;
    case 'bracketAccess': walkExpr(expr.object, loc, scope, visit); walkExpr(expr.index, loc, scope, visit); break;
    case 'ternary': walkExpr(expr.condition, loc, scope, visit); walkExpr(expr.consequent, loc, scope, visit); walkExpr(expr.alternate, loc, scope, visit); break;
    case 'inExpr': walkExpr(expr.element, loc, scope, visit); walkExpr(expr.collection, loc, scope, visit); break;
    case 'isExpr': walkExpr(expr.value, loc, scope, visit); break;
    case 'listLiteral': expr.elements.forEach(e => walkExpr(e, loc, scope, visit)); break;
    case 'mapLiteral': expr.entries.forEach(en => { walkExpr(en.key, loc, scope, visit); walkExpr(en.value, loc, scope, visit); }); break;
    case 'functionCall': expr.args.forEach(a => walkExpr(a, loc, scope, visit)); break;
  }
}

// ─── Post-parse hallucination check ───────────────────────────────────

/**
 * Walks every expression in the rules and flags JS-style code that
 * Firestore parses but cannot evaluate. Returns one warning per
 * distinct (rule, key, location) tuple — duplicate identical patterns
 * within the same rule are de-duplicated.
 */
/**
 * A `debug(...)` call that resolves to NOTHING. Production has no built-in
 * `debug`, but a ruleset is free to declare `function debug(v) { ... }`, and
 * that call resolves and evaluates like any other user function, so only an
 * unresolved call is a finding.
 */
function isUnresolvedDebugCall(
  expr: Expression,
  scope: ReadonlySet<string>,
  allowDebug?: boolean,
): boolean {
  if (allowDebug) return false;
  return expr.type === 'functionCall' && expr.name === 'debug' && !scope.has('debug');
}

function isHallucinatedMethodCall(expr: Expression): boolean {
  return expr.type === 'methodCall' && Boolean(HALLUCINATED_METHODS[expr.method]);
}

function isUnsupportedMathMethodCall(expr: Expression): boolean {
  if (expr.type !== 'methodCall') return false;
  if (expr.object.type !== 'identifier' || expr.object.name !== 'math') return false;
  return !VALID_MATH_METHODS.has(expr.method);
}

function isBareMapMembershipCall(expr: Expression): boolean {
  if (expr.type !== 'methodCall') return false;
  if (expr.method !== 'hasAll' && expr.method !== 'hasAny' && expr.method !== 'hasOnly') return false;
  const isKnownMap = expr.object.type === 'mapLiteral' ||
    (expr.object.type === 'memberAccess' && expr.object.property === 'data');
  return isKnownMap;
}

function isHallucinatedGlobalMethodCall(expr: Expression): boolean {
  if (expr.type !== 'methodCall') return false;
  if (expr.object.type !== 'identifier') return false;
  return Boolean(HALLUCINATED_GLOBALS[expr.object.name]);
}

function isHallucinatedGlobalFunctionCall(expr: Expression): boolean {
  return expr.type === 'functionCall' && Boolean(HALLUCINATED_GLOBALS[expr.name]);
}

function isHallucinatedGlobalIdentifier(expr: Expression): boolean {
  return expr.type === 'identifier' && Boolean(HALLUCINATED_GLOBALS[expr.name]);
}

function isWrongContextPath(expr: Expression): { suggestion: string } | undefined {
  if (expr.type !== 'memberAccess' || expr.object.type !== 'identifier') return undefined;
  const recv = expr.object.name;
  const prop = expr.property;
  return WRONG_CONTEXT_PATHS.find(p => p.receiver === recv && p.property === prop);
}

/** Is `expr` a member access spelling exactly `request.auth.token.<claim>`
 *  for a claim in BOOL_TOKEN_CLAIMS? */
function boolTokenClaimName(expr: Expression): string | undefined {
  if (expr.type !== 'memberAccess' || !BOOL_TOKEN_CLAIMS.has(expr.property)) return undefined;
  const token = expr.object;
  if (token.type !== 'memberAccess' || token.property !== 'token') return undefined;
  const auth = token.object;
  if (auth.type !== 'memberAccess' || auth.property !== 'auth') return undefined;
  return auth.object.type === 'identifier' && auth.object.name === 'request'
    ? expr.property
    : undefined;
}

/**
 * `request.auth.token.email_verified == "true"` (or `!=`, either operand
 * order). The claim is a bool; a string literal can never equal it, so the
 * comparison is a constant: `==` always denies, `!=` always allows.
 */
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

function isMethodMissingParens(expr: Expression): boolean {
  if (expr.type !== 'memberAccess' || !KNOWN_BUILTIN_METHODS.has(expr.property)) return false;
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

  function emit(rule: string, key: string, loc: Loc, w: LintWarning) {
    const dedup = `${rule}|${key}|${loc.matchPath || ''}|${loc.functionName || ''}|${loc.ruleIndex ?? ''}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    warnings.push(w);
  }

  // Functions declared above `service` and directly inside it are visible
  // everywhere below, so they seed the scope the walk carries down.
  const outerScope = new Set<string>();
  for (const fn of ast.functions ?? []) outerScope.add(fn.name);
  for (const fn of ast.service.functions ?? []) outerScope.add(fn.name);

  walkAllExpressions(ast.service.match, outerScope, (expr, loc, scope) => {
    if (isUnresolvedDebugCall(expr, scope, options.allowDebug)) {
      emit('HALLUCINATED_GLOBAL', 'debug', loc, {
        rule: 'HALLUCINATED_GLOBAL',
        severity: 'error',
        message:
          '`debug()` is not a Firestore rules function and no function named `debug` is declared in scope. '
          + 'Production rejects the whole ruleset at compile time with '
          + '`Function not found error: Name: [debug]`, so nothing in the file deploys.',
        location: loc,
        fix: 'Remove the debug() call and evaluate the inner expression directly.',
      });
    }

    if (isHallucinatedMethodCall(expr)) {
      if (expr.type === 'methodCall') {
        emit('HALLUCINATED_METHOD', expr.method, loc, {
          rule: 'HALLUCINATED_METHOD',
          severity: 'error',
          message: `\`.${expr.method}()\` does not exist in Firestore rules. ${HALLUCINATED_METHODS[expr.method]}`,
          location: loc,
          fix: HALLUCINATED_METHODS[expr.method],
        });
      }
    }

    if (isUnsupportedMathMethodCall(expr)) {
      if (expr.type === 'methodCall') {
        emit('HALLUCINATED_METHOD', `math.${expr.method}`, loc, {
          rule: 'HALLUCINATED_METHOD',
          severity: 'error',
          message: `\`math.${expr.method}()\` does not exist in production Firestore security rules.`,
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
          message: `\`.${expr.method}()\` cannot be called directly on a map in Firestore rules — call it on \`.keys()\` instead.`,
          location: loc,
          fix: `Insert \`.keys()\`: e.g. \`data.keys().${expr.method}(...)\`.`,
        });
      }
    }

    if (isHallucinatedGlobalMethodCall(expr)) {
      if (expr.type === 'methodCall' && expr.object.type === 'identifier') {
        const name = expr.object.name;
        emit('HALLUCINATED_GLOBAL', `${name}.${expr.method}`, loc, {
          rule: 'HALLUCINATED_GLOBAL',
          severity: 'error',
          message: `\`${name}.${expr.method}()\` does not exist in Firestore rules. ${HALLUCINATED_GLOBALS[name]}`,
          location: loc,
          fix: HALLUCINATED_GLOBALS[name],
        });
      }
    }

    if (isHallucinatedGlobalFunctionCall(expr)) {
      if (expr.type === 'functionCall') {
        emit('HALLUCINATED_GLOBAL', expr.name, loc, {
          rule: 'HALLUCINATED_GLOBAL',
          severity: 'error',
          message: `\`${expr.name}()\` does not exist in Firestore rules. ${HALLUCINATED_GLOBALS[expr.name]}`,
          location: loc,
          fix: HALLUCINATED_GLOBALS[expr.name],
        });
      }
    }

    if (isHallucinatedGlobalIdentifier(expr)) {
      if (expr.type === 'identifier') {
        emit('HALLUCINATED_GLOBAL', `ref:${expr.name}`, loc, {
          rule: 'HALLUCINATED_GLOBAL',
          severity: 'error',
          message: `\`${expr.name}\` is not a Firestore rules identifier. ${HALLUCINATED_GLOBALS[expr.name]}`,
          location: loc,
          fix: HALLUCINATED_GLOBALS[expr.name],
        });
      }
    }

    const wrongContextMatch = isWrongContextPath(expr);
    if (wrongContextMatch) {
      if (expr.type === 'memberAccess' && expr.object.type === 'identifier') {
        const recv = expr.object.name;
        const prop = expr.property;
        emit('WRONG_CONTEXT_PATH', `${recv}.${prop}`, loc, {
          rule: 'WRONG_CONTEXT_PATH',
          severity: 'error',
          message: `\`${recv}.${prop}\` is not a valid Firestore rules path. ${wrongContextMatch.suggestion}`,
          location: loc,
          fix: wrongContextMatch.suggestion,
        });
      }
    }

    const boolClaim = boolTokenClaimStringComparison(expr);
    if (boolClaim) {
      const { claim, op, literal } = boolClaim;
      emit('BOOL_TOKEN_CLAIM', `${claim}|${op}|${literal}`, loc, {
        rule: 'BOOL_TOKEN_CLAIM',
        severity: 'error',
        message:
          `\`request.auth.token.${claim}\` is a bool, but it is compared against the string ` +
          `"${literal}", a cross-type comparison that is always ${op === '==' ? 'false (rule always denies)' : 'true (rule silently allows)'}. ` +
          `Compare against the boolean literal instead: \`request.auth.token.${claim} ${op} true\`.`,
        location: loc,
        fix: `Drop the quotes: \`request.auth.token.${claim} ${op} ${literal === 'false' ? 'false' : 'true'}\`.`,
      });
    }

    if (isLengthPropertyAccessOnMethod(expr)) {
      emit('LENGTH_PROPERTY', '', loc, {
        rule: 'LENGTH_PROPERTY',
        severity: 'error',
        message: '`.length` is not a valid property in Firestore rules — use `.size()` (a method, with parentheses).',
        location: loc,
        fix: 'Replace `.length` with `.size()`.',
      });
    }

    if (expr.type === 'pathLiteral') {
      for (const seg of expr.segments) {
        if (typeof seg !== 'string') continue;
        const m = seg.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
        if (!m) continue;
        const name = m[1];
        emit('INVALID_PATH_INTERPOLATION', `${expr.raw}|${name}`, loc, {
          rule: 'INVALID_PATH_INTERPOLATION',
          severity: 'error',
          message:
            `\`{${name}}\` is not valid inside a path literal — Firestore rejects this at deploy. ` +
            `The \`{var}\` syntax is for match statement wildcards (e.g. \`match /users/{userId}\`); ` +
            `path interpolation in get()/exists()/getAfter()/existsAfter() requires \`$(var)\`. ` +
            `Replace \`{${name}}\` with \`$(${name})\` in path \`${expr.raw}\`.`,
          location: loc,
          fix: `Replace \`{${name}}\` with \`$(${name})\` inside the path argument.`,
        });
      }
    }

    if (isMethodMissingParens(expr)) {
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
  });

  return warnings;
}
