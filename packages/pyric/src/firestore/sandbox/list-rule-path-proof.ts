import type { Expression, FunctionDef } from 'pyric/rules/internal';

export interface ListRulePathAnalysis {
  pathInvariant: boolean;
  requiredFunctions: ReadonlySet<string>;
}

export interface ListRuleFunctionScope {
  functions: Map<string, FunctionDef>;
  ambiguousNames: ReadonlySet<string>;
}

/** Builds the simulator's nearest-definition lookup while retaining name
 * collisions that require conservative proof behavior. */
export function buildListRuleFunctionScope(
  definitions: readonly FunctionDef[],
): ListRuleFunctionScope {
  const functions = new Map<string, FunctionDef>();
  const ambiguousNames = new Set<string>();
  for (const fn of definitions) {
    if (functions.has(fn.name)) ambiguousNames.add(fn.name);
    functions.set(fn.name, fn);
  }
  return { functions, ambiguousNames };
}

/**
 * Proves that a list rule cannot change its decision across candidate paths.
 * Candidate document wildcards and `request.path` are result-dependent;
 * request auth, method, query, and time are stable for the whole query.
 */
export function analyzeListRulePathInvariance(
  expression: Expression,
  candidateVariables: ReadonlySet<string>,
  functions: ReadonlyMap<string, FunctionDef>,
  ambiguousFunctions: ReadonlySet<string> = EMPTY_NAMES,
): ListRulePathAnalysis {
  const requiredFunctions = new Set<string>();
  return {
    pathInvariant: !expressionDependsOnPath(
      expression,
      candidateVariables,
      functions,
      ambiguousFunctions,
      new Set(),
      new Set(),
      requiredFunctions,
    ),
    requiredFunctions,
  };
}

function expressionDependsOnPath(
  expression: Expression,
  candidateVariables: ReadonlySet<string>,
  functions: ReadonlyMap<string, FunctionDef>,
  ambiguousFunctions: ReadonlySet<string>,
  locals: ReadonlySet<string>,
  visiting: ReadonlySet<string>,
  requiredFunctions: Set<string>,
): boolean {
  const depends = (candidate: Expression): boolean => expressionDependsOnPath(
    candidate,
    candidateVariables,
    functions,
    ambiguousFunctions,
    locals,
    visiting,
    requiredFunctions,
  );

  switch (expression.type) {
    case 'literal':
      return false;
    case 'identifier':
      return !locals.has(expression.name) && (
        candidateVariables.has(expression.name) || expression.name === 'request'
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
      if (ambiguousFunctions.has(expression.name)) return true;
      const fn = functions.get(expression.name);
      if (!fn) return false;
      requiredFunctions.add(fn.name);
      if (visiting.has(fn.name)) return true;
      const nextVisiting = new Set(visiting).add(fn.name);
      const fnLocals = new Set(fn.parameters);
      for (const binding of fn.lets) {
        if (expressionDependsOnPath(
          binding.value,
          candidateVariables,
          functions,
          ambiguousFunctions,
          fnLocals,
          nextVisiting,
          requiredFunctions,
        )) return true;
        fnLocals.add(binding.name);
      }
      return expressionDependsOnPath(
        fn.body,
        candidateVariables,
        functions,
        ambiguousFunctions,
        fnLocals,
        nextVisiting,
        requiredFunctions,
      );
    }
  }
}

const REQUEST_PATH_INVARIANT_FIELDS = new Set(['auth', 'method', 'query', 'time']);
const EMPTY_NAMES: ReadonlySet<string> = new Set();
