/**
 * Firestore Rules root-database normalization and collection-group AST
 * projection for {@link staticQueryProofPass}.
 */
import {
  analyzeListRulePathInvariance,
  attachOrBudgetStep,
  buildListRuleFunctionScope,
  indexRulesetScopes,
  projectWorstCaseBudgetExpr,
  resolveRootBlockMatch,
  rootBlockGovernsEveryDocument,
  rootGovernsEveryDocument,
  setListBlockSteps,
  substituteIdentifiers,
  topLevelMatches,
  type AllowRule,
  type Expression,
  type FirestoreRules,
  type FunctionDef,
  type LetBinding,
  type ListBlockStep,
  type MatchBlock,
  type PathSegment,
} from '@pyric/rules/internal';

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

function substituteRootWildcardInFunction(
  fn: FunctionDef,
  wildcardName: string,
  bindings: ReadonlyMap<string, Expression>,
): FunctionDef {
  if (fn.parameters.includes(wildcardName)) return fn;
  const nextLets: LetBinding[] = [];
  let shadowedByLet = false;
  let changed = false;
  for (const b of fn.lets) {
    if (shadowedByLet) {
      nextLets.push(b);
      continue;
    }
    const nextValue = substituteIdentifiers(b.value, bindings);
    if (nextValue !== b.value) changed = true;
    nextLets.push({ ...b, value: nextValue });
    if (b.name === wildcardName) {
      shadowedByLet = true;
    }
  }
  let nextBody = fn.body;
  if (!shadowedByLet) {
    nextBody = substituteIdentifiers(fn.body, bindings);
    if (nextBody !== fn.body) changed = true;
  }
  if (!changed) return fn;
  return { ...fn, lets: nextLets, body: nextBody };
}

function substituteRootWildcardInBlock(
  block: MatchBlock,
  wildcardName: string,
  bindings: ReadonlyMap<string, Expression>,
  isRoot: boolean,
): MatchBlock {
  if (
    !isRoot
    && block.path.segments.some(
      (seg) => (seg.type === 'wildcard' || seg.type === 'recursive') && seg.name === wildcardName,
    )
  ) {
    return block;
  }
  const nextFunctions = block.functions.map((fn) =>
    substituteRootWildcardInFunction(fn, wildcardName, bindings),
  );
  const nextAllows = block.allows.map((rule) => {
    const nextCond = substituteIdentifiers(rule.condition, bindings);
    if (nextCond === rule.condition) return rule;
    return { ...rule, condition: nextCond };
  });
  const nextChildren = block.children.map((child) =>
    substituteRootWildcardInBlock(child, wildcardName, bindings, false),
  );
  return {
    ...block,
    functions: nextFunctions,
    allows: nextAllows,
    children: nextChildren,
  };
}

function normalizeRootMatchBlock(rootBlock: MatchBlock, resourceId: string): MatchBlock {
  const segments = rootBlock.path.segments;
  const first = segments[0];
  const second = segments[1];
  if (first?.type !== 'literal' || first.value !== 'databases' || second === undefined) {
    return rootBlock;
  }
  if (second.type === 'wildcard') {
    const normalizedSegments: PathSegment[] = [...segments];
    normalizedSegments[1] = { type: 'literal', value: '(default)' };
    const replacement: Expression = {
      type: 'literal',
      value: resourceId,
      raw: JSON.stringify(resourceId),
    };
    const bindings = new Map<string, Expression>([[second.name, replacement]]);
    return substituteRootWildcardInBlock(
      {
        ...rootBlock,
        path: {
          ...rootBlock.path,
          segments: normalizedSegments,
        },
      },
      second.name,
      bindings,
      true,
    );
  }
  if (second.type !== 'literal') {
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
  const normalized: FirestoreRules = {
    ...ast,
    service: nextService,
  };
  if (nextServices !== undefined) {
    normalized.services = nextServices;
  }
  return normalized;
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
        condition: {
          type: 'unaryOp',
          op: '!',
          operand: { type: 'unaryOp', op: '!', operand: sub.condition },
        },
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
        requiredFunctionDefs: new Set([
          ...left.requiredFunctionDefs,
          ...right.requiredFunctionDefs,
        ]),
      };
    }
    if (expr.op === '||') {
      if (!left && right) {
        const dropped = projectWorstCaseBudgetExpr(expr.left, {
          outerFunctions: functions,
          candidateVariables: bound,
          ambiguousNames,
          checkResourceDependence: false,
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
): ProjectedBlockAllows {
  const retained: AllowRule[] = [];
  const blockSteps: ListBlockStep[] = [];
  const requiredDefs = new Set<FunctionDef>();
  const budgetDefs = new Set<FunctionDef>();

  for (let ruleIndex = 0; ruleIndex < allows.length; ruleIndex += 1) {
    const rule = allows[ruleIndex]!;
    const hasListOrRead = rule.operations.some((op) => op === 'list' || op === 'read');
    if (!hasListOrRead) continue;
    const projected = projectPathInvariantCondition(
      rule.condition,
      bound,
      scopeFunctions,
      ambiguousNames,
    );
    if (!projected) {
      const budgetBranch = projectWorstCaseBudgetExpr(rule.condition, {
        outerFunctions: scopeFunctions,
        candidateVariables: bound,
        ambiguousNames,
        checkResourceDependence: false,
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
): MatchBlock | null {
  const localBound = groupBindings(block, collectionId, underRecursiveRoot);
  if (!localBound) return null;
  const bound = new Set([...extraBound, ...localBound]);
  const scope = buildListRuleFunctionScope([...outerFunctions, ...block.functions]);
  const projected = projectAllowsWithBudget(
    block.allows,
    bound,
    scope.functions,
    scope.ambiguousNames,
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

export function projectCollectionGroupAst(
  ast: FirestoreRules,
  collectionId: string,
): FirestoreRules | null {
  indexRulesetScopes(ast);
  if (!rootGovernsEveryDocument(ast)) return null;

  const requiredFunctionDefs = new Set<FunctionDef>();
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
    for (const child of rootBlock.children) {
      const projected = projectGroupBlock(
        child,
        collectionId,
        underRecursiveRoot,
        extraBound,
        outerFunctions,
        blockRequiredDefs,
      );
      if (projected) children.push(projected);
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

  const hasAnyGrant = projectedRoots.some(
    (root) => root.allows.length > 0 || root.children.some((child) => child.allows.length > 0),
  );
  if (!hasAnyGrant) return null;
  const retainGlobal = (fns: readonly FunctionDef[] | undefined): FunctionDef[] | undefined => {
    if (!fns) return undefined;
    return fns.filter((fn) => requiredFunctionDefs.has(fn));
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
