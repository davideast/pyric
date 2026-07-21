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
 * Projects the ruleset down to path-invariant, root-level `{document=**}`
 * list rules. Those rules govern every possible result of a collection-group
 * query, unlike a concrete root collection match.
 *
 * Group-specific `/{path=**}/items/{id}` proofs remain fail-closed until the
 * matcher can evaluate recursive wildcards with trailing segments.
 */
export function proveGlobalCollectionGroupRules(
  ast: FirestoreRules | null,
): FirestoreRules | null {
  if (!ast) return null;

  const outerFunctions = [
    ...(ast.functions ?? []),
    ...(ast.service.functions ?? []),
    ...ast.service.match.functions,
  ];
  const requiredFunctions = new Set<string>();
  const children = ast.service.match.children.flatMap((block) => {
    const projected = projectGlobalBlock(block, outerFunctions, requiredFunctions);
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

function projectGlobalBlock(
  block: MatchBlock,
  outerFunctions: readonly FunctionDef[],
  requiredFunctions: Set<string>,
): MatchBlock | null {
  const segment = block.path.segments[0];
  if (block.path.segments.length !== 1 || segment?.type !== 'recursive') return null;

  const functionScope = buildListRuleFunctionScope([...outerFunctions, ...block.functions]);

  const allows = block.allows.filter((rule) => {
    if (!rule.operations.some((operation) => operation === 'list' || operation === 'read')) {
      return false;
    }
    const analysis = analyzeListRulePathInvariance(
      rule.condition,
      new Set([segment.name]),
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
