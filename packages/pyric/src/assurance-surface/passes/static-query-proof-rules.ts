/**
 * Firestore Rules AST projection and inspection helpers for
 * {@link staticQueryProofPass}.
 */
import { assembleExpression } from '../../rules/grammar/FirestoreAssembler.js';
import type {
  AllowRule,
  Expression,
  FirestoreRules,
  FunctionDef,
  MatchBlock,
  PathSegment,
} from '../../rules/grammar/FirestoreAST.js';
import { topLevelMatches } from '../../rules/grammar/service-blocks.js';
import {
  analyzeListRulePathInvariance,
  buildListRuleFunctionScope,
} from '../../rules/simulator/list-rule-path-proof.js';
import { indexRulesetScopes } from '../../rules/simulator/match-resolution.js';
import { substituteIdentifiers } from '../../rules/simulator/query-proof-scope.js';
import {
  collectRootMatches,
  resolveRootBlockMatch,
  rootBlockGovernsEveryDocument,
  rootGovernsEveryDocument,
} from '../../rules/simulator/root-match.js';
import { SYNTH_UID, type ScalarValue } from './static-query-proof-args.js';

export interface RetainedRulesInspection {
  readonly usesUnseededContext: boolean;
  readonly usesRequestQuery: boolean;
  readonly primaryRule?: { readonly line?: number; readonly expression: string };
}

export function rulesetHasRootForDatabase(ast: FirestoreRules, resourceId: string): boolean {
  for (const rootBlock of topLevelMatches(ast.service)) {
    const segments = rootBlock.path.segments;
    const first = segments[0];
    const second = segments[1];
    const third = segments[2];
    if (first?.type === 'recursive') return true;
    if (
      first?.type === 'literal'
      && first.value === 'databases'
      && second !== undefined
      && (third === undefined || (third.type === 'literal' && third.value === 'documents') || third.type === 'recursive')
    ) {
      if (
        second.type === 'wildcard'
        || second.type === 'recursive'
        || (second.type === 'literal' && second.value === resourceId)
      ) {
        return true;
      }
    }
  }
  return false;
}

function normalizeRootMatchBlock(rootBlock: MatchBlock, resourceId: string): MatchBlock {
  const segments = rootBlock.path.segments;
  const first = segments[0];
  const second = segments[1];
  if (
    first?.type !== 'literal'
    || first.value !== 'databases'
    || second?.type !== 'literal'
  ) {
    return rootBlock;
  }
  if (second.value === resourceId) {
    const normalizedSegments: PathSegment[] = [...segments];
    normalizedSegments[1] = { type: 'literal', value: '(default)' };
    return {
      ...rootBlock,
      path: {
        ...rootBlock.path,
        segments: normalizedSegments,
      },
    };
  }
  if (second.value === '(default)' && resourceId !== '(default)') {
    const normalizedSegments: PathSegment[] = [...segments];
    normalizedSegments[1] = { type: 'literal', value: '__pyric_non_default_root__' };
    return {
      ...rootBlock,
      path: {
        ...rootBlock.path,
        segments: normalizedSegments,
      },
    };
  }
  return rootBlock;
}

export function normalizeDatabaseRootAst(
  ast: FirestoreRules,
  resourceId: string,
): FirestoreRules {
  if (resourceId === '(default)') return ast;
  const normalizeService = <T extends FirestoreRules['service']>(svc: T): T => {
    const roots = topLevelMatches(svc);
    let changed = false;
    const normalizedRoots = roots.map((rootBlock) => {
      const next = normalizeRootMatchBlock(rootBlock, resourceId);
      if (next !== rootBlock) changed = true;
      return next;
    });
    if (!changed || normalizedRoots.length === 0) return svc;
    return {
      ...svc,
      match: normalizedRoots[0]!,
      matches: normalizedRoots,
    };
  };
  const nextService = normalizeService(ast.service);
  let servicesChanged = false;
  const nextServices = ast.services?.map((svc) => {
    const next = svc === ast.service ? nextService : normalizeService(svc);
    if (next !== svc) servicesChanged = true;
    return next;
  });
  if (nextService === ast.service && !servicesChanged) return ast;
  return {
    ...ast,
    service: nextService,
    ...(nextServices !== undefined ? { services: nextServices } : {}),
  };
}

function groupBindings(
  block: MatchBlock,
  collectionId: string,
  underRecursiveRoot: boolean,
): Set<string> | null {
  const [first, second, third, ...rest] = block.path.segments;
  if (first?.type === 'recursive') {
    if (!second) return new Set([first.name]);
    if (
      second.type === 'literal'
      && second.value === collectionId
      && third?.type === 'wildcard'
      && rest.length === 0
    ) {
      return new Set([first.name, third.name]);
    }
    return null;
  }
  if (
    underRecursiveRoot
    && first?.type === 'literal'
    && first.value === collectionId
    && second?.type === 'wildcard'
    && third === undefined
  ) {
    return new Set([second.name]);
  }
  return null;
}

function projectInvariantAllows(
  allows: readonly AllowRule[],
  bound: ReadonlySet<string>,
  scopeFunctions: ReadonlyMap<string, FunctionDef>,
  ambiguousNames: ReadonlySet<string>,
  requiredFunctions: Set<string>,
): AllowRule[] {
  const retained: AllowRule[] = [];
  for (const rule of allows) {
    const hasListOrRead = rule.operations.some((op) => op === 'list' || op === 'read');
    if (!hasListOrRead) continue;
    const analysis = analyzeListRulePathInvariance(
      rule.condition,
      bound,
      scopeFunctions,
      ambiguousNames,
    );
    if (analysis.pathInvariant) {
      for (const fnName of analysis.requiredFunctions) requiredFunctions.add(fnName);
      retained.push(rule);
    }
  }
  return retained;
}

function projectGroupBlock(
  block: MatchBlock,
  collectionId: string,
  underRecursiveRoot: boolean,
  extraBound: ReadonlySet<string>,
  outerFunctions: readonly FunctionDef[],
  requiredFunctions: Set<string>,
): MatchBlock | null {
  const localBound = groupBindings(block, collectionId, underRecursiveRoot);
  if (!localBound) return null;
  const bound = new Set([...extraBound, ...localBound]);
  const scope = buildListRuleFunctionScope([...outerFunctions, ...block.functions]);
  const allows = projectInvariantAllows(
    block.allows,
    bound,
    scope.functions,
    scope.ambiguousNames,
    requiredFunctions,
  );
  if (allows.length === 0) return null;
  return {
    ...block,
    functions: block.functions.filter((fn) => requiredFunctions.has(fn.name)),
    allows,
    children: [],
  };
}

export function projectCollectionGroupAst(
  ast: FirestoreRules,
  collectionId: string,
): FirestoreRules | null {
  indexRulesetScopes(ast);
  if (!rootGovernsEveryDocument(ast)) return null;

  const globalRequiredFunctions = new Set<string>();
  const projectedRoots: MatchBlock[] = [];

  for (const rootBlock of topLevelMatches(ast.service)) {
    if (!rootBlockGovernsEveryDocument(rootBlock, ast.version)) continue;
    const rootMatch = resolveRootBlockMatch(rootBlock, ast.version, '');
    if (!rootMatch) continue;

    const outerFunctions = [
      ...(ast.functions ?? []),
      ...(ast.service.functions ?? []),
      ...rootBlock.functions,
    ];
    const blockRequiredFunctions = new Set<string>();
    const underRecursiveRoot = rootMatch.recursiveTail !== undefined;
    const extraBound = new Set<string>(rootMatch.recursiveVariables ?? []);
    if (rootMatch.recursiveTail !== undefined) {
      extraBound.add(rootMatch.recursiveTail.name);
    }

    let rootAllows: AllowRule[] = [];
    if (underRecursiveRoot && rootBlock.allows.length > 0) {
      const rootScope = buildListRuleFunctionScope(outerFunctions);
      rootAllows = projectInvariantAllows(
        rootBlock.allows,
        extraBound,
        rootScope.functions,
        rootScope.ambiguousNames,
        blockRequiredFunctions,
      );
    }

    const children: MatchBlock[] = [];
    for (const child of rootBlock.children) {
      const projected = projectGroupBlock(
        child,
        collectionId,
        underRecursiveRoot,
        extraBound,
        outerFunctions,
        blockRequiredFunctions,
      );
      if (projected) children.push(projected);
    }

    if (rootAllows.length === 0 && children.length === 0) continue;
    for (const fnName of blockRequiredFunctions) {
      globalRequiredFunctions.add(fnName);
    }
    projectedRoots.push({
      ...rootBlock,
      functions: rootBlock.functions.filter((fn) => blockRequiredFunctions.has(fn.name)),
      allows: rootAllows,
      children,
    });
  }

  if (projectedRoots.length === 0) return null;
  const retainGlobal = (fns: readonly FunctionDef[] | undefined): FunctionDef[] | undefined => {
    if (!fns) return undefined;
    return fns.filter((fn) => globalRequiredFunctions.has(fn.name));
  };
  return {
    ...ast,
    functions: retainGlobal(ast.functions),
    service: {
      ...ast.service,
      functions: retainGlobal(ast.service.functions),
      match: projectedRoots[0]!,
      matches: projectedRoots,
    },
  };
}

function memberStep(expr: Expression): { object: Expression; property: string } | null {
  if (expr.type === 'memberAccess') {
    return { object: expr.object, property: expr.property };
  }
  if (
    expr.type === 'bracketAccess'
    && expr.index.type === 'literal'
    && typeof expr.index.value === 'string'
  ) {
    return { object: expr.object, property: expr.index.value };
  }
  return null;
}

function isRequestChain(expr: Expression, prop: string): boolean {
  const step = memberStep(expr);
  if (!step || step.property !== prop) return false;
  return step.object.type === 'identifier' && step.object.name === 'request';
}

function isRequestAuthUid(expr: Expression): boolean {
  const step = memberStep(expr);
  if (!step || step.property !== 'uid') return false;
  return isRequestChain(step.object, 'auth');
}

function isRequestAuthToken(expr: Expression): boolean {
  const step = memberStep(expr);
  if (!step || step.property !== 'token') return false;
  return isRequestChain(step.object, 'auth');
}

function isRequestAuthTokenClaim(expr: Expression, claim: string): boolean {
  const step = memberStep(expr);
  if (!step || step.property !== claim) return false;
  return isRequestAuthToken(step.object);
}

function isResourceDataField(expr: Expression, field: string): boolean {
  const step = memberStep(expr);
  if (!step || step.property !== field) return false;
  const dataStep = memberStep(step.object);
  if (!dataStep || dataStep.property !== 'data') return false;
  return dataStep.object.type === 'identifier' && dataStep.object.name === 'resource';
}

function isAnyResourceDataAccess(expr: Expression): boolean {
  let cur: Expression | null = expr;
  while (cur !== null) {
    const step = memberStep(cur);
    if (!step) return false;
    if (
      step.property === 'data'
      && step.object.type === 'identifier'
      && step.object.name === 'resource'
    ) {
      return true;
    }
    cur = step.object;
  }
  return false;
}

function seededTokenPlaceholder(claim: string): ScalarValue {
  if (claim === 'email') return 'synth@example.test';
  if (claim === 'email_verified') return true;
  if (claim === 'name') return '__pyric_display_name__';
  if (claim === 'phone_number') return '+15555550100';
  if (claim === 'picture') return 'https://example.test/avatar.png';
  return `__pyric_claim_${claim}__`;
}

function isSeededTokenDischargedByParent(
  node: Expression,
  parent: Expression | null,
  claim: string,
): boolean {
  const placeholder = seededTokenPlaceholder(claim);
  if (parent?.type === 'binaryOp') {
    const other = parent.left === node ? parent.right : parent.right === node ? parent.left : null;
    if (!other) return false;
    if (parent.op === '==') {
      if (isAnyResourceDataAccess(other)) return true;
      const lit = asScalarLiteral(other);
      return lit.ok && Object.is(lit.value, placeholder);
    }
    if (parent.op === '!=') {
      return other.type === 'literal' && other.value === null;
    }
    return false;
  }
  if (
    parent?.type === 'inExpr'
    && parent.element === node
    && parent.collection.type === 'listLiteral'
  ) {
    return parent.collection.elements.some((el) => {
      const lit = asScalarLiteral(el);
      return lit.ok && Object.is(lit.value, placeholder);
    });
  }
  return false;
}

function isAuthUidDischargedByParent(
  node: Expression,
  parent: Expression | null,
  grandparent: Expression | null,
  matchWildcardNames: ReadonlySet<string>,
): boolean {
  if (parent?.type === 'binaryOp') {
    const other = parent.left === node ? parent.right : parent.right === node ? parent.left : null;
    if (!other) return false;
    if (parent.op === '==') {
      if (isAnyResourceDataAccess(other)) return true;
      if (other.type === 'identifier' && matchWildcardNames.has(other.name)) return true;
      const lit = asScalarLiteral(other);
      return lit.ok && Object.is(lit.value, SYNTH_UID);
    }
    if (parent.op === '!=') {
      return other.type === 'literal' && other.value === null;
    }
    return false;
  }
  if (parent?.type === 'inExpr' && parent.element === node) {
    if (isAnyResourceDataAccess(parent.collection)) return true;
    if (parent.collection.type === 'listLiteral') {
      return parent.collection.elements.some((el) => {
        const lit = asScalarLiteral(el);
        return lit.ok && Object.is(lit.value, SYNTH_UID);
      });
    }
    return false;
  }
  if (
    parent?.type === 'listLiteral'
    && grandparent?.type === 'methodCall'
    && (grandparent.method === 'hasAny' || grandparent.method === 'hasAll')
    && isAnyResourceDataAccess(grandparent.object)
  ) {
    return true;
  }
  return false;
}

function walkRuleExpression(
  expr: Expression,
  fnMap: ReadonlyMap<string, FunctionDef>,
  visited: ReadonlySet<string>,
  onNode: (node: Expression, parent: Expression | null, grandparent: Expression | null) => void,
  parent: Expression | null = null,
  grandparent: Expression | null = null,
): void {
  onNode(expr, parent, grandparent);
  switch (expr.type) {
    case 'memberAccess':
      walkRuleExpression(expr.object, fnMap, visited, onNode, expr, parent);
      return;
    case 'bracketAccess':
      walkRuleExpression(expr.object, fnMap, visited, onNode, expr, parent);
      walkRuleExpression(expr.index, fnMap, visited, onNode, expr, parent);
      return;
    case 'sliceAccess':
      walkRuleExpression(expr.object, fnMap, visited, onNode, expr, parent);
      walkRuleExpression(expr.start, fnMap, visited, onNode, expr, parent);
      walkRuleExpression(expr.end, fnMap, visited, onNode, expr, parent);
      return;
    case 'binaryOp':
      walkRuleExpression(expr.left, fnMap, visited, onNode, expr, parent);
      walkRuleExpression(expr.right, fnMap, visited, onNode, expr, parent);
      return;
    case 'unaryOp':
      walkRuleExpression(expr.operand, fnMap, visited, onNode, expr, parent);
      return;
    case 'ternary':
      walkRuleExpression(expr.condition, fnMap, visited, onNode, expr, parent);
      walkRuleExpression(expr.consequent, fnMap, visited, onNode, expr, parent);
      walkRuleExpression(expr.alternate, fnMap, visited, onNode, expr, parent);
      return;
    case 'inExpr':
      walkRuleExpression(expr.element, fnMap, visited, onNode, expr, parent);
      walkRuleExpression(expr.collection, fnMap, visited, onNode, expr, parent);
      return;
    case 'isExpr':
      walkRuleExpression(expr.value, fnMap, visited, onNode, expr, parent);
      return;
    case 'listLiteral':
      for (const el of expr.elements) walkRuleExpression(el, fnMap, visited, onNode, expr, parent);
      return;
    case 'mapLiteral':
      for (const entry of expr.entries) {
        walkRuleExpression(entry.key, fnMap, visited, onNode, expr, parent);
        walkRuleExpression(entry.value, fnMap, visited, onNode, expr, parent);
      }
      return;
    case 'pathLiteral':
      for (const seg of expr.segments) {
        if (typeof seg !== 'string') walkRuleExpression(seg, fnMap, visited, onNode, expr, parent);
      }
      return;
    case 'methodCall':
      walkRuleExpression(expr.object, fnMap, visited, onNode, expr, parent);
      for (const arg of expr.args) walkRuleExpression(arg, fnMap, visited, onNode, expr, parent);
      return;
    case 'functionCall': {
      for (const arg of expr.args) walkRuleExpression(arg, fnMap, visited, onNode, expr, parent);
      const fn = fnMap.get(expr.name);
      if (!fn || visited.has(expr.name)) return;
      const nextVisited = new Set(visited).add(expr.name);
      const bindings = new Map<string, Expression>();
      for (let i = 0; i < fn.parameters.length; i++) {
        const arg = expr.args[i];
        if (arg) bindings.set(fn.parameters[i]!, arg);
      }
      for (const b of fn.lets) {
        const bound = substituteIdentifiers(b.value, bindings);
        walkRuleExpression(bound, fnMap, nextVisited, onNode, null, null);
        bindings.set(b.name, bound);
      }
      walkRuleExpression(
        substituteIdentifiers(fn.body, bindings),
        fnMap,
        nextVisited,
        onNode,
        null,
        null,
      );
      return;
    }
    default:
      return;
  }
}

const LOOKUP_BUILTINS = new Set(['exists', 'get', 'existsAfter', 'getAfter']);

export function inspectRetainedRules(
  evaluationAst: FirestoreRules,
  placeholderPath: string,
  populatedClaims: ReadonlySet<string>,
): RetainedRulesInspection {
  indexRulesetScopes(evaluationAst);
  const rootFunctions = [
    ...(evaluationAst.functions ?? []),
    ...(evaluationAst.service.functions ?? []),
  ];
  const matches = collectRootMatches(evaluationAst, placeholderPath, rootFunctions);
  let usesUnseededContext = false;
  let usesRequestQuery = false;
  let primaryRule: { readonly line?: number; readonly expression: string } | undefined;

  for (const match of matches) {
    const scope = buildListRuleFunctionScope(match.functions);
    const matchWildcardNames = new Set(Object.getOwnPropertyNames(match.pathVariables));
    for (const rule of match.block.allows) {
      if (!rule.operations.some((op) => op === 'list' || op === 'read')) continue;
      if (!primaryRule) {
        const info: { line?: number; expression: string } = {
          expression: assembleExpression(rule.condition),
        };
        if (rule.loc?.line !== undefined) info.line = rule.loc.line;
        primaryRule = info;
      }
      walkRuleExpression(
        rule.condition,
        scope.functions,
        new Set(),
        (node, parent, grandparent) => {
          if (
            node.type === 'functionCall'
            && !scope.functions.has(node.name)
            && LOOKUP_BUILTINS.has(node.name)
          ) {
            usesUnseededContext = true;
          }
          if (isRequestChain(node, 'query')) {
            usesRequestQuery = true;
          }
          if (
            isRequestAuthUid(node)
            && !isAuthUidDischargedByParent(node, parent, grandparent, matchWildcardNames)
          ) {
            usesUnseededContext = true;
          }
          const tokenStep = memberStep(node);
          if (tokenStep && isRequestAuthToken(tokenStep.object)) {
            if (
              !populatedClaims.has(tokenStep.property)
              || !isSeededTokenDischargedByParent(node, parent, tokenStep.property)
            ) {
              usesUnseededContext = true;
            }
          } else if (node.type === 'bracketAccess' && isRequestAuthToken(node.object)) {
            usesUnseededContext = true;
          } else if (node.type === 'methodCall' && isRequestAuthToken(node.object)) {
            usesUnseededContext = true;
          } else if (node.type === 'inExpr' && isRequestAuthToken(node.collection)) {
            if (
              node.element.type !== 'literal'
              || typeof node.element.value !== 'string'
              || !populatedClaims.has(node.element.value)
            ) {
              usesUnseededContext = true;
            }
          }
        },
      );
    }
  }

  const out: {
    usesUnseededContext: boolean;
    usesRequestQuery: boolean;
    primaryRule?: { readonly line?: number; readonly expression: string };
  } = { usesUnseededContext, usesRequestQuery };
  if (primaryRule) out.primaryRule = primaryRule;
  return out;
}

function asScalarLiteral(expr: Expression): { ok: true; value: ScalarValue } | { ok: false } {
  if (expr.type !== 'literal') return { ok: false };
  const val = expr.value;
  if (val === null || typeof val === 'string' || typeof val === 'boolean') {
    return { ok: true, value: val };
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    return { ok: true, value: val };
  }
  return { ok: false };
}

export function collectClaimCandidateScalars(
  evaluationAst: FirestoreRules,
  placeholderPath: string,
  claim: string,
): ScalarValue[] {
  indexRulesetScopes(evaluationAst);
  const rootFunctions = [
    ...(evaluationAst.functions ?? []),
    ...(evaluationAst.service.functions ?? []),
  ];
  const matches = collectRootMatches(evaluationAst, placeholderPath, rootFunctions);
  const out: ScalarValue[] = [];
  const addScalar = (value: ScalarValue): void => {
    if (!out.some((existing) => Object.is(existing, value))) {
      out.push(value);
    }
  };

  for (const match of matches) {
    const scope = buildListRuleFunctionScope(match.functions);
    for (const rule of match.block.allows) {
      if (!rule.operations.some((op) => op === 'list' || op === 'read')) continue;
      walkRuleExpression(rule.condition, scope.functions, new Set(), (node) => {
        if (node.type === 'binaryOp' && node.op === '==') {
          if (isRequestAuthTokenClaim(node.left, claim)) {
            const lit = asScalarLiteral(node.right);
            if (lit.ok) addScalar(lit.value);
          } else if (isRequestAuthTokenClaim(node.right, claim)) {
            const lit = asScalarLiteral(node.left);
            if (lit.ok) addScalar(lit.value);
          }
        } else if (
          node.type === 'inExpr'
          && isRequestAuthTokenClaim(node.element, claim)
          && node.collection.type === 'listLiteral'
        ) {
          for (const item of node.collection.elements) {
            const lit = asScalarLiteral(item);
            if (lit.ok) addScalar(lit.value);
          }
        }
      });
    }
  }
  return out;
}

export function collectOptimisticFieldScalars(
  evaluationAst: FirestoreRules,
  placeholderPath: string,
  field: string,
): ScalarValue[] {
  indexRulesetScopes(evaluationAst);
  const rootFunctions = [
    ...(evaluationAst.functions ?? []),
    ...(evaluationAst.service.functions ?? []),
  ];
  const matches = collectRootMatches(evaluationAst, placeholderPath, rootFunctions);
  const out: ScalarValue[] = [];
  const addScalar = (value: ScalarValue): void => {
    if (!out.some((existing) => Object.is(existing, value))) {
      out.push(value);
    }
  };

  for (const match of matches) {
    const scope = buildListRuleFunctionScope(match.functions);
    for (const rule of match.block.allows) {
      if (!rule.operations.some((op) => op === 'list' || op === 'read')) continue;
      walkRuleExpression(rule.condition, scope.functions, new Set(), (node) => {
        if (node.type === 'binaryOp' && node.op === '==') {
          if (isResourceDataField(node.left, field)) {
            const lit = asScalarLiteral(node.right);
            if (lit.ok) addScalar(lit.value);
          } else if (isResourceDataField(node.right, field)) {
            const lit = asScalarLiteral(node.left);
            if (lit.ok) addScalar(lit.value);
          }
        } else if (
          node.type === 'inExpr'
          && isResourceDataField(node.element, field)
          && node.collection.type === 'listLiteral'
        ) {
          for (const item of node.collection.elements) {
            const lit = asScalarLiteral(item);
            if (lit.ok) addScalar(lit.value);
          }
        }
      });
    }
  }

  addScalar(SYNTH_UID);
  addScalar(`__pyric_optimistic_${field}__`);
  return out;
}
