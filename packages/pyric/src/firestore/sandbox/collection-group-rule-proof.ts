import type {
  AllowRule,
  Expression,
  FirestoreRules,
  FunctionDef,
  ListBlockStep,
  MatchBlock,
} from 'pyric/rules/internal';
import {
  attachOrBudgetStep,
  indexRulesetScopes,
  rootBlockGovernsEveryDocument,
  rootGovernsEveryDocument,
  setListBlockSteps,
  topLevelMatches,
} from 'pyric/rules/internal';
import {
  analyzeListRulePathInvariance,
  buildListRuleFunctionScope,
} from './list-rule-path-proof.js';

/**
 * Projects the ruleset down to the path-invariant list rules that govern
 * every collection named `collectionId`, wherever it is nested. Two top-level
 * shapes qualify:
 * - `match /{document=**}`, which governs every document.
 * - `match /{path=**}/<collectionId>/{id}`, the collection-group shape, which
 *   governs every document in a collection named `collectionId` at any depth.
 *
 * A rule qualifies only when its condition reads none of the block's path
 * bindings, because a collection-group query has no single parent path or
 * document id to bind them to. Concrete collection matches never qualify: each
 * governs only one parent path, not the whole group. Nested blocks are
 * dropped. Returns null when no rule qualifies, or when the root match does
 * not govern every document of the database: a root such as
 * `/databases/{database}/documents/z` reaches only the documents under `z`,
 * and a group query spans every collection with its id (FS2-ENF-1).
 */
export function proveCollectionGroupRules(
  ast: FirestoreRules | null,
  collectionId: string,
): FirestoreRules | null {
  if (!ast) return null;
  if (!rootGovernsEveryDocument(ast)) return null;
  indexRulesetScopes(ast);

  const serviceFunctions = [
    ...(ast.functions ?? []),
    ...(ast.service.functions ?? []),
  ];
  const requiredFunctionDefs = new Set<FunctionDef>();
  const retainRequired = (functions: readonly FunctionDef[] | undefined): FunctionDef[] | undefined =>
    functions?.filter((fn) => requiredFunctionDefs.has(fn));

  const projectedRoots: MatchBlock[] = [];
  for (const rootBlock of topLevelMatches(ast.service)) {
    if (!rootBlockGovernsEveryDocument(rootBlock, ast.version)) continue;
    const outerFunctions = [...serviceFunctions, ...rootBlock.functions];
    const children: MatchBlock[] = [];
    for (const block of rootBlock.children) {
      const projected = projectGroupBlock(block, collectionId, outerFunctions, requiredFunctionDefs);
      if (projected) {
        children.push(projected);
      }
    }
    if (children.length === 0) continue;
    projectedRoots.push({
      ...rootBlock,
      functions: retainRequired(rootBlock.functions) ?? [],
      children,
    });
  }
  if (projectedRoots.length === 0) return null;

  return {
    ...ast,
    functions: retainRequired(ast.functions),
    service: {
      ...ast.service,
      functions: retainRequired(ast.service.functions),
      match: projectedRoots[0]!,
      matches: projectedRoots,
    },
  };
}

/** The names a block binds when it governs every `collectionId` collection,
 *  or null when it does not. */
function groupBindings(block: MatchBlock, collectionId: string): Set<string> | null {
  const [first, second, third, ...rest] = block.path.segments;
  if (first?.type !== 'recursive') return null;
  if (!second) return new Set([first.name]);
  if (
    second.type === 'literal' && second.value === collectionId
    && third?.type === 'wildcard' && rest.length === 0
  ) {
    return new Set([first.name, third.name]);
  }
  return null;
}

function worstCasePathBudgetBranch(
  expr: Expression,
  bound: ReadonlySet<string>,
  functions: ReadonlyMap<string, FunctionDef>,
  ambiguousNames: ReadonlySet<string>,
): { expr: Expression; requiredFunctionDefs: ReadonlySet<FunctionDef> } {
  const analysis = analyzeListRulePathInvariance(expr, bound, functions, ambiguousNames);
  if (analysis.pathInvariant) {
    return { expr, requiredFunctionDefs: analysis.requiredFunctionDefs };
  }
  if (expr.type === 'unaryOp' && expr.op === '!') {
    const inner = expr.operand;
    if (inner.type === 'binaryOp' && (inner.op === '&&' || inner.op === '||')) {
      return worstCasePathBudgetBranch(
        {
          type: 'binaryOp',
          op: inner.op === '&&' ? '||' : '&&',
          left: { type: 'unaryOp', op: '!', operand: inner.left },
          right: { type: 'unaryOp', op: '!', operand: inner.right },
        },
        bound,
        functions,
        ambiguousNames,
      );
    }
    const sub = worstCasePathBudgetBranch(inner, bound, functions, ambiguousNames);
    return {
      expr: sub.expr === inner ? expr : { ...expr, operand: sub.expr },
      requiredFunctionDefs: sub.requiredFunctionDefs,
    };
  }
  if (expr.type === 'binaryOp' && (expr.op === '&&' || expr.op === '||')) {
    const left = worstCasePathBudgetBranch(expr.left, bound, functions, ambiguousNames);
    const right = worstCasePathBudgetBranch(expr.right, bound, functions, ambiguousNames);
    const defs = new Set([...left.requiredFunctionDefs, ...right.requiredFunctionDefs]);
    const leftInvariant = analyzeListRulePathInvariance(
      expr.left,
      bound,
      functions,
      ambiguousNames,
    ).pathInvariant;
    if (!leftInvariant) {
      return {
        expr: attachOrBudgetStep(right.expr, {
          operator: expr,
          side: 'before',
          branch: left.expr,
        }),
        requiredFunctionDefs: defs,
      };
    }
    return {
      expr: { ...expr, left: left.expr, right: right.expr },
      requiredFunctionDefs: defs,
    };
  }
  return { expr, requiredFunctionDefs: analysis.requiredFunctionDefs };
}

function projectPathInvariantCondition(
  expr: Expression,
  bound: ReadonlySet<string>,
  functions: ReadonlyMap<string, FunctionDef>,
  ambiguousNames: ReadonlySet<string>,
): { condition: Expression; requiredFunctionDefs: ReadonlySet<FunctionDef> } | null {
  const analysis = analyzeListRulePathInvariance(expr, bound, functions, ambiguousNames);
  if (analysis.pathInvariant) {
    return { condition: expr, requiredFunctionDefs: analysis.requiredFunctionDefs };
  }
  if (expr.type === 'unaryOp' && expr.op === '!') {
    const inner = expr.operand;
    if (inner.type === 'binaryOp' && inner.op === '&&') {
      return projectPathInvariantCondition(
        {
          type: 'binaryOp',
          op: '||',
          left: { type: 'unaryOp', op: '!', operand: inner.left },
          right: { type: 'unaryOp', op: '!', operand: inner.right },
        },
        bound,
        functions,
        ambiguousNames,
      );
    }
    if (inner.type === 'binaryOp' && inner.op === '||') {
      return projectPathInvariantCondition(
        {
          type: 'binaryOp',
          op: '&&',
          left: { type: 'unaryOp', op: '!', operand: inner.left },
          right: { type: 'unaryOp', op: '!', operand: inner.right },
        },
        bound,
        functions,
        ambiguousNames,
      );
    }
    if (inner.type === 'unaryOp' && inner.op === '!') {
      const sub = projectPathInvariantCondition(inner.operand, bound, functions, ambiguousNames);
      if (!sub) return null;
      return {
        condition: { type: 'unaryOp', op: '!', operand: { type: 'unaryOp', op: '!', operand: sub.condition } },
        requiredFunctionDefs: sub.requiredFunctionDefs,
      };
    }
  }
  if (expr.type === 'binaryOp' && (expr.op === '&&' || expr.op === '||')) {
    const left = projectPathInvariantCondition(expr.left, bound, functions, ambiguousNames);
    const right = projectPathInvariantCondition(expr.right, bound, functions, ambiguousNames);
    if (left && right) {
      return {
        condition: { ...expr, left: left.condition, right: right.condition },
        requiredFunctionDefs: new Set([...left.requiredFunctionDefs, ...right.requiredFunctionDefs]),
      };
    }
    if (expr.op === '||') {
      if (!left && right) {
        const dropped = worstCasePathBudgetBranch(expr.left, bound, functions, ambiguousNames);
        return {
          condition: attachOrBudgetStep(right.condition, {
            operator: expr,
            side: 'before',
            branch: dropped.expr,
          }),
          requiredFunctionDefs: new Set([
            ...right.requiredFunctionDefs,
            ...dropped.requiredFunctionDefs,
          ]),
        };
      }
      if (left && !right) {
        const dropped = worstCasePathBudgetBranch(expr.right, bound, functions, ambiguousNames);
        return {
          condition: attachOrBudgetStep(left.condition, {
            operator: expr,
            side: 'after',
            branch: dropped.expr,
          }),
          requiredFunctionDefs: new Set([
            ...left.requiredFunctionDefs,
            ...dropped.requiredFunctionDefs,
          ]),
        };
      }
    }
  }
  return null;
}

function projectGroupBlock(
  block: MatchBlock,
  collectionId: string,
  outerFunctions: readonly FunctionDef[],
  requiredFunctionDefs: Set<FunctionDef>,
): MatchBlock | null {
  const bound = groupBindings(block, collectionId);
  if (!bound) return null;

  const functionScope = buildListRuleFunctionScope([...outerFunctions, ...block.functions]);
  const blockRequiredDefs = new Set<FunctionDef>();
  const budgetDefs = new Set<FunctionDef>();
  const allows: AllowRule[] = [];
  const blockSteps: ListBlockStep[] = [];

  for (let ruleIndex = 0; ruleIndex < block.allows.length; ruleIndex++) {
    const rule = block.allows[ruleIndex]!;
    if (!rule.operations.some((operation) => operation === 'list' || operation === 'read')) {
      continue;
    }
    const projected = projectPathInvariantCondition(
      rule.condition,
      bound,
      functionScope.functions,
      functionScope.ambiguousNames,
    );
    if (!projected) {
      const budgetBranch = worstCasePathBudgetBranch(
        rule.condition,
        bound,
        functionScope.functions,
        functionScope.ambiguousNames,
      );
      const budgetRule = budgetBranch.expr === rule.condition
        ? rule
        : { ...rule, condition: budgetBranch.expr };
      blockSteps.push({ kind: 'budget', rule: budgetRule, index: ruleIndex });
      for (const fnDef of budgetBranch.requiredFunctionDefs) {
        budgetDefs.add(fnDef);
      }
      continue;
    }
    for (const fnDef of projected.requiredFunctionDefs) {
      if (block.functions.includes(fnDef)) {
        blockRequiredDefs.add(fnDef);
      } else {
        requiredFunctionDefs.add(fnDef);
      }
    }
    const projectedRule = projected.condition === rule.condition
      ? rule
      : { ...rule, condition: projected.condition };
    allows.push(projectedRule);
    blockSteps.push({ kind: 'grant', rule: projectedRule, index: ruleIndex });
  }
  if (allows.length === 0) return null;

  if (blockSteps.some((step) => step.kind === 'budget')) {
    for (const fnDef of budgetDefs) {
      if (block.functions.includes(fnDef)) {
        blockRequiredDefs.add(fnDef);
      } else {
        requiredFunctionDefs.add(fnDef);
      }
    }
  }

  const projectedBlock: MatchBlock = {
    ...block,
    functions: block.functions.filter((fn) => blockRequiredDefs.has(fn)),
    allows,
    children: [],
  };
  if (blockSteps.some((step) => step.kind === 'budget')) {
    setListBlockSteps(projectedBlock, blockSteps);
  }
  return projectedBlock;
}
