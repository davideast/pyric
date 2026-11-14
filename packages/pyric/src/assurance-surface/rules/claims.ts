/**
 * Token claims the rules require of a caller for a target path and operation
 * (`auth.token.hasAccess != null` on every granting route), so probe actors
 * carry required gates without receiving disjunctive escape-hatch claims
 * (`|| auth.token.admin == true`) or claims from unrelated paths.
 */
import {
  collectRootMatches,
  parseToAST,
  type FirestoreRules,
  type FunctionDef,
  type MatchBlock,
} from '../../rules/internal/index.js';
import { parseRtdbExpressionTree } from '../../rules/internal/rtdb.js';
import {
  extractServiceHeader,
  normalizeExplicitResourceId,
} from '../../sandbox/internal/resource-pattern-header.js';
import { overlapsPattern, parseResourcePattern } from '../../sandbox/internal/resource-pattern.js';
import {
  copyClaimsInto,
  intersectClaimList,
  unionClaims,
  type Claims,
} from './claim-algebra.js';
import { rtdbEffectiveBool, rtdbExprClaims } from './rtdb-claim-expr.js';
import {
  allowCoversOp,
  fsEffectiveBool,
  fsExprClaims,
  indexFunctionScopes,
} from './rules-claim-expr.js';
import {
  formatMatchSegment,
  lowerModularRulesInMemory,
  parseRulesAstWithMultiMatch,
} from './rules-ast-utils.js';

export interface ClaimTarget {
  path: string;
  op?: string;
  bucket?: string;
  modules?: Readonly<Record<string, string>>;
}

export interface RequiredClaimsOptions {
  readonly modules?: Readonly<Record<string, string>>;
}

function splitSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Required claims for a Realtime Database path and operation. */
export function rtdbRequiredClaims(rulesJson: unknown, target: ClaimTarget, into: Claims = {}): Claims {
  const root = (rulesJson as { rules?: unknown } | null)?.rules;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return into;

  const segments = splitSegments(target.path);
  const isRead = target.op === 'get' || target.op === 'query' || target.op === 'list' || target.op === 'read';
  const isDelete = target.op === 'delete' || target.op === 'remove';
  let permKey = '.write';
  if (isRead) permKey = '.read';

  const grantingBranches: Claims[] = [];
  let validateRequired: Claims = {};

  const walkPath = (node: unknown, index: number): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;

    const permValue = record[permKey];
    if (permValue === true) {
      grantingBranches.push({});
    } else if (typeof permValue === 'string') {
      const parsed = parseRtdbExpressionTree(permValue);
      if (parsed.ok && rtdbEffectiveBool(parsed.tree, false) !== false) {
        grantingBranches.push(rtdbExprClaims(parsed.tree, false));
      }
    }

    if (!isRead && !isDelete) {
      const validateValue = record['.validate'];
      if (typeof validateValue === 'string') {
        const parsed = parseRtdbExpressionTree(validateValue);
        if (parsed.ok) {
          validateRequired = unionClaims(validateRequired, rtdbExprClaims(parsed.tree, false));
        }
      }
    }

    if (index >= segments.length) return;
    const seg = segments[index]!;
    const isTemplateVar = seg.startsWith('$') || (seg.startsWith('{') && seg.endsWith('}'));
    if (!isTemplateVar && Object.hasOwn(record, seg) && !seg.startsWith('.') && !seg.startsWith('$')) {
      walkPath(record[seg], index + 1);
      return;
    }
    for (const [childKey, childVal] of Object.entries(record)) {
      if (childKey.startsWith('$')) {
        walkPath(childVal, index + 1);
      }
    }
  };

  walkPath(root, 0);
  const permRequired = intersectClaimList(grantingBranches);
  const combined = unionClaims(permRequired, validateRequired);
  return copyClaimsInto(combined, into);
}

/** Required claims for a Firestore document path and operation. */
export function firestoreRequiredClaims(
  source: string,
  target: ClaimTarget,
  into: Claims = {},
  options?: RequiredClaimsOptions,
): Claims {
  const modules = options?.modules ?? target.modules;
  const lowerOpts: {
    targetService: 'cloud.firestore';
    modules?: Readonly<Record<string, string>>;
  } = { targetService: 'cloud.firestore' };
  if (modules !== undefined) lowerOpts.modules = modules;
  const lowered = lowerModularRulesInMemory(source, lowerOpts);
  const ast = parseToAST(lowered);
  if (!ast) return into;

  const declScopes = indexFunctionScopes(ast);
  let services = [ast.service];
  if (ast.services && ast.services.length > 0) services = ast.services;

  const matchingAllows: Claims[] = [];
  for (const service of services) {
    if (!/firestore/.test(service.name)) continue;
    const rootScope = [
      ...(ast.functions ?? []),
      ...(service.functions ?? []),
    ];
    const scopedAst: FirestoreRules = { ...ast, service };
    const matches = collectRootMatches(scopedAst, target.path, rootScope);
    for (const match of matches) {
      for (const allow of match.block.allows) {
        if (!allowCoversOp(allow.operations, target.op)) continue;
        if (fsEffectiveBool(allow.condition, match.functions, new Map(), declScopes, 0, false) === false) continue;
        matchingAllows.push(fsExprClaims(allow.condition, match.functions, new Map(), declScopes, 0, false));
      }
    }
  }

  return copyClaimsInto(intersectClaimList(matchingAllows), into);
}

/** Required claims for a Cloud Storage object path and operation. */
export function storageRequiredClaims(
  source: string,
  target: ClaimTarget,
  into: Claims = {},
  options?: RequiredClaimsOptions,
): Claims {
  const modules = options?.modules ?? target.modules;
  const parseOpts: {
    targetService: 'firebase.storage';
    modules?: Readonly<Record<string, string>>;
  } = { targetService: 'firebase.storage' };
  if (modules !== undefined) parseOpts.modules = modules;
  const services = parseRulesAstWithMultiMatch(source, parseOpts);
  if (services.length === 0) return into;

  const targetPattern = parseResourcePattern('storage', target.path, target.bucket);
  const normalizedTargetBucket = normalizeExplicitResourceId('storage', target.bucket);
  const matchingAllows: Claims[] = [];

  for (const svc of services) {
    if (!/storage/.test(svc.name)) continue;
    const declScopes = new WeakMap<FunctionDef, FunctionDef[]>();
    const rootFns = svc.functions.flat();
    for (const fn of rootFns) declScopes.set(fn, rootFns);

    const walk = (block: MatchBlock, parentSegments: readonly string[], parentFns: FunctionDef[]): void => {
      const currentFns = [...parentFns, ...block.functions];
      for (const fn of block.functions) declScopes.set(fn, currentFns);
      const fullSegments = [...parentSegments, ...block.path.segments.map(formatMatchSegment)];
      const rawRulePath = `/${fullSegments.join('/')}`;
      const header = extractServiceHeader('storage', rawRulePath);
      if (
        normalizedTargetBucket !== undefined
        && header.headerKind === 'concrete'
        && header.headerResourceId !== normalizedTargetBucket
      ) {
        return;
      }
      if (header.headerKind === 'concrete' || header.headerKind === 'wildcard') {
        const rulePattern = parseResourcePattern('storage', rawRulePath, target.bucket);
        if (overlapsPattern(rulePattern, targetPattern)) {
          for (const allow of block.allows) {
            if (!allowCoversOp(allow.operations, target.op)) continue;
            if (fsEffectiveBool(allow.condition, currentFns, new Map(), declScopes, 0, false) === false) continue;
            matchingAllows.push(fsExprClaims(allow.condition, currentFns, new Map(), declScopes, 0, false));
          }
        }
      }
      for (const child of block.children) {
        walk(child, fullSegments, currentFns);
      }
    };

    for (const topMatch of svc.matches) {
      walk(topMatch, [], rootFns);
    }
  }

  return copyClaimsInto(intersectClaimList(matchingAllows), into);
}
