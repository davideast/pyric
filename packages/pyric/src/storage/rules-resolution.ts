import type { Expr, MatchBlock, StorageRules } from './sandbox/rules.js';

export interface StorageRulesResolution {
  readonly targetService: 'firebase.storage';
  readonly source: string;
  readonly modules: readonly string[];
  readonly evidenceIds: readonly string[];
}

function expressionUsesFirestoreLookup(expression: Expr): boolean {
  if (expression.kind === 'methodcall' && expression.target.kind === 'ident' &&
      expression.target.name === 'firestore' &&
      (expression.method === 'get' || expression.method === 'exists')) return true;
  switch (expression.kind) {
    case 'member': return expressionUsesFirestoreLookup(expression.target);
    case 'index':
      return expressionUsesFirestoreLookup(expression.target) ||
        expressionUsesFirestoreLookup(expression.index);
    case 'slice':
      return [expression.target, expression.start, expression.end].some(expressionUsesFirestoreLookup);
    case 'unary': return expressionUsesFirestoreLookup(expression.arg);
    case 'ternary':
      return [expression.cond, expression.then, expression.else].some(expressionUsesFirestoreLookup);
    case 'in':
      return expressionUsesFirestoreLookup(expression.element) ||
        expressionUsesFirestoreLookup(expression.collection);
    case 'is': return expressionUsesFirestoreLookup(expression.value);
    case 'list': return expression.elements.some(expressionUsesFirestoreLookup);
    case 'map':
      return expression.entries.some(({ key, value }) =>
        expressionUsesFirestoreLookup(key) || expressionUsesFirestoreLookup(value));
    case 'binary':
      return expressionUsesFirestoreLookup(expression.left) ||
        expressionUsesFirestoreLookup(expression.right);
    case 'call': return expression.args.some(expressionUsesFirestoreLookup);
    case 'methodcall':
      return expressionUsesFirestoreLookup(expression.target) ||
        expression.args.some(expressionUsesFirestoreLookup);
    case 'path':
      return expression.segments.some((segment) =>
        segment.kind === 'interp' && expressionUsesFirestoreLookup(segment.expr));
    case 'ident':
    case 'literal': return false;
  }
}

function matchUsesFirestoreLookup(match: MatchBlock): boolean {
  return match.allows.some(({ condition }) => condition && expressionUsesFirestoreLookup(condition)) ||
    match.functions.some((fn) =>
      fn.lets.some(({ value }) => expressionUsesFirestoreLookup(value)) ||
      expressionUsesFirestoreLookup(fn.body)) ||
    match.children.some(matchUsesFirestoreLookup);
}

export function createStorageRulesResolution(
  source: string,
  modules: readonly string[],
  rules: StorageRules,
): StorageRulesResolution {
  const evidenceIds = new Set<string>();
  if (modules.some((name) => name === 'auth' || name === 'membership')) {
    evidenceIds.add('storage-rules#125');
  }
  if (modules.some((name) => name.startsWith('storage/'))) {
    evidenceIds.add('storage-rules#132');
  }
  if (matchUsesFirestoreLookup(rules._root)) evidenceIds.add('storage-rules#131');
  return Object.freeze({
    targetService: 'firebase.storage',
    source,
    modules: Object.freeze([...modules]),
    evidenceIds: Object.freeze([...evidenceIds].sort()),
  });
}
