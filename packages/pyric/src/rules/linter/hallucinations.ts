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
 * built-in casts: `string`, `int`, `float`, `bool`, `timestamp`).
 */
const HALLUCINATED_GLOBALS: Record<string, string> = {
  Object:     'No `Object` in rules — use `data.keys()` / `data.values()` directly',
  Array:      'No `Array` in rules — test list type with `x is list`',
  JSON:       'No `JSON` in rules — rules cannot parse or serialize JSON',
  Math:       'No `Math` in rules — inline arithmetic or ternaries',
  Date:       'No `Date` in rules — use `request.time` (a Timestamp)',
  String:     'Use lowercase `string(x)` for casting',
  Number:     'Use lowercase `int(x)` or `float(x)` for casting',
  Boolean:    'Use lowercase `bool(x)` for casting',
  parseInt:   'Use `int(x)` instead',
  parseFloat: 'Use `float(x)` instead',
  isNaN:      'No equivalent in rules',
  isFinite:   'No equivalent in rules',
  Promise:    'Rules are synchronous — no Promise support',
  undefined:  '`undefined` does not exist in rules — use `null`',
};

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

function walkAllExpressions(
  match: MatchBlock,
  visit: (expr: Expression, loc: Loc) => void,
) {
  const path = match.path.raw;
  for (const fn of match.functions) {
    const loc: Loc = { matchPath: path, functionName: fn.name };
    walkExpr(fn.body, loc, visit);
    for (const b of fn.lets) walkExpr(b.value, loc, visit);
  }
  for (let i = 0; i < match.allows.length; i++) {
    walkExpr(match.allows[i].condition, { matchPath: path, ruleIndex: i }, visit);
  }
  for (const child of match.children) walkAllExpressions(child, visit);
}

function walkExpr(
  expr: Expression,
  loc: Loc,
  visit: (expr: Expression, loc: Loc) => void,
) {
  visit(expr, loc);
  switch (expr.type) {
    case 'binaryOp': walkExpr(expr.left, loc, visit); walkExpr(expr.right, loc, visit); break;
    case 'unaryOp': walkExpr(expr.operand, loc, visit); break;
    case 'methodCall': walkExpr(expr.object, loc, visit); expr.args.forEach(a => walkExpr(a, loc, visit)); break;
    case 'memberAccess': walkExpr(expr.object, loc, visit); break;
    case 'bracketAccess': walkExpr(expr.object, loc, visit); walkExpr(expr.index, loc, visit); break;
    case 'ternary': walkExpr(expr.condition, loc, visit); walkExpr(expr.consequent, loc, visit); walkExpr(expr.alternate, loc, visit); break;
    case 'inExpr': walkExpr(expr.element, loc, visit); walkExpr(expr.collection, loc, visit); break;
    case 'isExpr': walkExpr(expr.value, loc, visit); break;
    case 'listLiteral': expr.elements.forEach(e => walkExpr(e, loc, visit)); break;
    case 'mapLiteral': expr.entries.forEach(en => { walkExpr(en.key, loc, visit); walkExpr(en.value, loc, visit); }); break;
    case 'functionCall': expr.args.forEach(a => walkExpr(a, loc, visit)); break;
  }
}

// ─── Post-parse hallucination check ───────────────────────────────────

/**
 * Walks every expression in the rules and flags JS-style code that
 * Firestore parses but cannot evaluate. Returns one warning per
 * distinct (rule, key, location) tuple — duplicate identical patterns
 * within the same rule are de-duplicated.
 */
export function checkHallucinations(ast: FirestoreRules): LintWarning[] {
  const warnings: LintWarning[] = [];
  const seen = new Set<string>();

  function emit(rule: string, key: string, loc: Loc, w: LintWarning) {
    const dedup = `${rule}|${key}|${loc.matchPath || ''}|${loc.functionName || ''}|${loc.ruleIndex ?? ''}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    warnings.push(w);
  }

  walkAllExpressions(ast.service.match, (expr, loc) => {
    // HALLUCINATED_METHOD — obj.someJsMethod(...)
    if (expr.type === 'methodCall' && HALLUCINATED_METHODS[expr.method]) {
      emit('HALLUCINATED_METHOD', expr.method, loc, {
        rule: 'HALLUCINATED_METHOD',
        severity: 'error',
        message: `\`.${expr.method}()\` does not exist in Firestore rules. ${HALLUCINATED_METHODS[expr.method]}`,
        location: loc,
        fix: HALLUCINATED_METHODS[expr.method],
      });
    }

    // HALLUCINATED_GLOBAL — Object.keys(...), JSON.parse(...), Math.max(...)
    if (expr.type === 'methodCall' && expr.object.type === 'identifier' && HALLUCINATED_GLOBALS[expr.object.name]) {
      const name = expr.object.name;
      emit('HALLUCINATED_GLOBAL', `${name}.${expr.method}`, loc, {
        rule: 'HALLUCINATED_GLOBAL',
        severity: 'error',
        message: `\`${name}.${expr.method}()\` does not exist in Firestore rules. ${HALLUCINATED_GLOBALS[name]}`,
        location: loc,
        fix: HALLUCINATED_GLOBALS[name],
      });
    }

    // HALLUCINATED_GLOBAL — bare function call: parseInt(x), isNaN(x)
    if (expr.type === 'functionCall' && HALLUCINATED_GLOBALS[expr.name]) {
      emit('HALLUCINATED_GLOBAL', expr.name, loc, {
        rule: 'HALLUCINATED_GLOBAL',
        severity: 'error',
        message: `\`${expr.name}()\` does not exist in Firestore rules. ${HALLUCINATED_GLOBALS[expr.name]}`,
        location: loc,
        fix: HALLUCINATED_GLOBALS[expr.name],
      });
    }

    // HALLUCINATED_GLOBAL — bare identifier reference (e.g. `Math` used as a value)
    if (expr.type === 'identifier' && HALLUCINATED_GLOBALS[expr.name]) {
      emit('HALLUCINATED_GLOBAL', `ref:${expr.name}`, loc, {
        rule: 'HALLUCINATED_GLOBAL',
        severity: 'error',
        message: `\`${expr.name}\` is not a Firestore rules identifier. ${HALLUCINATED_GLOBALS[expr.name]}`,
        location: loc,
        fix: HALLUCINATED_GLOBALS[expr.name],
      });
    }

    // WRONG_CONTEXT_PATH — request.data, request.uid, resource.path, etc.
    if (expr.type === 'memberAccess' && expr.object.type === 'identifier') {
      const recv = expr.object.name;
      const prop = expr.property;
      const m = WRONG_CONTEXT_PATHS.find(p => p.receiver === recv && p.property === prop);
      if (m) {
        emit('WRONG_CONTEXT_PATH', `${recv}.${prop}`, loc, {
          rule: 'WRONG_CONTEXT_PATH',
          severity: 'error',
          message: `\`${recv}.${prop}\` is not a valid Firestore rules path. ${m.suggestion}`,
          location: loc,
          fix: m.suggestion,
        });
      }
    }

    // LENGTH_PROPERTY — `.length` accessed on the result of a method call,
    // which is unambiguously a JS confusion (CEL methods return lists or
    // strings, neither of which has `.length` — both have `.size()`).
    // Skip when the receiver is plain data, since fields named "length"
    // are legitimate on user documents.
    if (
      expr.type === 'memberAccess' &&
      expr.property === 'length' &&
      expr.object.type === 'methodCall'
    ) {
      emit('LENGTH_PROPERTY', '', loc, {
        rule: 'LENGTH_PROPERTY',
        severity: 'error',
        message: '`.length` is not a valid property in Firestore rules — use `.size()` (a method, with parentheses).',
        location: loc,
        fix: 'Replace `.length` with `.size()`.',
      });
    }

    // INVALID_PATH_INTERPOLATION — `{var}` syntax used inside a path literal,
    // which is the match-statement wildcard syntax in the wrong context.
    // Path literals (the argument to get/exists/getAfter/existsAfter) require
    // `$(var)` for interpolation. Without this rule, the parser would
    // backtrack into MapLiteral and emit an opaque "expected ':'" diagnostic
    // that an iterating agent cannot recover from. We accept `{ident}` in the
    // grammar specifically so this diagnostic can fire.
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

    // METHOD_MISSING_PARENS — built-in method name accessed as a bare
    // property (e.g. `data.size` instead of `data.size()`). Restricted
    // to receivers that are likely rules data, and emitted as `warning`
    // because field names can collide with method names.
    if (expr.type === 'memberAccess' && KNOWN_BUILTIN_METHODS.has(expr.property)) {
      const isLikelyData =
        (expr.object.type === 'identifier' &&
          (expr.object.name === 'request' || expr.object.name === 'resource')) ||
        expr.object.type === 'memberAccess' ||
        expr.object.type === 'methodCall' ||
        expr.object.type === 'bracketAccess';
      if (isLikelyData) {
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
