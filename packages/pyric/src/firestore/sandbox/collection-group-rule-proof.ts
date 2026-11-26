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
  projectWorstCaseBudgetExpr,
  resolveRootBlockMatch,
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
 * every collection named `collectionId`, wherever it is nested. Qualifying
 * shapes:
 * - A root block ending in a recursive wildcard (such as
 *   `match /databases/{database}/documents/{document=**}`) with its own allows.
 * - `match /{document=**}`, which governs every document.
 * - `match /{path=**}/<collectionId>/{id}`, the collection-group shape, which
 *   governs every document in a collection named `collectionId` at any depth.
 * - `match /<collectionId>/{id}` directly nested under a root block ending in
 *   a recursive wildcard.
 *
 * A rule qualifies only when its condition reads none of the block's path
 * bindings, because a collection-group query has no single parent path or
 * document id to bind them to. Concrete collection matches under non-recursive
 * roots never qualify: each governs only one parent path, not the whole group.
 * Deeper nested blocks are dropped. Returns null when no rule qualifies, or
 * when the root match does not govern every document of the database: a root
 * such as `/databases/{database}/documents/z` reaches only the documents under
 * `z`, and a group query spans every collection with its id (FS2-ENF-1).
 */
export function proveCollectionGroupRules(
  ast: FirestoreRules | null,
  collectionId: string,
  database = '(default)',
): FirestoreRules | null {
  if (!ast) return null;
  if (ast.version !== '2' && ast.version !== '2+modules') return null;
  if (!rootGovernsEveryDocument(ast, database)) return null;
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
    if (!rootBlockGovernsEveryDocument(rootBlock, ast.version, database)) continue;
    const rootMatch = resolveRootBlockMatch(rootBlock, ast.version, '', database);
    if (!rootMatch) continue;

    const outerFunctions = [...serviceFunctions, ...rootBlock.functions];
    const blockRequiredDefs = new Set<FunctionDef>();
    const underRecursiveRoot = rootMatch.recursiveTail !== undefined;
    const extraBound = new Set<string>(rootMatch.recursiveVariables ?? []);
    if (rootMatch.recursiveTail !== undefined) {
      extraBound.add(rootMatch.recursiveTail.name);
    }

    let rootAllows: AllowRule[] = [];
    let rootSteps: ListBlockStep[] = [];
    if (underRecursiveRoot && rootBlock.allows.length > 0) {
      const rootScope = buildListRuleFunctionScope(outerFunctions);
      const projectedRootAllows = projectAllowsWithBudget(
        rootBlock.allows,
        extraBound,
        rootScope.functions,
        rootScope.ambiguousNames,
        database,
      );
      rootAllows = projectedRootAllows.allows;
      rootSteps = projectedRootAllows.blockSteps;
      if (rootAllows.length > 0 || rootSteps.some((step) => step.kind === 'budget')) {
        for (const fnDef of projectedRootAllows.requiredDefs) {
          blockRequiredDefs.add(fnDef);
        }
      }
    }

    const children: MatchBlock[] = [];
    for (const block of rootBlock.children) {
      const projected = projectGroupBlock(
        block,
        collectionId,
        underRecursiveRoot,
        extraBound,
        outerFunctions,
        blockRequiredDefs,
        database,
      );
      if (projected) {
        children.push(projected);
      }
    }

    const hasRootBudgets = rootSteps.some((step) => step.kind === 'budget');
    if (rootAllows.length === 0 && !hasRootBudgets && children.length === 0) continue;
    for (const fnDef of blockRequiredDefs) {
      if (!rootBlock.functions.includes(fnDef)) {
        requiredFunctionDefs.add(fnDef);
      }
    }

    const projectedRoot: MatchBlock = {
      ...rootBlock,
      functions: rootBlock.functions.filter((fn) => blockRequiredDefs.has(fn)),
      allows: rootAllows,
      children,
    };
    if (hasRootBudgets) {
      setListBlockSteps(projectedRoot, rootSteps);
    }
    projectedRoots.push(projectedRoot);
  }
  const firstRoot = projectedRoots[0];
  if (!firstRoot) return null;
  const hasAnyGrant = projectedRoots.some(
    (root) => root.allows.length > 0 || root.children.some((child) => child.allows.length > 0),
  );
  if (!hasAnyGrant) return null;

  return {
    ...ast,
    functions: retainRequired(ast.functions),
    service: {
      ...ast.service,
      functions: retainRequired(ast.service.functions),
      match: firstRoot,
      matches: projectedRoots,
    },
  };
}

/** The names a block binds when it governs every `collectionId` collection,
 *  or null when it does not. */
function groupBindings(
  block: MatchBlock,
  collectionId: string,
  underRecursiveRoot: boolean,
): Set<string> | null {
  const [first, second, third, ...rest] = block.path.segments;
  if (first?.type === 'recursive') {
    if (!second) return new Set([first.name]);
    if (
      second.type === 'literal' && second.value === collectionId
      && third?.type === 'wildcard' && rest.length === 0
    ) {
      return new Set([first.name, third.name]);
    }
    return null;
  }
  if (
    underRecursiveRoot
    && first?.type === 'literal' && first.value === collectionId
    && second?.type === 'wildcard' && third === undefined
  ) {
    return new Set([second.name]);
  }
  return null;
}

function projectPathInvariantCondition(
  expr: Expression,
  bound: ReadonlySet<string>,
  functions: ReadonlyMap<string, FunctionDef>,
  ambiguousNames: ReadonlySet<string>,
  database: string,
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
        database,
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
        database,
      );
    }
    if (inner.type === 'unaryOp' && inner.op === '!') {
      const sub = projectPathInvariantCondition(inner.operand, bound, functions, ambiguousNames, database);
      if (!sub) return null;
      return {
        condition: { type: 'unaryOp', op: '!', operand: { type: 'unaryOp', op: '!', operand: sub.condition } },
        requiredFunctionDefs: sub.requiredFunctionDefs,
      };
    }
  }
  if (expr.type === 'binaryOp' && (expr.op === '&&' || expr.op === '||')) {
    const left = projectPathInvariantCondition(expr.left, bound, functions, ambiguousNames, database);
    const right = projectPathInvariantCondition(expr.right, bound, functions, ambiguousNames, database);
    if (left && right) {
      return {
        condition: { ...expr, left: left.condition, right: right.condition },
        requiredFunctionDefs: new Set([...left.requiredFunctionDefs, ...right.requiredFunctionDefs]),
      };
    }
    if (expr.op === '||') {
      if (!left && right) {
        const dropped = projectWorstCaseBudgetExpr(expr.left, {
          outerFunctions: functions,
          candidateVariables: bound,
          ambiguousNames,
          checkResourceDependence: false,
          database,
        });
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
        const dropped = projectWorstCaseBudgetExpr(expr.right, {
          outerFunctions: functions,
          candidateVariables: bound,
          ambiguousNames,
          checkResourceDependence: false,
          database,
        });
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

interface ProjectedBlockAllows {
  readonly allows: AllowRule[];
  readonly blockSteps: ListBlockStep[];
  readonly requiredDefs: Set<FunctionDef>;
}

function projectAllowsWithBudget(
  allows: readonly AllowRule[],
  bound: ReadonlySet<string>,
  scopeFunctions: ReadonlyMap<string, FunctionDef>,
  ambiguousNames: ReadonlySet<string>,
  database: string,
): ProjectedBlockAllows {
  const retained: AllowRule[] = [];
  const blockSteps: ListBlockStep[] = [];
  const requiredDefs = new Set<FunctionDef>();
  const budgetDefs = new Set<FunctionDef>();

  for (let ruleIndex = 0; ruleIndex < allows.length; ruleIndex++) {
    const rule = allows[ruleIndex];
    if (!rule) continue;
    if (!rule.operations.some((operation) => operation === 'list' || operation === 'read')) {
      continue;
    }
    const projected = projectPathInvariantCondition(
      rule.condition,
      bound,
      scopeFunctions,
      ambiguousNames,
      database,
    );
    if (!projected) {
      const budgetBranch = projectWorstCaseBudgetExpr(rule.condition, {
        outerFunctions: scopeFunctions,
        candidateVariables: bound,
        ambiguousNames,
        checkResourceDependence: false,
        database,
      });
      let budgetRule = rule;
      if (budgetBranch.expr !== rule.condition) {
        budgetRule = { ...rule, condition: budgetBranch.expr };
      }
      blockSteps.push({ kind: 'budget', rule: budgetRule, index: ruleIndex });
      for (const fnDef of budgetBranch.requiredFunctionDefs) {
        budgetDefs.add(fnDef);
      }
      continue;
    }
    for (const fnDef of projected.requiredFunctionDefs) {
      requiredDefs.add(fnDef);
    }
    let projectedRule = rule;
    if (projected.condition !== rule.condition) {
      projectedRule = { ...rule, condition: projected.condition };
    }
    retained.push(projectedRule);
    blockSteps.push({ kind: 'grant', rule: projectedRule, index: ruleIndex });
  }

  if (blockSteps.some((step) => step.kind === 'budget')) {
    for (const fnDef of budgetDefs) {
      requiredDefs.add(fnDef);
    }
  }
  return { allows: retained, blockSteps, requiredDefs };
}

function projectGroupBlock(
  block: MatchBlock,
  collectionId: string,
  underRecursiveRoot: boolean,
  extraBound: ReadonlySet<string>,
  outerFunctions: readonly FunctionDef[],
  requiredFunctionDefs: Set<FunctionDef>,
  database: string,
): MatchBlock | null {
  const localBound = groupBindings(block, collectionId, underRecursiveRoot);
  if (!localBound) return null;
  const bound = new Set([...extraBound, ...localBound]);

  const functionScope = buildListRuleFunctionScope([...outerFunctions, ...block.functions]);
  const projected = projectAllowsWithBudget(
    block.allows,
    bound,
    functionScope.functions,
    functionScope.ambiguousNames,
    database,
  );
  const hasBudgetSteps = projected.blockSteps.some((step) => step.kind === 'budget');
  if (projected.allows.length === 0 && !hasBudgetSteps) return null;

  const blockRequiredDefs = new Set<FunctionDef>();
  for (const fnDef of projected.requiredDefs) {
    if (block.functions.includes(fnDef)) {
      blockRequiredDefs.add(fnDef);
    } else {
      requiredFunctionDefs.add(fnDef);
    }
  }

  const projectedBlock: MatchBlock = {
    ...block,
    functions: block.functions.filter((fn) => blockRequiredDefs.has(fn)),
    allows: projected.allows,
    children: [],
  };
  if (hasBudgetSteps) {
    setListBlockSteps(projectedBlock, projected.blockSteps);
  }
  return projectedBlock;
}
