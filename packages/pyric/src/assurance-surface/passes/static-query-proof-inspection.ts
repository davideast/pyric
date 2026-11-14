/**
 * Retained-rule AST inspection for {@link staticQueryProofPass}: detects
 * unseeded lookup/auth dependencies and `request.query` usage after inlining
 * helper functions so parent/grandparent discharge context is preserved.
 */
import {
  assembleExpression,
  buildListRuleFunctionScope,
  collectRootMatches,
  getListBlockSteps,
  getOrBudgetStepExpressions,
  getOrBudgetSteps,
  indexRulesetScopes,
  inlineFunctionsInExpr,
  substituteIdentifiers,
  type Expression,
  type FirestoreRules,
  type FunctionDef,
} from '@pyric/rules/internal';
import { fieldPathKeySegments } from '../../firestore/internal/update-fields.js';
import { SYNTH_UID, type ScalarValue } from './static-query-proof-args.js';

export interface RetainedRulesInspection {
  readonly usesUnseededContext: boolean;
  readonly usesRequestQuery: boolean;
  readonly primaryRule?: { readonly line?: number; readonly expression: string };
}

export const LOOKUP_BUILTINS = new Set(['exists', 'get', 'existsAfter', 'getAfter']);

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

export function isRequestAuthTokenClaim(expr: Expression, claim: string): boolean {
  const step = memberStep(expr);
  if (!step || step.property !== claim) return false;
  return isRequestAuthToken(step.object);
}

export function isResourceDataField(expr: Expression, field: string): boolean {
  const parts = fieldPathKeySegments(field).filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  let cur: Expression = expr;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const step = memberStep(cur);
    if (!step || step.property !== parts[i]) return false;
    cur = step.object;
  }
  const dataStep = memberStep(cur);
  if (!dataStep || dataStep.property !== 'data') return false;
  return dataStep.object.type === 'identifier' && dataStep.object.name === 'resource';
}

export function isAnyResourceDataAccess(expr: Expression): boolean {
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

export function asScalarLiteral(
  expr: Expression,
): { ok: true; value: ScalarValue } | { ok: false } {
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
    let other: Expression | null = null;
    if (parent.left === node) {
      other = parent.right;
    } else if (parent.right === node) {
      other = parent.left;
    }
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
    let other: Expression | null = null;
    if (parent.left === node) {
      other = parent.right;
    } else if (parent.right === node) {
      other = parent.left;
    }
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

export function walkRuleExpression(
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

export function nodeTouchesUnseededContext(
  node: Expression,
  parent: Expression | null,
  grandparent: Expression | null,
  scopeFunctions: ReadonlyMap<string, FunctionDef>,
  matchWildcardNames: ReadonlySet<string>,
  populatedClaims: ReadonlySet<string>,
): boolean {
  if (
    node.type === 'functionCall'
    && !scopeFunctions.has(node.name)
    && LOOKUP_BUILTINS.has(node.name)
  ) {
    return true;
  }
  if (isRequestChain(node, 'time')) {
    return true;
  }
  if (
    isRequestAuthUid(node)
    && !isAuthUidDischargedByParent(node, parent, grandparent, matchWildcardNames)
  ) {
    return true;
  }
  const tokenStep = memberStep(node);
  if (tokenStep && isRequestAuthToken(tokenStep.object)) {
    if (
      !populatedClaims.has(tokenStep.property)
      || !isSeededTokenDischargedByParent(node, parent, tokenStep.property)
    ) {
      return true;
    }
  } else if (node.type === 'bracketAccess' && isRequestAuthToken(node.object)) {
    return true;
  } else if (node.type === 'methodCall' && isRequestAuthToken(node.object)) {
    return true;
  } else if (node.type === 'inExpr' && isRequestAuthToken(node.collection)) {
    if (
      node.element.type !== 'literal'
      || typeof node.element.value !== 'string'
      || !populatedClaims.has(node.element.value)
    ) {
      return true;
    }
  }
  return false;
}

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
    const walkedBudgetExprs = new Set<Expression>();
    const inspectExpr = (expr: Expression): void => {
      if (walkedBudgetExprs.has(expr)) return;
      walkedBudgetExprs.add(expr);

      const scanOrBudgetAttachments = (targetExpr: Expression): void => {
        for (const orStep of getOrBudgetSteps(targetExpr) ?? []) {
          for (const sub of getOrBudgetStepExpressions(orStep)) {
            inspectExpr(sub);
          }
        }
      };

      const inlined = inlineFunctionsInExpr(
        expr,
        scope.functions,
        new Set(),
        match.functionScopes,
      );
      if (inlined !== null) {
        walkRuleExpression(
          inlined,
          new Map(),
          new Set(),
          (node, parent, grandparent) => {
            scanOrBudgetAttachments(node);
            if (isRequestChain(node, 'query')) {
              usesRequestQuery = true;
            }
            if (
              nodeTouchesUnseededContext(
                node,
                parent,
                grandparent,
                scope.functions,
                matchWildcardNames,
                populatedClaims,
              )
            ) {
              usesUnseededContext = true;
            }
          },
        );
        // Also scan non-inlined helpers in case an unused `let` binding invoked a lookup or read `request.query`.
        walkRuleExpression(expr, scope.functions, new Set(), (node) => {
          scanOrBudgetAttachments(node);
          if (isRequestChain(node, 'query')) {
            usesRequestQuery = true;
          }
          if (
            node.type === 'functionCall'
            && !scope.functions.has(node.name)
            && LOOKUP_BUILTINS.has(node.name)
          ) {
            usesUnseededContext = true;
          }
        });
      } else {
        walkRuleExpression(
          expr,
          scope.functions,
          new Set(),
          (node, parent, grandparent) => {
            scanOrBudgetAttachments(node);
            if (isRequestChain(node, 'query')) {
              usesRequestQuery = true;
            }
            if (
              nodeTouchesUnseededContext(
                node,
                parent,
                grandparent,
                scope.functions,
                matchWildcardNames,
                populatedClaims,
              )
            ) {
              usesUnseededContext = true;
            }
          },
        );
      }
      scanOrBudgetAttachments(expr);
    };

    for (const rule of match.block.allows) {
      if (!rule.operations.some((op) => op === 'list' || op === 'read')) continue;
      if (!primaryRule) {
        const info: { line?: number; expression: string } = {
          expression: assembleExpression(rule.condition),
        };
        if (rule.loc?.line !== undefined) info.line = rule.loc.line;
        primaryRule = info;
      }
      inspectExpr(rule.condition);
    }
    for (const blockStep of getListBlockSteps(match.block) ?? []) {
      if (blockStep.kind === 'budget') {
        inspectExpr(blockStep.rule.condition);
      }
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
