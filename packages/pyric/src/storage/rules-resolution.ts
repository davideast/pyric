import { parseStorageRules, type Expr, type MatchBlock, type StorageRules } from './sandbox/rules.js';
import { re2PatternProblem } from '../rules/simulator/re2-pattern-check.js';
import { resolveModulesBrowser } from '../rules/modules/resolver-browser.js';

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

function validateExpressionRegexes(expression: Expr): void {
  if (
    expression.kind === 'methodcall' &&
    expression.method === 'matches' &&
    expression.args.length === 1
  ) {
    const arg = expression.args[0];
    const problem = arg?.kind === 'literal' && typeof arg.value === 'string' ? re2PatternProblem(arg.value) : null;
    if (problem !== null) throw new SyntaxError(`Storage rules do not compile: ${problem}`);
  }
  switch (expression.kind) {
    case 'member':
      validateExpressionRegexes(expression.target);
      return;
    case 'index':
      validateExpressionRegexes(expression.target);
      validateExpressionRegexes(expression.index);
      return;
    case 'slice':
      validateExpressionRegexes(expression.target);
      validateExpressionRegexes(expression.start);
      validateExpressionRegexes(expression.end);
      return;
    case 'unary':
      validateExpressionRegexes(expression.arg);
      return;
    case 'ternary':
      validateExpressionRegexes(expression.cond);
      validateExpressionRegexes(expression.then);
      validateExpressionRegexes(expression.else);
      return;
    case 'in':
      validateExpressionRegexes(expression.element);
      validateExpressionRegexes(expression.collection);
      return;
    case 'is':
      validateExpressionRegexes(expression.value);
      return;
    case 'list':
      for (const value of expression.elements) validateExpressionRegexes(value);
      return;
    case 'map':
      for (const { key, value } of expression.entries) {
        validateExpressionRegexes(key);
        validateExpressionRegexes(value);
      }
      return;
    case 'binary':
      validateExpressionRegexes(expression.left);
      validateExpressionRegexes(expression.right);
      return;
    case 'call':
      for (const value of expression.args) validateExpressionRegexes(value);
      return;
    case 'methodcall':
      validateExpressionRegexes(expression.target);
      for (const value of expression.args) validateExpressionRegexes(value);
      return;
    case 'path':
      for (const segment of expression.segments) {
        if (segment.kind === 'interp') validateExpressionRegexes(segment.expr);
      }
      return;
    case 'ident':
    case 'literal':
      return;
  }
}

function validateMatchRegexes(match: MatchBlock): void {
  for (const { condition } of match.allows) {
    if (condition) validateExpressionRegexes(condition);
  }
  for (const fn of match.functions) {
    for (const binding of fn.lets) {
      validateExpressionRegexes(binding.value);
    }
    validateExpressionRegexes(fn.body);
  }
  for (const child of match.children) {
    validateMatchRegexes(child);
  }
}

/** A storage rules source, lowered and parsed, with the record hosts read back. */
export interface CompiledStorageRules {
  readonly rules: StorageRules;
  readonly resolution: StorageRulesResolution;
}

/**
 * Compile a storage rules source into the ruleset the evaluator runs and the
 * resolution record hosts read back, lowering `2+modules` source first.
 * Throws on a source that does not parse or whose imports do not resolve, so
 * a caller never installs a ruleset it could not compile.
 */
export function compileStorageRules(declared: string): CompiledStorageRules {
  let source = declared;
  let modules: readonly string[] = [];
  let bundledModules: readonly string[] = [];
  let moduleEvidenceIds: readonly string[] = [];
  let rules = parseStorageRules(source);
  if (rules._version !== '2+modules') {
    if (rules._root.functions.some((fn) => fn.unresolvedImport !== undefined)) {
      throw new SyntaxError("Import statements require rules_version = '2+modules'.");
    }
  } else {
    const resolved = resolveModulesBrowser(source);
    if (!resolved.success) {
      throw new SyntaxError(
        `Storage rules module resolution failed (${resolved.error.code}): ${resolved.error.message}`,
      );
    }
    source = resolved.data.resolved;
    modules = resolved.data.modules;
    bundledModules = resolved.data.bundledModules;
    moduleEvidenceIds = resolved.data.evidenceIds;
    rules = parseStorageRules(source);
  }
  validateMatchRegexes(rules._root);
  const resolution = createStorageRulesResolution(
    source,
    modules,
    bundledModules,
    moduleEvidenceIds,
    rules,
  );
  return { rules, resolution };
}

export function createStorageRulesResolution(
  source: string,
  modules: readonly string[],
  bundledModules: readonly string[],
  moduleEvidenceIds: readonly string[],
  rules: StorageRules,
): StorageRulesResolution {
  const evidenceIds = new Set<string>();
  for (const evidenceId of moduleEvidenceIds) {
    if (evidenceId.startsWith('storage-rules#')) evidenceIds.add(evidenceId);
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
