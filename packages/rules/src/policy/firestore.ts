// Opt-in target. Bind policy reads to Firestore data, then emit an ordinary
// Rules expression. Placement and the accuracy of each projection belong to the caller.
import { assembleExpression, assembleFunction } from '../grammar/FirestoreAssembler.js';
import { addParenthesizedGroup } from '../grammar/paren-groups.js';
import { compileLimitViolations } from '../grammar/compile-limits.js';
import { sourceSizeViolation } from '../grammar/source-compile-limits.js';
import { RULES_BUILTIN_FUNCTIONS } from '../grammar/builtin-functions.js';
import { walkExpr } from '../grammar/function-scopes.js';
import { firestoreGrammar, firestoreSemantics, parseExpression, parseToASTOrError } from '../grammar/FirestoreParser.js';
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';

export type FirestoreBindings = Readonly<Record<string, string>>;

export function field(expr: Expression): string | undefined {
  if (expr.type === 'identifier') return expr.name;
  if (expr.type !== 'memberAccess') return undefined;
  const parent = field(expr.object);
  return parent && parent + '.' + expr.property;
}

function projection(expr: Expression): boolean {
  switch (expr.type) {
    case 'identifier': return true;
    case 'literal': return typeof expr.value === 'boolean';
    case 'memberAccess': return projection(expr.object);
    case 'functionCall': {
      const path = expr.args[0];
      return ['get', 'getAfter'].includes(expr.name) && expr.args.length === 1 &&
        path.type === 'pathLiteral' && path.segments.every(part => typeof part === 'string' || projection(part));
    }
    default: return false;
  }
}

export function compileProjections(bindings: FirestoreBindings) {
  const result = new Map<string, Expression | string>();
  for (const [name, source] of Object.entries(bindings)) {
    if (typeof source !== 'string' || source.length > 1024 || !parseExpression(source).valid) {
      result.set(name, 'Invalid Firestore read for ' + name);
      continue;
    }
    const expr: Expression = firestoreSemantics(firestoreGrammar.match(source, 'Expr')).toAST();
    result.set(name, projection(expr) ? expr : 'Expected a data projection for ' + name);
  }
  return result;
}

function origin(expr: Expression): string {
  if (expr.type === 'literal') return 'constant';
  if (expr.type === 'functionCall') return expr.name === 'getAfter' ? 'after' : 'before';
  const name = field(expr);
  if (name === 'resource' || name?.startsWith('resource.')) return 'before';
  if (name === 'request.resource' || name?.startsWith('request.resource.')) return 'after';
  if (name === 'request.auth' || name?.startsWith('request.auth.')) return 'auth';
  if (expr.type === 'memberAccess') return origin(expr.object);
  return 'context';
}

export function lowerFirestore(
  expr: Expression,
  projections: Map<string, Expression | string>,
  projectedField = false,
  verifySyntax = false,
) {
  const inputs = new Set<string>();
  const missing = new Set<string>();
  const features = new Set<string>();
  const origins: Record<string, string> = {};
  const problems = new Set<string>();
  function lower(node: Expression): Expression {
    switch (node.type) {
      case 'memberAccess':
      case 'identifier': {
        const name = field(node);
        if (!name && node.type === 'memberAccess') return { ...node, object: lower(node.object) };
        if (!name) throw new Error('Expected policy input');
        const value = projections.get(name);
        inputs.add(name);
        if (typeof value === 'string') {
          problems.add(value);
          return node;
        }
        if (value) {
          const actual = origin(value);
          origins[name] = actual;
          const expected = name.split('.')[0];
          if ((expected === 'before' || expected === 'after') && expected !== actual)
            problems.add(name + ' requires ' + expected + ', bound to ' + actual);
          if (projectedField && expected === 'input') {
            const path = field(value);
            if (!(actual === 'constant' || actual === 'auth' || path === 'resource.data' || path?.startsWith('resource.data.')))
              problems.add(name + ' requires a trusted stored input, auth value, or constant');
          }
          return value;
        }
        missing.add(name);
        return node;
      }
      case 'literal': return node;
      case 'listLiteral': return { ...node, elements: node.elements.map(lower) };
      case 'mapLiteral': return { ...node, entries: node.entries.map(e => ({ key: lower(e.key), value: lower(e.value) })) };
      case 'unaryOp': {
        features.add(node.op);
        let operand = lower(node.operand);
        if (node.op === '-' && operand.type === 'unaryOp' && operand.op === '-') {
          operand = { ...operand };
          addParenthesizedGroup(operand);
        }
        return { ...node, operand };
      }
      case 'binaryOp': features.add(node.op); return { ...node, left: lower(node.left), right: lower(node.right) };
      case 'isExpr': features.add('is ' + node.typeName); return { ...node, value: lower(node.value) };
      case 'inExpr': features.add('in'); return { ...node, element: lower(node.element), collection: lower(node.collection) };
      case 'methodCall':
        features.add('method:' + node.method);
        return { ...node, object: lower(node.object), args: node.args.map(lower) };
      case 'ternary': {
        features.add('conditional');
        const condition = lower(node.condition);
        if (condition.type === 'literal' && typeof condition.value === 'boolean')
          return lower(condition.value ? node.consequent : node.alternate);
        return { ...node, condition, consequent: lower(node.consequent), alternate: lower(node.alternate) };
      }
      default:
        problems.add('Unsupported Firestore expression ' + node.type);
        return node;
    }
  }
  const predicate = lower(expr);
  if (missing.size) problems.add('Missing binding: ' + [...missing].join(', '));
  const source = problems.size ? undefined : assembleExpression(predicate);
  if (source) {
    // Check emitted syntax and structural compile limits before claiming any lowered predicate.
    const check = parseToASTOrError(`rules_version = '2'; service cloud.firestore {
      match /databases/{db}/documents { match /items/{id} { allow update: if ${source}; } } }`);
    if (!check.ok) problems.add(check.error.message);
    else for (const violation of compileLimitViolations(check.ast)) problems.add(violation.message);
  }
  return { inputs: [...inputs], features: [...features], origins, problems: [...problems],
    predicate: problems.size ? undefined : source };

}

/** Export the complete transition as one function in the module's service-level scope. */
export function emitFirestoreModule(name: string, rows: { requirement: string; predicate?: string }[]): string {
  if (RULES_BUILTIN_FUNCTIONS.has(name)) throw new Error('Module export conflicts with Firestore builtin: ' + name);
  const predicates = rows.map(({ requirement, predicate }) => {
    if (!predicate) throw new Error(requirement + ': missing Firestore predicate');
    const match = firestoreGrammar.match(predicate, 'Expr');
    if (match.failed()) throw new Error(requirement + ': ' + match.message);
    walkExpr(firestoreSemantics(match).toAST(), expr => {
      if (expr.type === 'identifier' && expr.name !== 'resource' && expr.name !== 'request')
        throw new Error(requirement + ': ' + expr.name + ' is not in scope in a zero-argument Firestore module helper');
    });
    return rows.length === 1 ? predicate : '(' + predicate + ')';
  });
  const fn = `function ${name}() {\n  return ${predicates.join('\n    && ')};\n}`;
  return moduleSource(fn, name + '()', rows.map(row => row.requirement).join(', '));
}

/** Export a checked pure function, preserving its parameters, local bindings and value result. */
export function emitPureFunctionModule(fn: FunctionDef): string {
  if (RULES_BUILTIN_FUNCTIONS.has(fn.name)) throw new Error('Module export conflicts with Firestore builtin: ' + fn.name);
  const call = fn.name + '(' + fn.parameters.map(() => 'null').join(', ') + ')';
  return moduleSource(assembleFunction({ ...fn, exported: false }, 0), call, fn.name);
}

function moduleSource(fn: string, call: string, label: string): string {
  const source = `rules_version = '2+modules';\n\nexport ${fn}\n`;
  const size = sourceSizeViolation(source);
  if (size) throw new Error(label + ': ' + size.message);
  const parsed = parseToASTOrError(`rules_version = '2'; service cloud.firestore {
    match /databases/{db}/documents { ${fn} match /items/{id} { allow update: if ${call}; } } }`);
  const problems = parsed.ok ? compileLimitViolations(parsed.ast).map(v => v.message) : [parsed.error.message];
  if (problems.length) throw new Error(label + ': ' + problems.join(', '));
  return source;
}
