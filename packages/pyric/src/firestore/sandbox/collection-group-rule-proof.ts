import type {
  Expression,
  FirestoreRules,
  FunctionDef,
  MatchBlock,
} from 'pyric/rules/internal';

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

  const functions = new Map<string, FunctionDef>();
  for (const fn of [...outerFunctions, ...block.functions]) functions.set(fn.name, fn);

  const allows = block.allows.filter((rule) => {
    if (!rule.operations.some((operation) => operation === 'list' || operation === 'read')) {
      return false;
    }
    const usedByRule = new Set<string>();
    const pathDependent = expressionDependsOnPath(
      rule.condition,
      segment.name,
      functions,
      new Set(),
      new Set(),
      usedByRule,
    );
    if (!pathDependent) {
      for (const name of usedByRule) requiredFunctions.add(name);
    }
    return !pathDependent;
  });
  if (allows.length === 0) return null;

  return {
    ...block,
    functions: block.functions.filter((fn) => requiredFunctions.has(fn.name)),
    allows,
    children: [],
  };
}

function expressionDependsOnPath(
  expression: Expression,
  recursiveName: string,
  functions: ReadonlyMap<string, FunctionDef>,
  locals: ReadonlySet<string>,
  visiting: ReadonlySet<string>,
  requiredFunctions: Set<string>,
): boolean {
  const depends = (candidate: Expression): boolean => expressionDependsOnPath(
    candidate,
    recursiveName,
    functions,
    locals,
    visiting,
    requiredFunctions,
  );

  switch (expression.type) {
    case 'literal':
      return false;
    case 'identifier':
      return !locals.has(expression.name) && (
        expression.name === recursiveName || expression.name === 'request'
      );
    case 'memberAccess':
      if (expression.object.type === 'identifier' && expression.object.name === 'request') {
        return !REQUEST_PATH_INVARIANT_FIELDS.has(expression.property);
      }
      return depends(expression.object);
    case 'methodCall':
      return depends(expression.object) || expression.args.some(depends);
    case 'bracketAccess':
      if (expression.object.type === 'identifier' && expression.object.name === 'request') {
        return !(
          expression.index.type === 'literal' &&
          typeof expression.index.value === 'string' &&
          REQUEST_PATH_INVARIANT_FIELDS.has(expression.index.value)
        );
      }
      return depends(expression.object) || depends(expression.index);
    case 'sliceAccess':
      return depends(expression.object) || depends(expression.start) || depends(expression.end);
    case 'binaryOp':
      return depends(expression.left) || depends(expression.right);
    case 'unaryOp':
      return depends(expression.operand);
    case 'ternary':
      return depends(expression.condition) || depends(expression.consequent) || depends(expression.alternate);
    case 'inExpr':
      return depends(expression.element) || depends(expression.collection);
    case 'isExpr':
      return depends(expression.value);
    case 'listLiteral':
      return expression.elements.some(depends);
    case 'mapLiteral':
      return expression.entries.some((entry) => depends(entry.key) || depends(entry.value));
    case 'pathLiteral':
      return expression.segments.some((segment) => typeof segment !== 'string' && depends(segment));
    case 'functionCall': {
      if (expression.args.some(depends)) return true;
      const fn = functions.get(expression.name);
      if (!fn) return false;
      requiredFunctions.add(fn.name);
      if (visiting.has(fn.name)) return true;
      const nextVisiting = new Set(visiting).add(fn.name);
      const fnLocals = new Set(fn.parameters);
      for (const binding of fn.lets) {
        if (expressionDependsOnPath(
          binding.value,
          recursiveName,
          functions,
          fnLocals,
          nextVisiting,
          requiredFunctions,
        )) return true;
        fnLocals.add(binding.name);
      }
      return expressionDependsOnPath(
        fn.body,
        recursiveName,
        functions,
        fnLocals,
        nextVisiting,
        requiredFunctions,
      );
    }
  }
}

const REQUEST_PATH_INVARIANT_FIELDS = new Set(['auth', 'method', 'query', 'time']);
