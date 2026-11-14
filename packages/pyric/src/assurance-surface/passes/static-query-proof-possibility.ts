/**
 * Four-valued (`canBeTrue` / `canBeFalse` / `canError`) static possibility
 * analysis for retained list rules that combine unseeded runtime context
 * (`request.auth.token`, `get`/`exists`, `request.time`) with concrete
 * `request.query` or `resource.data` clauses.
 */
import {
  buildListRuleFunctionScope,
  collectRootMatches,
  indexRulesetScopes,
  inlineFunctionsInExpr,
  topLevelMatches,
  type AllowRule,
  type Expression,
  type FirestoreRules,
  type FunctionDef,
  type MatchBlock,
  type QueryConstraints,
  type SimulateFirestoreRulesHandler,
} from '@pyric/rules/internal';
import type { ResidualSimulatorFn } from './static-query-proof-actors.js';
import { SYNTH_UID, type ProjectedQueryArm } from './static-query-proof-args.js';
import {
  isAnyResourceDataAccess,
  isRequestChain,
  nodeTouchesUnseededContext,
  walkRuleExpression,
} from './static-query-proof-inspection.js';

interface TruthPossibility {
  readonly canBeTrue: boolean;
  readonly canBeFalse: boolean;
  readonly canError: boolean;
}

const UNKNOWN_POSSIBILITY: TruthPossibility = {
  canBeTrue: true,
  canBeFalse: true,
  canError: true,
};

const IMPOSSIBLE: TruthPossibility = {
  canBeTrue: false,
  canBeFalse: false,
  canError: false,
};

function isNullAuthCheck(node: Expression, parent: Expression | null): boolean {
  if (!isRequestChain(node, 'auth')) return false;
  if (parent?.type !== 'binaryOp' || parent.op !== '==') return false;
  let other: Expression | null = null;
  if (parent.left === node) other = parent.right;
  else if (parent.right === node) other = parent.left;
  return other?.type === 'literal' && other.value === null;
}

function isUnseededDynamicPathWildcard(
  node: Expression,
  parent: Expression | null,
  pathVariables: Readonly<Record<string, string>>,
): boolean {
  if (node.type !== 'identifier' || !Object.hasOwn(pathVariables, node.name)) return false;
  const bound = pathVariables[node.name];
  if (bound === undefined || !bound.startsWith('__pyric_') || bound === SYNTH_UID) {
    return false;
  }
  if (parent?.type === 'binaryOp' && parent.op === '==') {
    let other: Expression | null = null;
    if (parent.left === node) other = parent.right;
    else if (parent.right === node) other = parent.left;
    if (other && isAnyResourceDataAccess(other)) return false;
  }
  return true;
}

function subtreeTouchesUnseededContext(
  expr: Expression,
  scopeFunctions: ReadonlyMap<string, FunctionDef>,
  pathVariables: Readonly<Record<string, string>>,
  matchWildcardNames: ReadonlySet<string>,
  populatedClaims: ReadonlySet<string>,
): boolean {
  let touches = false;
  walkRuleExpression(expr, new Map(), new Set(), (node, parent, grandparent) => {
    if (touches) return;
    if (node.type === 'functionCall' && scopeFunctions.has(node.name)) {
      touches = true;
      return;
    }
    if (isNullAuthCheck(node, parent)) {
      touches = true;
      return;
    }
    if (isUnseededDynamicPathWildcard(node, parent, pathVariables)) {
      touches = true;
      return;
    }
    if (
      nodeTouchesUnseededContext(
        node,
        parent,
        grandparent,
        scopeFunctions,
        matchWildcardNames,
        populatedClaims,
      )
    ) {
      touches = true;
    }
  });
  return touches;
}

function buildSingleConditionAst(
  baseAst: FirestoreRules,
  targetBlock: MatchBlock,
  probeRule: AllowRule,
): FirestoreRules {
  const rewriteBlock = (block: MatchBlock): MatchBlock => {
    const children = block.children.map(rewriteBlock);
    let allows: AllowRule[] = [];
    if (block === targetBlock) allows = [probeRule];
    return {
      ...block,
      allows,
      children,
    };
  };
  const nextRoots = topLevelMatches(baseAst.service).map(rewriteBlock);
  return {
    ...baseAst,
    service: {
      ...baseAst.service,
      match: nextRoots[0]!,
      matches: nextRoots,
    },
  };
}

function combineAnd(left: TruthPossibility, right: TruthPossibility): TruthPossibility {
  const leftAny = left.canBeTrue || left.canBeFalse || left.canError;
  const rightAny = right.canBeTrue || right.canBeFalse || right.canError;
  return {
    canBeTrue: left.canBeTrue && right.canBeTrue,
    canBeFalse: (left.canBeFalse && rightAny) || (right.canBeFalse && leftAny),
    canError:
      (left.canError && (right.canBeTrue || right.canError))
      || (right.canError && (left.canBeTrue || left.canError)),
  };
}

function combineOr(left: TruthPossibility, right: TruthPossibility): TruthPossibility {
  const leftAny = left.canBeTrue || left.canBeFalse || left.canError;
  const rightAny = right.canBeTrue || right.canBeFalse || right.canError;
  return {
    canBeTrue: (left.canBeTrue && rightAny) || (right.canBeTrue && leftAny),
    canBeFalse: left.canBeFalse && right.canBeFalse,
    canError:
      (left.canError && (right.canBeFalse || right.canError))
      || (right.canError && (left.canBeFalse || left.canError)),
  };
}

export function canRetainedRulesPossiblyAllow(
  simulateDecision: ResidualSimulatorFn,
  simulator: SimulateFirestoreRulesHandler,
  evaluationAst: FirestoreRules,
  rulesSource: string,
  placeholderPath: string,
  projected: ProjectedQueryArm,
  syntheticResource: Record<string, unknown>,
  constraints: QueryConstraints,
  populatedClaims: ReadonlySet<string>,
): boolean {
  indexRulesetScopes(evaluationAst);
  const rootFunctions = [];
  if (evaluationAst.functions) rootFunctions.push(...evaluationAst.functions);
  if (evaluationAst.service.functions) rootFunctions.push(...evaluationAst.service.functions);
  const matches = collectRootMatches(evaluationAst, placeholderPath, rootFunctions);

  for (const match of matches) {
    const scope = buildListRuleFunctionScope(match.functions);
    const matchWildcardNames = new Set(Object.getOwnPropertyNames(match.pathVariables));

    const evalConcreteBooleanSubtree = (sub: Expression): TruthPossibility => {
      const trueRule: AllowRule = {
        operations: ['list'],
        condition: {
          type: 'binaryOp',
          op: '==',
          left: sub,
          right: { type: 'literal', value: true, raw: 'true' },
        },
      };
      const trueAst = buildSingleConditionAst(evaluationAst, match.block, trueRule);
      if (
        simulateDecision(
          simulator,
          trueAst,
          rulesSource,
          placeholderPath,
          projected.auth,
          syntheticResource,
          constraints,
        ).allowed
      ) {
        return { canBeTrue: true, canBeFalse: false, canError: false };
      }

      const falseRule: AllowRule = {
        operations: ['list'],
        condition: {
          type: 'binaryOp',
          op: '==',
          left: sub,
          right: { type: 'literal', value: false, raw: 'false' },
        },
      };
      const falseAst = buildSingleConditionAst(evaluationAst, match.block, falseRule);
      if (
        simulateDecision(
          simulator,
          falseAst,
          rulesSource,
          placeholderPath,
          projected.auth,
          syntheticResource,
          constraints,
        ).allowed
      ) {
        return { canBeTrue: false, canBeFalse: true, canError: false };
      }

      return { canBeTrue: false, canBeFalse: false, canError: true };
    };

    const evalPossibility = (sub: Expression): TruthPossibility => {
      if (
        !subtreeTouchesUnseededContext(
          sub,
          scope.functions,
          match.pathVariables,
          matchWildcardNames,
          populatedClaims,
        )
      ) {
        return evalConcreteBooleanSubtree(sub);
      }

      if (sub.type === 'unaryOp' && sub.op === '!') {
        const inner = evalPossibility(sub.operand);
        return {
          canBeTrue: inner.canBeFalse,
          canBeFalse: inner.canBeTrue,
          canError: inner.canError,
        };
      }
      if (sub.type === 'binaryOp' && sub.op === '&&') {
        return combineAnd(evalPossibility(sub.left), evalPossibility(sub.right));
      }
      if (sub.type === 'binaryOp' && sub.op === '||') {
        return combineOr(evalPossibility(sub.left), evalPossibility(sub.right));
      }
      if (sub.type === 'ternary') {
        const cond = evalPossibility(sub.condition);
        let cons = IMPOSSIBLE;
        if (cond.canBeTrue) cons = evalPossibility(sub.consequent);
        let alt = IMPOSSIBLE;
        if (cond.canBeFalse) alt = evalPossibility(sub.alternate);
        return {
          canBeTrue: cons.canBeTrue || alt.canBeTrue,
          canBeFalse: cons.canBeFalse || alt.canBeFalse,
          canError: cond.canError || cons.canError || alt.canError,
        };
      }
      return UNKNOWN_POSSIBILITY;
    };

    for (const rule of match.block.allows) {
      if (!rule.operations.some((op) => op === 'list' || op === 'read')) continue;
      const inlined = inlineFunctionsInExpr(
        rule.condition,
        scope.functions,
        new Set(),
        match.functionScopes,
      );
      if (inlined === null) return true;
      if (evalPossibility(inlined).canBeTrue) return true;
    }
  }

  return false;
}
