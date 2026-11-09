import type {
  AllowRule,
  Expression,
  FirestoreRules,
  FunctionDef,
  MatchBlock,
} from 'pyric/rules/internal';
import {
  indexRulesetScopes,
  rootBlockGovernsEveryDocument,
  rootGovernsEveryDocument,
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
      return left ?? right;
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
  const allows: AllowRule[] = [];

  for (const rule of block.allows) {
    if (!rule.operations.some((operation) => operation === 'list' || operation === 'read')) {
      continue;
    }
    const projected = projectPathInvariantCondition(
      rule.condition,
      bound,
      functionScope.functions,
      functionScope.ambiguousNames,
    );
    if (!projected) continue;
    for (const fnDef of projected.requiredFunctionDefs) {
      if (block.functions.includes(fnDef)) {
        blockRequiredDefs.add(fnDef);
      } else {
        requiredFunctionDefs.add(fnDef);
      }
    }
    if (projected.condition === rule.condition) {
      allows.push(rule);
    } else {
      allows.push({ ...rule, condition: projected.condition });
    }
  }
  if (allows.length === 0) return null;

  return {
    ...block,
    functions: block.functions.filter((fn) => blockRequiredDefs.has(fn)),
    allows,
    children: [],
  };
}
