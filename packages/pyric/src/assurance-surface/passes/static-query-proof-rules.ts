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
import {
  analyzeListRulePathInvariance,
  buildListRuleFunctionScope,
} from '../../rules/simulator/list-rule-path-proof.js';
import { indexRulesetScopes } from '../../rules/simulator/match-resolution.js';
import { substituteIdentifiers } from '../../rules/simulator/query-proof-scope.js';
import { collectRootMatches, rootGovernsEveryDocument } from '../../rules/simulator/root-match.js';
import { SYNTH_UID, type ScalarValue } from './static-query-proof-args.js';

export interface RetainedRulesInspection {
  readonly usesUnseededContext: boolean;
  readonly usesRequestQuery: boolean;
  readonly primaryRule?: { readonly line?: number; readonly expression: string };
}

export function normalizeDatabaseRootAst(
  ast: FirestoreRules,
  resourceId: string,
): FirestoreRules {
  if (resourceId === '(default)') return ast;
  const segments = ast.service.match.path.segments;
  const first = segments[0];
  const second = segments[1];
  if (
    first?.type !== 'literal'
    || first.value !== 'databases'
    || second?.type !== 'literal'
    || second.value !== resourceId
  ) {
    return ast;
  }
  const normalizedSegments: PathSegment[] = [...segments];
  normalizedSegments[1] = { type: 'literal', value: '(default)' };
  return {
    ...ast,
    service: {
      ...ast.service,
      match: {
        ...ast.service.match,
        path: {
          ...ast.service.match.path,
          segments: normalizedSegments,
        },
      },
    },
  };
}

function groupBindings(block: MatchBlock, collectionId: string): Set<string> | null {
  const [first, second, third, ...rest] = block.path.segments;
  if (first?.type !== 'recursive') return null;
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

function projectGroupBlock(
  block: MatchBlock,
  collectionId: string,
  outerFunctions: readonly FunctionDef[],
  requiredFunctions: Set<string>,
): MatchBlock | null {
  const bound = groupBindings(block, collectionId);
  if (!bound) return null;
  const scope = buildListRuleFunctionScope([...outerFunctions, ...block.functions]);
  const allows: AllowRule[] = [];
  for (const rule of block.allows) {
    const hasListOrRead = rule.operations.some((op) => op === 'list' || op === 'read');
    if (!hasListOrRead) continue;
    const analysis = analyzeListRulePathInvariance(
      rule.condition,
      bound,
      scope.functions,
      scope.ambiguousNames,
    );
    if (analysis.pathInvariant) {
      for (const fnName of analysis.requiredFunctions) requiredFunctions.add(fnName);
      allows.push(rule);
    }
  }
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
  if (!rootGovernsEveryDocument(ast)) return null;
  const outerFunctions = [
    ...(ast.functions ?? []),
    ...(ast.service.functions ?? []),
    ...ast.service.match.functions,
  ];
  const requiredFunctions = new Set<string>();
  const children: MatchBlock[] = [];
  for (const child of ast.service.match.children) {
    const projected = projectGroupBlock(child, collectionId, outerFunctions, requiredFunctions);
    if (projected) children.push(projected);
  }
  if (children.length === 0) return null;
  const retain = (fns: readonly FunctionDef[] | undefined): FunctionDef[] | undefined => {
    if (!fns) return undefined;
    return fns.filter((fn) => requiredFunctions.has(fn.name));
  };
  return {
    ...ast,
    functions: retain(ast.functions),
    service: {
      ...ast.service,
      functions: retain(ast.service.functions),
      match: {
        ...ast.service.match,
        functions: retain(ast.service.match.functions) ?? [],
        children,
      },
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

function isRequestAuthToken(expr: Expression): boolean {
  const step = memberStep(expr);
  if (!step || step.property !== 'token') return false;
  return isRequestChain(step.object, 'auth');
}

function isResourceDataField(expr: Expression, field: string): boolean {
  const step = memberStep(expr);
  if (!step || step.property !== field) return false;
  const dataStep = memberStep(step.object);
  if (!dataStep || dataStep.property !== 'data') return false;
  return dataStep.object.type === 'identifier' && dataStep.object.name === 'resource';
}

function walkRuleExpression(
  expr: Expression,
  fnMap: ReadonlyMap<string, FunctionDef>,
  visited: ReadonlySet<string>,
  onNode: (node: Expression) => void,
): void {
  onNode(expr);
  switch (expr.type) {
    case 'memberAccess':
      walkRuleExpression(expr.object, fnMap, visited, onNode);
      return;
    case 'bracketAccess':
      walkRuleExpression(expr.object, fnMap, visited, onNode);
      walkRuleExpression(expr.index, fnMap, visited, onNode);
      return;
    case 'sliceAccess':
      walkRuleExpression(expr.object, fnMap, visited, onNode);
      walkRuleExpression(expr.start, fnMap, visited, onNode);
      walkRuleExpression(expr.end, fnMap, visited, onNode);
      return;
    case 'binaryOp':
      walkRuleExpression(expr.left, fnMap, visited, onNode);
      walkRuleExpression(expr.right, fnMap, visited, onNode);
      return;
    case 'unaryOp':
      walkRuleExpression(expr.operand, fnMap, visited, onNode);
      return;
    case 'ternary':
      walkRuleExpression(expr.condition, fnMap, visited, onNode);
      walkRuleExpression(expr.consequent, fnMap, visited, onNode);
      walkRuleExpression(expr.alternate, fnMap, visited, onNode);
      return;
    case 'inExpr':
      walkRuleExpression(expr.element, fnMap, visited, onNode);
      walkRuleExpression(expr.collection, fnMap, visited, onNode);
      return;
    case 'isExpr':
      walkRuleExpression(expr.value, fnMap, visited, onNode);
      return;
    case 'listLiteral':
      for (const el of expr.elements) walkRuleExpression(el, fnMap, visited, onNode);
      return;
    case 'mapLiteral':
      for (const entry of expr.entries) {
        walkRuleExpression(entry.key, fnMap, visited, onNode);
        walkRuleExpression(entry.value, fnMap, visited, onNode);
      }
      return;
    case 'pathLiteral':
      for (const seg of expr.segments) {
        if (typeof seg !== 'string') walkRuleExpression(seg, fnMap, visited, onNode);
      }
      return;
    case 'methodCall':
      walkRuleExpression(expr.object, fnMap, visited, onNode);
      for (const arg of expr.args) walkRuleExpression(arg, fnMap, visited, onNode);
      return;
    case 'functionCall': {
      for (const arg of expr.args) walkRuleExpression(arg, fnMap, visited, onNode);
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
        walkRuleExpression(bound, fnMap, nextVisited, onNode);
        bindings.set(b.name, bound);
      }
      walkRuleExpression(substituteIdentifiers(fn.body, bindings), fnMap, nextVisited, onNode);
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
    ...evaluationAst.service.match.functions,
  ];
  const matches = collectRootMatches(evaluationAst, placeholderPath, rootFunctions);
  let usesUnseededContext = false;
  let usesRequestQuery = false;
  let primaryRule: { readonly line?: number; readonly expression: string } | undefined;

  for (const match of matches) {
    const scope = buildListRuleFunctionScope(match.functions);
    for (const rule of match.block.allows) {
      if (!rule.operations.some((op) => op === 'list' || op === 'read')) continue;
      if (!primaryRule) {
        const info: { line?: number; expression: string } = {
          expression: assembleExpression(rule.condition),
        };
        if (rule.loc?.line !== undefined) info.line = rule.loc.line;
        primaryRule = info;
      }
      walkRuleExpression(rule.condition, scope.functions, new Set(), (node) => {
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
        const tokenStep = memberStep(node);
        if (tokenStep && isRequestAuthToken(tokenStep.object)) {
          if (!populatedClaims.has(tokenStep.property)) {
            usesUnseededContext = true;
          }
        } else if (node.type === 'bracketAccess' && isRequestAuthToken(node.object)) {
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
      });
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

export function collectOptimisticFieldScalars(
  evaluationAst: FirestoreRules,
  placeholderPath: string,
  field: string,
): ScalarValue[] {
  indexRulesetScopes(evaluationAst);
  const rootFunctions = [
    ...(evaluationAst.functions ?? []),
    ...(evaluationAst.service.functions ?? []),
    ...evaluationAst.service.match.functions,
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
