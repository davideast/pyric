import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';

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
  visiting: ReadonlySet<string>,
  requiredFunctions: Set<string>,
): boolean {
  const depends = (candidate: Expression): boolean => expressionDependsOnPath(
    candidate,
    candidateVariables,
    functions,
    ambiguousFunctions,
    visiting,
    requiredFunctions,
  );

  switch (expression.type) {
    case 'literal':
      return false;
    case 'identifier':
      return candidateVariables.has(expression.name) || expression.name === 'request';
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
      for (const arg of expression.args) {
        if (!isBareRequestIdentifier(arg) && depends(arg)) return true;
      }
      if (ambiguousFunctions.has(expression.name)) return true;
      const fn = functions.get(expression.name);
      if (!fn) {
        return expression.args.some(isBareRequestIdentifier);
      }
      if (expression.args.length !== fn.parameters.length) return true;
      requiredFunctions.add(fn.name);
      if (visiting.has(fn.name)) return true;
      const nextVisiting = new Set(visiting).add(fn.name);
      const fnBindings = new Map<string, Expression>();
      for (let i = 0; i < fn.parameters.length; i++) {
        fnBindings.set(fn.parameters[i]!, expression.args[i]!);
      }
      for (const binding of fn.lets) {
        const boundValue = substituteLocals(binding.value, fnBindings);
        if (!isBareRequestIdentifier(boundValue) && expressionDependsOnPath(
          boundValue,
          candidateVariables,
          functions,
          ambiguousFunctions,
          nextVisiting,
          requiredFunctions,
        )) return true;
        fnBindings.set(binding.name, boundValue);
      }
      return expressionDependsOnPath(
        substituteLocals(fn.body, fnBindings),
        candidateVariables,
        functions,
        ambiguousFunctions,
        nextVisiting,
        requiredFunctions,
      );
    }
  }
}

function isBareRequestIdentifier(expression: Expression): boolean {
  return expression.type === 'identifier' && expression.name === 'request';
}

function substituteLocals(
  expression: Expression,
  bindings: ReadonlyMap<string, Expression>,
): Expression {
  const sub = (e: Expression): Expression => {
    switch (e.type) {
      case 'identifier':
        return bindings.get(e.name) ?? e;
      case 'literal':
        return e;
      case 'memberAccess':
        return { ...e, object: sub(e.object) };
      case 'methodCall':
        return { ...e, object: sub(e.object), args: e.args.map(sub) };
      case 'bracketAccess':
        return { ...e, object: sub(e.object), index: sub(e.index) };
      case 'sliceAccess':
        return { ...e, object: sub(e.object), start: sub(e.start), end: sub(e.end) };
      case 'binaryOp':
        return { ...e, left: sub(e.left), right: sub(e.right) };
      case 'unaryOp':
        return { ...e, operand: sub(e.operand) };
      case 'ternary':
        return { ...e, condition: sub(e.condition), consequent: sub(e.consequent), alternate: sub(e.alternate) };
      case 'inExpr':
        return { ...e, element: sub(e.element), collection: sub(e.collection) };
      case 'isExpr':
        return { ...e, value: sub(e.value) };
      case 'listLiteral':
        return { ...e, elements: e.elements.map(sub) };
      case 'mapLiteral':
        return { ...e, entries: e.entries.map((entry) => ({ key: sub(entry.key), value: sub(entry.value) })) };
      case 'pathLiteral':
        return {
          ...e,
          segments: e.segments.map((segment) => {
            if (typeof segment === 'string') return segment;
            return sub(segment);
          }),
        };
      case 'functionCall':
        return { ...e, args: e.args.map(sub) };
    }
  };
  return sub(expression);
}

const REQUEST_PATH_INVARIANT_FIELDS = new Set(['auth', 'method', 'query', 'time']);
const EMPTY_NAMES: ReadonlySet<string> = new Set();
