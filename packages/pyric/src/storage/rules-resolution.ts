import type { Expr, MatchBlock, StorageRules } from './sandbox/rules.js';

export interface StorageRulesResolution {
  readonly targetService: 'firebase.storage';
  readonly source: string;
  readonly modules: readonly string[];
  readonly bundledModules: readonly string[];
  readonly evidenceIds: readonly string[];
}

function expressionUsesFirestoreLookup(
  expression: Expr,
  shadowed: ReadonlySet<string>,
): boolean {
  if (expression.kind === 'methodcall' && expression.target.kind === 'ident' &&
      expression.target.name === 'firestore' &&
      !shadowed.has('firestore') &&
      (expression.method === 'get' || expression.method === 'exists')) return true;
  switch (expression.kind) {
    case 'member': return expressionUsesFirestoreLookup(expression.target, shadowed);
    case 'index':
      return expressionUsesFirestoreLookup(expression.target, shadowed) ||
        expressionUsesFirestoreLookup(expression.index, shadowed);
    case 'slice':
      return [expression.target, expression.start, expression.end]
        .some((value) => expressionUsesFirestoreLookup(value, shadowed));
    case 'unary': return expressionUsesFirestoreLookup(expression.arg, shadowed);
    case 'ternary':
      return [expression.cond, expression.then, expression.else]
        .some((value) => expressionUsesFirestoreLookup(value, shadowed));
    case 'in':
      return expressionUsesFirestoreLookup(expression.element, shadowed) ||
        expressionUsesFirestoreLookup(expression.collection, shadowed);
    case 'is': return expressionUsesFirestoreLookup(expression.value, shadowed);
    case 'list':
      return expression.elements.some((value) => expressionUsesFirestoreLookup(value, shadowed));
    case 'map':
      return expression.entries.some(({ key, value }) =>
        expressionUsesFirestoreLookup(key, shadowed) ||
        expressionUsesFirestoreLookup(value, shadowed));
    case 'binary':
      return expressionUsesFirestoreLookup(expression.left, shadowed) ||
        expressionUsesFirestoreLookup(expression.right, shadowed);
    case 'call':
      return expression.args.some((value) => expressionUsesFirestoreLookup(value, shadowed));
    case 'methodcall':
      return expressionUsesFirestoreLookup(expression.target, shadowed) ||
        expression.args.some((value) => expressionUsesFirestoreLookup(value, shadowed));
    case 'path':
      return expression.segments.some((segment) =>
        segment.kind === 'interp' && expressionUsesFirestoreLookup(segment.expr, shadowed));
    case 'ident':
    case 'literal': return false;
  }
}

function matchUsesFirestoreLookup(
  match: MatchBlock,
  inherited: ReadonlySet<string> = new Set(),
): boolean {
  const matchScope = new Set(inherited);
  for (const segment of match.segments) {
    if (segment.kind !== 'literal') matchScope.add(segment.name);
  }
  if (match.allows.some(({ condition }) =>
    condition && expressionUsesFirestoreLookup(condition, matchScope))) return true;
  for (const fn of match.functions) {
    const functionScope = new Set([...matchScope, ...fn.params]);
    for (const binding of fn.lets) {
      if (expressionUsesFirestoreLookup(binding.value, functionScope)) return true;
      functionScope.add(binding.name);
    }
    if (expressionUsesFirestoreLookup(fn.body, functionScope)) return true;
  }
  return match.children.some((child) => matchUsesFirestoreLookup(child, matchScope));
}

function canonicalModuleName(name: string): string {
  return /^\.\/stdlib\/(.+)\.rules$/.exec(name)?.[1] ?? name;
}

const MODULE_EVIDENCE = new Map<string, string>([
  ['auth', 'storage-rules#125'],
  ['membership', 'storage-rules#125'],
  ['storage/uploads', 'storage-rules#132'],
  ['storage/metadata', 'storage-rules#132'],
  ['storage/objects', 'storage-rules#132'],
  ['storage/time', 'storage-rules#132'],
]);

export function createStorageRulesResolution(
  source: string,
  modules: readonly string[],
  bundledModules: readonly string[],
  rules: StorageRules,
): StorageRulesResolution {
  const evidenceIds = new Set<string>();
  const canonicalModules = bundledModules.map(canonicalModuleName);
  for (const moduleName of canonicalModules) {
    const evidenceId = MODULE_EVIDENCE.get(moduleName);
    if (evidenceId) evidenceIds.add(evidenceId);
  }
  if (matchUsesFirestoreLookup(rules._root)) evidenceIds.add('storage-rules#131');
  return Object.freeze({
    targetService: 'firebase.storage',
    source,
    modules: Object.freeze([...modules]),
    bundledModules: Object.freeze([...bundledModules]),
    evidenceIds: Object.freeze([...evidenceIds].sort()),
  });
}
