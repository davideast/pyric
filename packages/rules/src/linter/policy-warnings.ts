import type { AllowRule, FunctionDef, MatchBlock, PathSegment } from '../grammar/FirestoreAST.js';
import { recursiveScope, type RecursiveScope } from '../grammar/recursive-scope.js';
import type { TestCase } from '../test/spec.js';
import {
  evalConstBool,
  extractConjuncts,
  referencesRequestTime,
  serializeExpression,
} from './ast-utils.js';
import type { LintWarning } from './linter.js';

/** A recursive scope together with the rule's index in its match block. */
export type RuleScope = RecursiveScope & { ruleIndex: number };

const WRITE_OPS: ReadonlySet<string> = new Set([
  'write',
  'create',
  'update',
  'delete',
]);

export function checkRequestTimePinned(
  rules: { rule: AllowRule; path: string }[],
  ruleScopes: ReadonlyMap<AllowRule, ReadonlyMap<string, FunctionDef>>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  testCases: TestCase[],
  warnings: LintWarning[],
): void {
  const emptyScope = new Map<string, FunctionDef>();
  const timeGatedRules = new Set<number>();
  for (let i = 0; i < rules.length; i++) {
    const fnMap = ruleScopes.get(rules[i]!.rule) ?? emptyScope;
    if (referencesRequestTime(rules[i]!.rule.condition, fnMap, new Set(), fnScopes)) {
      timeGatedRules.add(i);
    }
  }
  if (timeGatedRules.size === 0) return;

  function pathMatches(rulePath: string, tcPath: string): boolean {
    const ruleSegs = rulePath.split('/').filter(Boolean);
    const tcSegs = tcPath.split('/').filter(Boolean);
    if (ruleSegs.length !== tcSegs.length) return false;
    for (let i = 0; i < ruleSegs.length; i++) {
      const rs = ruleSegs[i]!;
      if (rs.startsWith('{') && rs.endsWith('}')) continue;
      if (rs !== tcSegs[i]) return false;
    }
    return true;
  }

  for (const tc of testCases) {
    if (tc.requestTime) continue;
    for (const ruleIdx of timeGatedRules) {
      if (!pathMatches(rules[ruleIdx]!.path, tc.path)) continue;
      warnings.push({
        rule: 'REQUEST_TIME_NOT_PINNED',
        severity: 'warning',
        message: `Test case "${tc.description}" targets rule #${ruleIdx} (path '${rules[ruleIdx]!.path}') which reads request.time, but does not set requestTime. Result is non-deterministic across runs.`,
        location: {
          ruleIndex: ruleIdx,
          matchPath: rules[ruleIdx]!.path,
          testCaseDescription: tc.description,
        },
        fix: 'Set requestTime on this TestCase to an ISO-8601 timestamp so the rule evaluates deterministically.',
      });
    }
  }
}

export function checkPermissiveRules(
  rules: { rule: AllowRule; path: string }[],
  scopes: ReadonlyMap<AllowRule, RuleScope>,
  warnings: LintWarning[],
  isStorage = false,
): void {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    if (evalConstBool(r.rule.condition) !== true) continue;
    const grantsWrite = r.rule.operations.some((op) => WRITE_OPS.has(op));
    if (!grantsWrite) continue;
    const ops = r.rule.operations.join(', ');
    const scopeDescription = scopes.get(r.rule)?.description ?? 'the matched paths';
    let fix =
      'Replace the always-true predicate with a request-shape check (e.g. request.auth != null && request.resource.data.ownerId == request.auth.uid).';
    if (isStorage) {
      fix =
        "Replace the always-true predicate with a request-shape check (e.g. request.auth != null && request.resource.size < 5 * 1024 * 1024 && request.resource.contentType.matches('image/.*')).";
    }
    warnings.push({
      rule: 'PERMISSIVE_RULE',
      severity: 'warning',
      message:
        `allow ${ops} at ${r.path} resolves to a constant true predicate \u2014 ` +
        `this disables write security for ${scopeDescription}. If you reached ` +
        `for \`if true\` to escape a denial you don't understand, narrow ` +
        `the predicate to the specific request shape instead (auth identity, ` +
        `affected fields via diff, status transitions).`,
      location: { ruleIndex: i, matchPath: r.path },
      fix,
    });
  }
}

export function collectRecursiveScopes(
  match: MatchBlock,
  prefix: readonly PathSegment[],
  scopes: Map<AllowRule, RuleScope>,
): Map<AllowRule, RuleScope> {
  const segments = [...prefix, ...match.path.segments];
  const scope = recursiveScope(segments);
  if (scope) {
    match.allows.forEach((rule, ruleIndex) => scopes.set(rule, { ...scope, ruleIndex }));
  }
  for (const child of match.children) collectRecursiveScopes(child, segments, scopes);
  return scopes;
}

export function checkRecursiveWildcardOpen(
  scopes: ReadonlyMap<AllowRule, RuleScope>,
  warnings: LintWarning[],
): void {
  for (const [rule, scope] of scopes) {
    if (scope.kind !== 'subtree' || evalConstBool(rule.condition) !== true) continue;
    warnings.push({
      rule: 'RECURSIVE_WILDCARD_OPEN',
      severity: 'error',
      message:
        `match ${scope.fullPath} allows ${rule.operations.join(', ')} on ` +
        `${scope.description} with an always-true condition.`,
      location: { ruleIndex: scope.ruleIndex, matchPath: scope.fullPath },
      fix: 'Narrow the match path to the collections that must be open, for example match /{path=**}/<collection>/{id} for one collection group, or replace `if true` with a real predicate (auth identity, ownership, role).',
    });
  }
}

function normalizePathSegment(seg: { type: string; name?: string; value?: string }): string {
  if (seg.type === 'literal') return seg.value ?? '';
  if (seg.type === 'wildcard') return '{*}';
  if (seg.type === 'recursive') return '{**}';
  return '';
}

function buildMatchPathChain(segments: PathSegment[]): string {
  return segments.map(normalizePathSegment).join('/');
}

function collectMatchBlocksWithPaths(
  match: MatchBlock,
  parentPath: string,
): Array<{ block: MatchBlock; normalizedPath: string }> {
  const localPath = buildMatchPathChain(match.path.segments);
  const fullPath = parentPath ? `${parentPath}/${localPath}` : localPath;
  const out: Array<{ block: MatchBlock; normalizedPath: string }> = [
    { block: match, normalizedPath: fullPath },
  ];
  for (const child of match.children) {
    out.push(...collectMatchBlocksWithPaths(child, fullPath));
  }
  return out;
}

export function checkRulesWeakened(
  currentMatches: readonly MatchBlock[],
  previousMatches: readonly MatchBlock[],
  warnings: LintWarning[],
): void {
  const currentBlocks = currentMatches.flatMap((m) => collectMatchBlocksWithPaths(m, ''));
  const previousBlocks = previousMatches.flatMap((m) => collectMatchBlocksWithPaths(m, ''));

  const currentByPath = new Map<string, MatchBlock>();
  for (const { block, normalizedPath } of currentBlocks) {
    if (!currentByPath.has(normalizedPath)) currentByPath.set(normalizedPath, block);
  }

  for (const { block: prevBlock, normalizedPath } of previousBlocks) {
    const curBlock = currentByPath.get(normalizedPath);
    if (!curBlock) {
      if (prevBlock.allows.length > 0) {
        warnings.push({
          rule: 'RULES_WEAKENED',
          severity: 'warning',
          message: `Match block removed: ${normalizedPath}`,
          location: { matchPath: normalizedPath },
        });
      }
      continue;
    }

    for (const prevAllow of prevBlock.allows) {
      const opsKey = [...prevAllow.operations].sort().join(',');
      const curAllow = curBlock.allows.find(
        (a) => [...a.operations].sort().join(',') === opsKey,
      );
      const opsLabel = prevAllow.operations.join(', ');
      if (!curAllow) {
        warnings.push({
          rule: 'RULES_WEAKENED',
          severity: 'warning',
          message: `Allow rule removed: ${normalizedPath} allow ${opsLabel}`,
          location: { matchPath: normalizedPath },
        });
        continue;
      }

      const prevConjuncts = extractConjuncts(prevAllow.condition).map(serializeExpression);
      const curConjuncts = new Set(
        extractConjuncts(curAllow.condition).map(serializeExpression),
      );
      for (const pc of prevConjuncts) {
        if (!curConjuncts.has(pc)) {
          warnings.push({
            rule: 'RULES_WEAKENED',
            severity: 'warning',
            message: `Predicate removed from ${normalizedPath} allow ${opsLabel}: ${pc}`,
            location: { matchPath: normalizedPath },
          });
        }
      }
    }
  }
}
