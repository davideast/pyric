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
import {
  buildResidualCandidateAuths,
  type ResidualSimulatorFn,
} from './static-query-proof-actors.js';
import {
  SYNTH_UID,
  type ConcretizedQueryTarget,
  type ProjectedQueryArm,
} from './static-query-proof-args.js';
import {
  isAnyResourceDataAccess,
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

const ORDERED_OPS: ReadonlySet<string> = new Set(['<', '<=', '>', '>=']);

function negatePossibility(inner: TruthPossibility): TruthPossibility {
  return {
    canBeTrue: inner.canBeFalse,
    canBeFalse: inner.canBeTrue,
    canError: inner.canError,
  };
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

function functionTouchesUnseeded(
  fnName: string,
  scopeFunctions: ReadonlyMap<string, FunctionDef>,
  pathVariables: Readonly<Record<string, string>>,
  matchWildcardNames: ReadonlySet<string>,
  populatedClaims: ReadonlySet<string>,
  visited: Set<string>,
): boolean {
  if (visited.has(fnName)) return false;
  const fnDef = scopeFunctions.get(fnName);
  if (!fnDef) return false;
  visited.add(fnName);
  return subtreeTouchesUnseededContext(
    fnDef.body,
    scopeFunctions,
    pathVariables,
    matchWildcardNames,
    populatedClaims,
    visited,
  );
}

function subtreeTouchesUnseededContext(
  expr: Expression,
  scopeFunctions: ReadonlyMap<string, FunctionDef>,
  pathVariables: Readonly<Record<string, string>>,
  matchWildcardNames: ReadonlySet<string>,
  populatedClaims: ReadonlySet<string>,
  visitedFns: Set<string> = new Set(),
): boolean {
  let touches = false;
  walkRuleExpression(expr, new Map(), new Set(), (node, parent, grandparent) => {
    if (touches) return;
    if (node.type === 'functionCall' && scopeFunctions.has(node.name)) {
      if (
        node.args.some((arg) =>
          subtreeTouchesUnseededContext(
            arg,
            scopeFunctions,
            pathVariables,
            matchWildcardNames,
            populatedClaims,
            new Set(visitedFns),
          ),
        )
        || functionTouchesUnseeded(
          node.name,
          scopeFunctions,
          pathVariables,
          matchWildcardNames,
          populatedClaims,
          new Set(visitedFns),
        )
      ) {
        touches = true;
      }
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
  target: ConcretizedQueryTarget,
  projected: ProjectedQueryArm,
  syntheticResource: Record<string, unknown>,
  constraints: QueryConstraints,
  populatedClaims: ReadonlySet<string>,
): boolean {
  indexRulesetScopes(evaluationAst);
  const rootFunctions: FunctionDef[] = [];
  if (evaluationAst.functions) rootFunctions.push(...evaluationAst.functions);
  if (evaluationAst.service.functions) rootFunctions.push(...evaluationAst.service.functions);
  const matches = collectRootMatches(evaluationAst, placeholderPath, rootFunctions);
  const candidateAuths = buildResidualCandidateAuths(target, projected);

  for (const match of matches) {
    const scope = buildListRuleFunctionScope(match.functions);
    const matchWildcardNames = new Set(Object.getOwnPropertyNames(match.pathVariables));

    for (const candidateAuth of candidateAuths) {
      const checkLiteralEquality = (
        sub: Expression,
        expected: boolean | null,
        raw: string,
      ): boolean => {
        const rule: AllowRule = {
          operations: ['list'],
          condition: {
            type: 'binaryOp',
            op: '==',
            left: sub,
            right: { type: 'literal', value: expected, raw },
          },
        };
        const singleAst = buildSingleConditionAst(evaluationAst, match.block, rule);
        return simulateDecision(
          simulator,
          singleAst,
          rulesSource,
          placeholderPath,
          candidateAuth,
          syntheticResource,
          constraints,
        ).allowed;
      };

      const evalConcreteBooleanSubtree = (sub: Expression): TruthPossibility => {
        if (checkLiteralEquality(sub, true, 'true')) {
          return { canBeTrue: true, canBeFalse: false, canError: false };
        }
        if (checkLiteralEquality(sub, false, 'false')) {
          return { canBeTrue: false, canBeFalse: true, canError: false };
        }
        return { canBeTrue: false, canBeFalse: false, canError: true };
      };

      const isConcreteNonOrderable = (sub: Expression): boolean => {
        if (
          subtreeTouchesUnseededContext(
            sub,
            scope.functions,
            match.pathVariables,
            matchWildcardNames,
            populatedClaims,
          )
        ) {
          return false;
        }
        return (
          checkLiteralEquality(sub, null, 'null')
          || checkLiteralEquality(sub, true, 'true')
          || checkLiteralEquality(sub, false, 'false')
        );
      };

      const evalPossibility = (sub: Expression, depth: number): TruthPossibility => {
        if (depth > 40) return UNKNOWN_POSSIBILITY;
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

        if (sub.type === 'functionCall' && scope.functions.has(sub.name)) {
          const inlinedCall = inlineFunctionsInExpr(
            sub,
            scope.functions,
            new Set(),
            match.functionScopes,
          );
          if (inlinedCall === null || inlinedCall === sub) {
            return UNKNOWN_POSSIBILITY;
          }
          return evalPossibility(inlinedCall, depth + 1);
        }

        if (sub.type === 'unaryOp' && sub.op === '!') {
          return negatePossibility(evalPossibility(sub.operand, depth + 1));
        }
        if (sub.type === 'binaryOp') {
          if (sub.op === '&&') {
            return combineAnd(
              evalPossibility(sub.left, depth + 1),
              evalPossibility(sub.right, depth + 1),
            );
          }
          if (sub.op === '||') {
            return combineOr(
              evalPossibility(sub.left, depth + 1),
              evalPossibility(sub.right, depth + 1),
            );
          }
          if (sub.op === '==' || sub.op === '!=') {
            let boolLit: boolean | undefined;
            let other: Expression | undefined;
            if (sub.left.type === 'literal' && typeof sub.left.value === 'boolean') {
              boolLit = sub.left.value;
              other = sub.right;
            } else if (sub.right.type === 'literal' && typeof sub.right.value === 'boolean') {
              boolLit = sub.right.value;
              other = sub.left;
            }
            if (boolLit !== undefined && other !== undefined) {
              const inner = evalPossibility(other, depth + 1);
              const inverts = (sub.op === '==' && !boolLit) || (sub.op === '!=' && boolLit);
              if (inverts) return negatePossibility(inner);
              return inner;
            }
          }
          if (
            ORDERED_OPS.has(sub.op)
            && (isConcreteNonOrderable(sub.left) || isConcreteNonOrderable(sub.right))
          ) {
            return { canBeTrue: false, canBeFalse: false, canError: true };
          }
        }
        if (sub.type === 'ternary') {
          const cond = evalPossibility(sub.condition, depth + 1);
          let cons = IMPOSSIBLE;
          if (cond.canBeTrue) cons = evalPossibility(sub.consequent, depth + 1);
          let alt = IMPOSSIBLE;
          if (cond.canBeFalse) alt = evalPossibility(sub.alternate, depth + 1);
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
        if (evalPossibility(rule.condition, 0).canBeTrue) return true;
      }
    }
  }

  return false;
}
