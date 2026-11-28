// Opt-in Firebase Storage Rules v2 lowering and template composition target.
// Binds policy reads to Storage request/resource projections, emits standard
// Storage Rules v2 expressions, and verifies syntax, compile limits, and RE2
// regex validity via @pyric/rules's Storage parser.
import { assembleExpression, assembleRules } from '../grammar/FirestoreAssembler.js';
import { addParenthesizedGroup } from '../grammar/paren-groups.js';
import { RULES_BUILTIN_FUNCTIONS } from '../grammar/builtin-functions.js';
import { exprContains, walkExpr } from '../grammar/function-scopes.js';
import { firestoreGrammar, firestoreSemantics, parseExpression, parseToASTOrError } from '../grammar/FirestoreParser.js';
import type { Expression, MatchBlock, Operation } from '../grammar/FirestoreAST.js';
import { sourceSizeViolation } from '../grammar/source-compile-limits.js';
import { expandVerb, parseStorageRules, type StorageGrantVerb } from '../storage/rules.js';
import { field } from './firestore.js';

export type StorageBindings = Readonly<Record<string, string>>;

export interface StoragePlacement {
  path: string;
  operation: StorageGrantVerb;
  bindings: StorageBindings;
}

export interface StorageTemplate {
  rules: string;
  slot: string;
  placements: readonly StoragePlacement[];
}

export interface StorageLoweringResult {
  inputs: string[];
  features: string[];
  origins: Record<string, string>;
  problems: string[];
  predicate?: string;
}

const REQUEST_RESOURCE_FIELDS = new Set([
  'size',
  'contentType',
  'metadata',
  'name',
  'bucket',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
  'cacheControl',
  'generation',
  'metageneration',
  'md5Hash',
  'crc32c',
  'etag',
]);

const STORED_RESOURCE_FIELDS = new Set([
  ...REQUEST_RESOURCE_FIELDS,
  'timeCreated',
  'updated',
]);

const ALLOWED_STORAGE_METHODS: Readonly<Record<string, readonly number[]>> = {
  size: [0],
  matches: [1],
  lower: [0],
  upper: [0],
  trim: [0],
  split: [1],
  replace: [2],
  keys: [0],
  values: [0],
  get: [2],
  hasAll: [1],
  hasAny: [1],
  hasOnly: [1],
  concat: [1],
  join: [1],
  removeAll: [1],
  toSet: [0],
  toUtf8: [0],
};

function isValidFirestoreLookup(expr: Expression): boolean {
  if (expr.type !== 'methodCall') return false;
  if (expr.object.type !== 'identifier' || expr.object.name !== 'firestore') return false;
  if ((expr.method !== 'get' && expr.method !== 'exists') || expr.args.length !== 1) return false;
  const path = expr.args[0];
  if (path?.type !== 'pathLiteral') return false;
  return path.segments.every((part) => typeof part === 'string' || isStorageProjection(part));
}

function isStorageProjection(expr: Expression): boolean {
  switch (expr.type) {
    case 'literal':
      return typeof expr.value === 'boolean' || typeof expr.value === 'string'
        || typeof expr.value === 'number' || expr.value === null;
    case 'identifier':
      return !RULES_BUILTIN_FUNCTIONS.has(expr.name);
    case 'memberAccess': {
      const dotted = field(expr);
      if (dotted) {
        const parts = dotted.split('.');
        if (parts[0] === 'resource') {
          if (parts.length < 2 || !STORED_RESOURCE_FIELDS.has(parts[1]!)) return false;
          if (parts.length > 2 && parts[1] !== 'metadata') return false;
          return true;
        }
        if (parts[0] === 'request') {
          if (parts[1] === 'auth') return true;
          if (parts[1] === 'resource') {
            if (parts.length === 2) return true;
            if (!REQUEST_RESOURCE_FIELDS.has(parts[2]!)) return false;
            if (parts.length > 3 && parts[2] !== 'metadata') return false;
            return true;
          }
          if (parts[1] === 'path' || parts[1] === 'time' || parts[1] === 'method') return parts.length === 2;
          return false;
        }
      }
      return isStorageProjection(expr.object);
    }
    case 'methodCall':
      return isValidFirestoreLookup(expr);
    default:
      return false;
  }
}

export function compileStorageProjections(bindings: StorageBindings): Map<string, Expression | string> {
  const result = new Map<string, Expression | string>();
  for (const [name, source] of Object.entries(bindings)) {
    if (typeof source !== 'string' || source.length > 1024 || !parseExpression(source).valid) {
      result.set(name, 'Invalid Storage read for ' + name);
      continue;
    }
    const expr: Expression = firestoreSemantics(firestoreGrammar.match(source, 'Expr')).toAST();
    result.set(name, isStorageProjection(expr) ? expr : 'Expected a Storage data projection for ' + name);
  }
  return result;
}

function storageOrigin(expr: Expression): string {
  if (expr.type === 'literal') return 'constant';
  if (expr.type === 'methodCall' && expr.object.type === 'identifier' && expr.object.name === 'firestore') {
    return 'before';
  }
  const name = field(expr);
  if (name === 'resource' || name?.startsWith('resource.')) return 'before';
  if (name === 'request.resource' || name?.startsWith('request.resource.')) return 'after';
  if (name === 'request.auth' || name?.startsWith('request.auth.')) return 'auth';
  if (expr.type === 'memberAccess') return storageOrigin(expr.object);
  return 'context';
}

function attachMembers(base: Expression, keys: readonly string[]): Expression {
  let current = base;
  for (const property of keys) {
    current = { type: 'memberAccess', object: current, property };
  }
  return current;
}

function resolveProjection(
  name: string,
  projections: ReadonlyMap<string, Expression | string>,
): { value: Expression | string; boundKey: string } | undefined {
  if (projections.has(name)) {
    return { value: projections.get(name)!, boundKey: name };
  }
  const parts = name.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('.');
    if (projections.has(prefix)) {
      const base = projections.get(prefix)!;
      if (typeof base === 'string') return { value: base, boundKey: prefix };
      const derived = attachMembers(base, parts.slice(i));
      if (!isStorageProjection(derived)) {
        return { value: 'Invalid Storage field projection for ' + name, boundKey: prefix };
      }
      return { value: derived, boundKey: prefix };
    }
  }
  return undefined;
}

const STORAGE_ABSENT_ERROR_ROOTS = new Set(['request.auth', 'resource', 'request.resource']);

function isAbsentErrorRoot(expr: Expression): string | undefined {
  const dotted = field(expr);
  return dotted && STORAGE_ABSENT_ERROR_ROOTS.has(dotted) ? dotted : undefined;
}

function isNullLiteral(expr: Expression): boolean {
  return expr.type === 'literal' && expr.value === null;
}

export function lowerStorage(
  expr: Expression,
  projections: ReadonlyMap<string, Expression | string>,
  projectedField = false,
): StorageLoweringResult {
  const inputs = new Set<string>();
  const missing = new Set<string>();
  const features = new Set<string>();
  const origins: Record<string, string> = {};
  const problems = new Set<string>();

  function rejectBareRoot(lowered: Expression, context: string): void {
    const root = isAbsentErrorRoot(lowered);
    if (root) {
      problems.add(
        context + ' on Storage ' + root + ' diverges: Storage raises an evaluation error when absent rather than null',
      );
    }
  }

  function lower(node: Expression, monotonePos: boolean, allowBareRoot = false): Expression {
    switch (node.type) {
      case 'memberAccess':
      case 'identifier': {
        const name = field(node);
        if (!name && node.type === 'memberAccess') {
          return { ...node, object: lower(node.object, false, true) };
        }
        if (!name) throw new Error('Expected policy input');
        inputs.add(name);
        const found = resolveProjection(name, projections);
        if (!found) {
          missing.add(name);
          return node;
        }
        const value = found.value;
        if (typeof value === 'string') {
          problems.add(value);
          return node;
        }
        const actual = storageOrigin(value);
        origins[name] = actual;
        const expected = name.split('.')[0];
        if ((expected === 'before' || expected === 'after') && expected !== actual) {
          problems.add(name + ' requires ' + expected + ', bound to ' + actual);
        }
        if (projectedField && expected === 'input') {
          if (actual !== 'constant' && actual !== 'auth' && actual !== 'context' && actual !== 'before') {
            problems.add(name + ' requires a trusted Storage input, auth value, or constant');
          }
        }
        if (!allowBareRoot) rejectBareRoot(value, 'Bare reference');
        return value;
      }
      case 'literal':
        return node;
      case 'listLiteral':
        return { ...node, elements: node.elements.map((item) => lower(item, false)) };
      case 'mapLiteral':
        return {
          ...node,
          entries: node.entries.map((entry) => ({
            key: lower(entry.key, false),
            value: lower(entry.value, false),
          })),
        };
      case 'unaryOp': {
        features.add(node.op);
        let operand = lower(node.operand, false);
        if (node.op === '-' && operand.type === 'unaryOp' && operand.op === '-') {
          operand = { ...operand };
          addParenthesizedGroup(operand);
        }
        return { ...node, operand };
      }
      case 'binaryOp': {
        features.add(node.op);
        if (node.op === '&&' || node.op === '||') {
          return {
            ...node,
            left: lower(node.left, monotonePos),
            right: lower(node.right, monotonePos),
          };
        }
        if (node.op === '!=') {
          const left = lower(node.left, false, true);
          const right = lower(node.right, false, true);
          const leftRoot = isAbsentErrorRoot(left);
          const rightRoot = isAbsentErrorRoot(right);
          if (leftRoot) {
            if (!monotonePos || !isNullLiteral(right)) {
              rejectBareRoot(left, monotonePos ? 'Non-null comparison with non-null value' : 'Non-monotone != null check');
            }
          }
          if (rightRoot) {
            if (!monotonePos || !isNullLiteral(left)) {
              rejectBareRoot(right, monotonePos ? 'Non-null comparison with non-null value' : 'Non-monotone != null check');
            }
          }
          return { ...node, left, right };
        }
        return { ...node, left: lower(node.left, false), right: lower(node.right, false) };
      }
      case 'isExpr': {
        features.add('is ' + node.typeName);
        const value = lower(node.value, false, true);
        if (isAbsentErrorRoot(value) && (!monotonePos || node.typeName !== 'map')) {
          rejectBareRoot(value, 'is ' + node.typeName + (monotonePos ? '' : ' in non-monotone position'));
        }
        return { ...node, value };
      }
      case 'inExpr':
        features.add('in');
        return {
          ...node,
          element: lower(node.element, false),
          collection: lower(node.collection, false, true),
        };
      case 'bracketAccess':
        features.add('index');
        return {
          ...node,
          object: lower(node.object, false, true),
          index: lower(node.index, false),
        };
      case 'methodCall': {
        const allowed = ALLOWED_STORAGE_METHODS[node.method];
        if (!allowed || !allowed.includes(node.args.length)) {
          problems.add('Unsupported Storage method ' + node.method + '/' + node.args.length);
          return node;
        }
        features.add('method:' + node.method);
        return {
          ...node,
          object: lower(node.object, false, true),
          args: node.args.map((arg) => lower(arg, false)),
        };
      }
      case 'ternary': {
        features.add('conditional');
        const condition = lower(node.condition, false);
        if (condition.type === 'literal' && typeof condition.value === 'boolean') {
          return lower(condition.value ? node.consequent : node.alternate, monotonePos);
        }
        return {
          ...node,
          condition,
          consequent: lower(node.consequent, monotonePos),
          alternate: lower(node.alternate, monotonePos),
        };
      }
      default:
        problems.add('Unsupported Storage expression ' + node.type);
        return node;
    }
  }

  const predicate = lower(expr, true);
  if (missing.size) problems.add('Missing binding: ' + [...missing].join(', '));
  const source = problems.size ? undefined : assembleExpression(predicate);
  if (source) {
    const wrapped = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      `      allow create, update: if ${source};`,
      '    }',
      '  }',
      '}',
    ].join('\n');
    const sizeErr = sourceSizeViolation(wrapped);
    if (sizeErr) {
      problems.add(sizeErr.message);
    } else {
      try {
        parseStorageRules(wrapped);
      } catch (error) {
        problems.add(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return {
    inputs: [...inputs],
    features: [...features],
    origins,
    problems: [...problems],
    predicate: problems.size ? undefined : source,
  };
}

export function emitStorageModule(name: string, rows: readonly { requirement: string; predicate?: string }[]): string {
  if (RULES_BUILTIN_FUNCTIONS.has(name)) {
    throw new Error('Module export conflicts with Storage builtin: ' + name);
  }
  const predicates = rows.map(({ requirement, predicate }) => {
    if (!predicate) throw new Error(requirement + ': missing Storage predicate');
    const match = firestoreGrammar.match(predicate, 'Expr');
    if (match.failed()) throw new Error(requirement + ': ' + match.message);
    walkExpr(firestoreSemantics(match).toAST(), (expr) => {
      if (expr.type === 'identifier' && expr.name !== 'resource' && expr.name !== 'request' && expr.name !== 'firestore') {
        throw new Error(requirement + ': ' + expr.name + ' is not in scope in a zero-argument Storage module helper');
      }
    });
    return rows.length === 1 ? predicate : '(' + predicate + ')';
  });
  const fn = `function ${name}() {\n  return ${predicates.join('\n    && ')};\n}`;
  const source = `rules_version = '2+modules';\n\nexport ${fn}\n`;
  const size = sourceSizeViolation(source);
  if (size) throw new Error(name + ': ' + size.message);
  const checkSource = [
    "rules_version = '2';",
    'service firebase.storage {',
    '  match /b/{bucket}/o {',
    `    ${fn}`,
    `    match /items/{id} { allow create, update: if ${name}(); }`,
    '  }',
    '}',
  ].join('\n');
  parseStorageRules(checkSource);
  return source;
}

function slotCall(node: Expression, slot: string): boolean {
  return node.type === 'functionCall' && node.name === slot && node.args.length === 0;
}

function replaceConjunct(expr: Expression, slot: string, replacement: Expression): Expression {
  if (slotCall(expr, slot)) return replacement;
  if (expr.type !== 'binaryOp' || expr.op !== '&&') return expr;
  return {
    ...expr,
    left: replaceConjunct(expr.left, slot, replacement),
    right: replaceConjunct(expr.right, slot, replacement),
  };
}

function countSlots(expr: Expression, slot: string): number {
  if (slotCall(expr, slot)) return 1;
  if (expr.type === 'binaryOp' && expr.op === '&&') {
    return countSlots(expr.left, slot) + countSlots(expr.right, slot);
  }
  if (exprContains(expr, (node) => node.type === 'functionCall' && node.name === slot)) {
    throw new Error(slot + ' must be a zero-argument call in a required conjunct');
  }
  return 0;
}

function verbsOverlap(opsA: readonly Operation[], opB: StorageGrantVerb): boolean {
  const expandedB = new Set(expandVerb(opB));
  return opsA.some((op) => expandVerb(op as StorageGrantVerb).some((verb) => expandedB.has(verb)));
}

const NO_REQUEST_RESOURCE_OPS = new Set<StorageGrantVerb>(['read', 'get', 'list', 'delete', 'write']);
const NO_STORED_RESOURCE_OPS = new Set<StorageGrantVerb>(['create', 'write']);

export function composeStorage<R extends { requirement: string; reason: string; predicate?: string; completeReason?: string; origins?: Record<string, string> }>(
  template: StorageTemplate,
  names: readonly string[],
  lower: (bindings: StorageBindings) => R[],
): { rules: string; placements: { path: string; operation: StorageGrantVerb; requirements: R[] }[] } {
  const parsed = parseToASTOrError(template.rules);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const ast = parsed.ast;
  const root = ast.service.match;
  if (ast.service.name !== 'firebase.storage' || (ast.services?.length ?? 1) !== 1 ||
      (ast.service.matches?.length ?? 1) !== 1 || ast.imports.length ||
      ast.functions?.length || ast.service.functions?.length) {
    throw new Error('Expected one standalone Storage service and bucket root');
  }
  const declarations = root.functions.filter((fn) => fn.name === template.slot);
  const slot = declarations[0];
  if (declarations.length !== 1 || slot!.parameters.length || slot!.lets.length ||
      slot!.body.type !== 'literal' || slot!.body.value !== false) {
    throw new Error('Expected a zero-argument bucket-root slot returning false: ' + template.slot);
  }

  const pending = new Map<string, StoragePlacement>();
  const diagnostics: string[] = [];
  const report: { path: string; operation: StorageGrantVerb; requirements: R[] }[] = [];
  for (const placement of template.placements) {
    const key = placement.operation + ' ' + placement.path;
    if (pending.has(key)) throw new Error('Duplicate placement: ' + key);
    pending.set(key, placement);
  }

  function visit(block: MatchBlock, path: string): void {
    if (block !== root && block.functions.some((fn) => fn.name === template.slot)) {
      throw new Error('Shadowed policy slot at ' + path);
    }
    for (const fn of block.functions) {
      if ([fn.body, ...fn.lets.map((b) => b.value)].some((expr) =>
        exprContains(expr, (node) => node.type === 'functionCall' && node.name === template.slot))) {
        throw new Error('Policy slot inside helper ' + fn.name + ' at ' + path);
      }
    }
    for (const allow of block.allows) {
      const count = countSlots(allow.condition, template.slot);
      if (count === 0) continue;
      if (count > 1) throw new Error('Repeated policy slot at ' + path);
      const operation = allow.operations[0] as StorageGrantVerb;
      if (allow.operations.length !== 1) {
        throw new Error('A policy slot needs a single operation at ' + path);
      }
      const key = operation + ' ' + path;
      if (block.allows.some((other) => other !== allow && verbsOverlap(other.operations, operation))) {
        throw new Error('Another allow covers ' + key);
      }
      const placement = pending.get(key);
      if (!placement) {
        diagnostics.push('Missing placement ' + key + ': ' + names.join(', '));
        continue;
      }
      pending.delete(key);
      const requirements = lower(placement.bindings);
      const residual = requirements.filter((row) => !row.predicate || row.completeReason);
      if (residual.length) {
        diagnostics.push(...residual.map((row) => key + ' ' + row.requirement + ': ' + (row.completeReason ?? row.reason)));
        continue;
      }
      if (NO_REQUEST_RESOURCE_OPS.has(operation)) {
        const usesIncoming = requirements.some((row) =>
          Object.values(row.origins ?? {}).includes('after'));
        if (usesIncoming) {
          diagnostics.push(key + ': request.resource is unset on Storage ' + operation + ' requests');
          continue;
        }
      }
      if (NO_STORED_RESOURCE_OPS.has(operation)) {
        const usesStored = requirements.some((row) =>
          Object.values(row.origins ?? {}).includes('before'));
        if (usesStored) {
          diagnostics.push(key + ': resource is unset on Storage ' + operation + ' requests');
          continue;
        }
      }
      const predicates = requirements.map((row) => {
        const match = firestoreGrammar.match(row.predicate!, 'Expr');
        if (match.failed()) throw new Error(match.message);
        return firestoreSemantics(match).toAST() as Expression;
      });
      const condition = predicates.reduce((left, right) => ({ type: 'binaryOp', op: '&&', left, right }));
      allow.condition = replaceConjunct(allow.condition, template.slot, condition);
      report.push({ path, operation, requirements });
    }
    for (const child of block.children) visit(child, path + child.path.raw);
  }

  visit(root, root.path.raw);
  for (const key of pending.keys()) {
    diagnostics.push('Missing conjunctive policy slot for ' + key + ': ' + names.join(', '));
  }
  if (!report.length && !diagnostics.length) diagnostics.push('No policy placements: ' + names.join(', '));
  if (diagnostics.length) throw new Error(diagnostics.join('\n'));
  const rules = assembleRules(ast);
  parseStorageRules(rules);
  return { rules, placements: report };
}
