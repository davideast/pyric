import type { Expression, FirestoreRules, FunctionDef, MatchBlock } from '../grammar/FirestoreAST.js';
import { topLevelMatches } from '../grammar/service-blocks.js';
import type { LintWarning } from './linter.js';

const LOOKUP_FUNCTIONS = new Set(['get', 'exists', 'getAfter', 'existsAfter']);
const STORAGE_FIRESTORE_LOOKUPS = new Set(['get', 'exists']);
const PLACEHOLDER_SEGMENT = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function unwrapBoundReceiver(expr: Expression): Expression {
  let target = expr;
  while (target.type === 'methodCall' && target.method === 'bind') {
    target = target.object;
  }
  return target;
}

function exprCallsBindOnName(expr: Expression, name: string): boolean {
  switch (expr.type) {
    case 'methodCall': {
      if (expr.method === 'bind') {
        const root = unwrapBoundReceiver(expr.object);
        if (root.type === 'identifier' && root.name === name) return true;
      }
      if (exprCallsBindOnName(expr.object, name)) return true;
      return expr.args.some((arg) => exprCallsBindOnName(arg, name));
    }
    case 'functionCall':
      return expr.args.some((arg) => exprCallsBindOnName(arg, name));
    case 'memberAccess':
      return exprCallsBindOnName(expr.object, name);
    case 'bracketAccess':
      return exprCallsBindOnName(expr.object, name) || exprCallsBindOnName(expr.index, name);
    case 'sliceAccess':
      return (
        exprCallsBindOnName(expr.object, name) ||
        exprCallsBindOnName(expr.start, name) ||
        exprCallsBindOnName(expr.end, name)
      );
    case 'binaryOp':
      return exprCallsBindOnName(expr.left, name) || exprCallsBindOnName(expr.right, name);
    case 'unaryOp':
      return exprCallsBindOnName(expr.operand, name);
    case 'ternary':
      return (
        exprCallsBindOnName(expr.condition, name) ||
        exprCallsBindOnName(expr.consequent, name) ||
        exprCallsBindOnName(expr.alternate, name)
      );
    case 'inExpr':
      return exprCallsBindOnName(expr.element, name) || exprCallsBindOnName(expr.collection, name);
    case 'isExpr':
      return exprCallsBindOnName(expr.value, name);
    case 'listLiteral':
      return expr.elements.some((el) => exprCallsBindOnName(el, name));
    case 'mapLiteral':
      return expr.entries.some(
        (entry) => exprCallsBindOnName(entry.key, name) || exprCallsBindOnName(entry.value, name),
      );
    case 'pathLiteral':
      return expr.segments.some((seg) => typeof seg !== 'string' && exprCallsBindOnName(seg, name));
    case 'literal':
    case 'identifier':
      return false;
  }
}

function markBoundLetPathLiterals(
  fn: FunctionDef,
  boundPathLiterals: WeakSet<Expression>,
): void {
  for (let i = 0; i < fn.lets.length; i++) {
    const binding = fn.lets[i];
    if (!binding) continue;
    const root = unwrapBoundReceiver(binding.value);
    if (root.type !== 'pathLiteral') continue;
    let boundLater = exprCallsBindOnName(fn.body, binding.name);
    if (!boundLater) {
      for (let j = i + 1; j < fn.lets.length; j++) {
        const later = fn.lets[j];
        if (!later) continue;
        if (later.name === binding.name) break;
        if (exprCallsBindOnName(later.value, binding.name)) {
          boundLater = true;
          break;
        }
      }
    }
    if (boundLater) {
      boundPathLiterals.add(root);
    }
  }
}

export function markBoundLetPathLiteralsInAst(
  ast: FirestoreRules,
  boundPathLiterals: WeakSet<Expression>,
): void {
  for (const fn of ast.functions ?? []) {
    markBoundLetPathLiterals(fn, boundPathLiterals);
  }
  for (const fn of ast.service?.functions ?? []) {
    markBoundLetPathLiterals(fn, boundPathLiterals);
  }
  const visitMatch = (match: MatchBlock): void => {
    for (const fn of match.functions) {
      markBoundLetPathLiterals(fn, boundPathLiterals);
    }
    for (const child of match.children) {
      visitMatch(child);
    }
  };
  for (const root of topLevelMatches(ast.service)) {
    visitMatch(root);
  }
}

export function markPathLiteralRoles(
  expr: Expression,
  scope: ReadonlySet<string>,
  localVars: ReadonlySet<string>,
  boundPathLiterals: WeakSet<Expression>,
  lookupPathLiterals: WeakSet<Expression>,
): void {
  if (expr.type === 'methodCall' && expr.method === 'bind') {
    const root = unwrapBoundReceiver(expr.object);
    if (root.type === 'pathLiteral') {
      boundPathLiterals.add(root);
    }
  }
  if (
    expr.type === 'functionCall' &&
    LOOKUP_FUNCTIONS.has(expr.name) &&
    !scope.has(expr.name) &&
    !localVars.has(expr.name)
  ) {
    const firstArg = expr.args[0];
    if (firstArg?.type === 'pathLiteral') {
      lookupPathLiterals.add(firstArg);
    }
  }
  if (
    expr.type === 'methodCall' &&
    expr.object.type === 'identifier' &&
    expr.object.name === 'firestore' &&
    !localVars.has('firestore') &&
    STORAGE_FIRESTORE_LOOKUPS.has(expr.method)
  ) {
    const firstArg = expr.args[0];
    if (firstArg?.type === 'pathLiteral') {
      lookupPathLiterals.add(firstArg);
    }
  }
}

export function emitPathInterpolationWarnings(
  expr: Expression,
  location: LintWarning['location'],
  boundPathLiterals: WeakSet<Expression>,
  lookupPathLiterals: WeakSet<Expression>,
  emit: (rule: string, key: string, warning: LintWarning) => void,
): void {
  if (expr.type !== 'pathLiteral' || boundPathLiterals.has(expr)) return;
  let severity: LintWarning['severity'] = 'warning';
  if (lookupPathLiterals.has(expr)) {
    severity = 'error';
  }
  for (const seg of expr.segments) {
    if (typeof seg !== 'string') continue;
    const name = PLACEHOLDER_SEGMENT.exec(seg)?.[1];
    if (!name) continue;
    emit('INVALID_PATH_INTERPOLATION', `${expr.raw}|${name}`, {
      rule: 'INVALID_PATH_INTERPOLATION',
      severity,
      message:
        `\`{${name}}\` inside an unbound path literal stays a literal segment rather than interpolating a variable -- ` +
        `the \`{var}\` syntax is for match statement wildcards or \`(/path/{var}).bind(...)\` templates, while ` +
        `path interpolation in get()/exists()/getAfter()/existsAfter() requires \`$(var)\`. ` +
        `Replace \`{${name}}\` with \`$(${name})\` in path \`${expr.raw}\`.`,
      location,
      fix: `Replace \`{${name}}\` with \`$(${name})\` inside the path argument.`,
    });
  }
}
