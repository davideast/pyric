import type {
  FirestoreRules,
  FunctionDef,
  MatchBlock,
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
 * dropped. Returns null when no rule qualifies.
 */
export function proveCollectionGroupRules(
  ast: FirestoreRules | null,
  collectionId: string,
): FirestoreRules | null {
  if (!ast) return null;

  const outerFunctions = [
    ...(ast.functions ?? []),
    ...(ast.service.functions ?? []),
    ...ast.service.match.functions,
  ];
  const requiredFunctions = new Set<string>();
  const children = ast.service.match.children.flatMap((block) => {
    const projected = projectGroupBlock(block, collectionId, outerFunctions, requiredFunctions);
    return projected ? [projected] : [];
  });
  if (children.length === 0) return null;

  const retainRequired = (functions: readonly FunctionDef[] | undefined): FunctionDef[] | undefined =>
    functions?.filter((fn) => requiredFunctions.has(fn.name));

  return {
    ...ast,
    functions: retainRequired(ast.functions),
    service: {
      ...ast.service,
      functions: retainRequired(ast.service.functions),
      match: {
        ...ast.service.match,
        functions: retainRequired(ast.service.match.functions) ?? [],
        children,
      },
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

function projectGroupBlock(
  block: MatchBlock,
  collectionId: string,
  outerFunctions: readonly FunctionDef[],
  requiredFunctions: Set<string>,
): MatchBlock | null {
  const bound = groupBindings(block, collectionId);
  if (!bound) return null;

  const functionScope = buildListRuleFunctionScope([...outerFunctions, ...block.functions]);

  const allows = block.allows.filter((rule) => {
    if (!rule.operations.some((operation) => operation === 'list' || operation === 'read')) {
      return false;
    }
    const analysis = analyzeListRulePathInvariance(
      rule.condition,
      bound,
      functionScope.functions,
      functionScope.ambiguousNames,
    );
    if (analysis.pathInvariant) {
      for (const name of analysis.requiredFunctions) requiredFunctions.add(name);
    }
    return analysis.pathInvariant;
  });
  if (allows.length === 0) return null;

  return {
    ...block,
    functions: block.functions.filter((fn) => requiredFunctions.has(fn.name)),
    allows,
    children: [],
  };
}
