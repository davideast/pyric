/**
 * Candidate scalar extraction from Firestore Rules ASTs for unified actor/claim
 * proof search and optimistic parameter completion in {@link staticQueryProofPass}.
 */
import {
  buildListRuleFunctionScope,
  Bytes,
  collectRootMatches,
  Duration,
  evaluateQueryProof,
  indexRulesetScopes,
  isQueryProofScalar,
  LatLng,
  queryProofScalarsEqual,
  Reference,
  Timestamp,
  type Expression,
  type FirestoreRules,
  type FunctionDef,
  type RulesScalar,
} from '@pyric/rules/internal';
import { SYNTH_UID, type ScalarValue } from './static-query-proof-args.js';
import {
  asScalarLiteral,
  isAnyResourceDataAccess,
  isRequestAuthTokenClaim,
  isResourceDataField,
  LOOKUP_BUILTINS,
  walkRuleExpression,
} from './static-query-proof-inspection.js';

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

function tryEvaluateOptimisticOperand(
  expr: Expression,
  scopeFunctions: ReadonlyMap<string, FunctionDef>,
  pathVariables: Readonly<Record<string, string>>,
  functionScopes: Parameters<typeof evaluateQueryProof>[5],
): RulesScalar | undefined {
  let readsLookupOrDoc = false;
  walkRuleExpression(expr, scopeFunctions, new Set(), (node) => {
    if (isAnyResourceDataAccess(node)) {
      readsLookupOrDoc = true;
    } else if (
      node.type === 'functionCall'
      && !scopeFunctions.has(node.name)
      && LOOKUP_BUILTINS.has(node.name)
    ) {
      readsLookupOrDoc = true;
    }
  });
  if (readsLookupOrDoc) return undefined;
  const probeCondition: Expression = {
    type: 'binaryOp',
    op: '==',
    left: {
      type: 'memberAccess',
      object: {
        type: 'memberAccess',
        object: { type: 'identifier', name: 'resource' },
        property: 'data',
      },
      property: '__pyric_optimistic_probe__',
    },
    right: expr,
  };
  const proof = evaluateQueryProof(
    probeCondition,
    {},
    scopeFunctions,
    SYNTH_UID,
    pathVariables,
    functionScopes,
  );
  if (!proof.provable && proof.kind === 'constraints-not-satisfied') {
    const expected = proof.residual.missing[0]?.expectedValue;
    if (isQueryProofScalar(expected)) return expected;
  }
  return undefined;
}

export function collectOptimisticFieldScalars(
  evaluationAst: FirestoreRules,
  placeholderPath: string,
  field: string,
  targetDatabaseId = '(default)',
): RulesScalar[] {
  indexRulesetScopes(evaluationAst);
  const rootFunctions = [
    ...(evaluationAst.functions ?? []),
    ...(evaluationAst.service.functions ?? []),
  ];
  const matches = collectRootMatches(evaluationAst, placeholderPath, rootFunctions);
  const out: RulesScalar[] = [];
  let fieldReferencedInRule = false;
  const addScalar = (value: RulesScalar): void => {
    if (!out.some((existing) => queryProofScalarsEqual(existing, value))) {
      out.push(value);
    }
  };

  for (const match of matches) {
    const scope = buildListRuleFunctionScope(match.functions);
    const addEvaluated = (candidateExpr: Expression): void => {
      const lit = asScalarLiteral(candidateExpr);
      if (lit.ok) {
        addScalar(lit.value);
        return;
      }
      const evaluated = tryEvaluateOptimisticOperand(
        candidateExpr,
        scope.functions,
        match.pathVariables,
        match.functionScopes,
      );
      if (evaluated !== undefined) addScalar(evaluated);
    };

    for (const rule of match.block.allows) {
      if (!rule.operations.some((op) => op === 'list' || op === 'read')) continue;
      walkRuleExpression(rule.condition, scope.functions, new Set(), (node) => {
        if (isResourceDataField(node, field)) {
          fieldReferencedInRule = true;
        }
        if (node.type === 'binaryOp' && node.op === '==') {
          if (isResourceDataField(node.left, field)) {
            addEvaluated(node.right);
          } else if (isResourceDataField(node.right, field)) {
            addEvaluated(node.left);
          }
        } else if (
          node.type === 'inExpr'
          && isResourceDataField(node.element, field)
          && node.collection.type === 'listLiteral'
        ) {
          for (const item of node.collection.elements) {
            addEvaluated(item);
          }
        } else if (
          node.type === 'inExpr'
          && isResourceDataField(node.collection, field)
        ) {
          addEvaluated(node.element);
        } else if (
          node.type === 'methodCall'
          && (node.method === 'hasAny' || node.method === 'hasAll')
          && isResourceDataField(node.object, field)
          && node.args[0]?.type === 'listLiteral'
        ) {
          for (const item of node.args[0].elements) {
            addEvaluated(item);
          }
        }
      });
    }
  }

  addScalar(SYNTH_UID);
  addScalar(`__pyric_optimistic_${field}__`);
  if (fieldReferencedInRule) {
    addScalar(new Reference('__pyric_ref_col__/__pyric_ref_id__', targetDatabaseId));
    addScalar(Timestamp.fromMillis(1_700_000_000_000));
    addScalar(new Bytes(new Uint8Array([1])));
    addScalar(new LatLng(0, 0));
    addScalar(new Duration(60, 0));
  }
  return out;
}
