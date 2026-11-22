import type { Expression, FunctionDef } from './FirestoreAST.js';
import { expandFunctionBody, exprContains, walkExpr } from './function-scopes.js';

function boolLiteral(value: boolean): Expression {
  return { type: 'literal', value, raw: String(value) };
}

function isLitBool(expr: Expression, value: boolean): boolean {
  return expr.type === 'literal' && expr.value === value;
}

/**
 * Simplify semantically-constant conditions so the literal checks and the
 * auth/data-reference walks operate on the reduced form. Recurses into nested
 * nodes so `X || (Y || true)` folds to `true`. Non-constant subexpressions are
 * preserved intact so the downstream walks still see real auth/data references.
 */
export function foldConstants(
  expr: Expression,
  fns?: ReadonlyMap<string, FunctionDef>,
  fnScopes?: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  visited?: ReadonlySet<FunctionDef>,
): Expression {
  switch (expr.type) {
    case 'binaryOp': {
      const left = foldConstants(expr.left, fns, fnScopes, visited);
      const right = foldConstants(expr.right, fns, fnScopes, visited);
      if (expr.op === '||') {
        if (isLitBool(left, true) || isLitBool(right, true)) return boolLiteral(true);
        if (isLitBool(left, false)) return right;
        if (isLitBool(right, false)) return left;
      } else if (expr.op === '&&') {
        if (isLitBool(left, false) || isLitBool(right, false)) return boolLiteral(false);
        if (isLitBool(left, true)) return right;
        if (isLitBool(right, true)) return left;
      }
      return { type: 'binaryOp', op: expr.op, left, right };
    }
    case 'unaryOp': {
      const operand = foldConstants(expr.operand, fns, fnScopes, visited);
      if (expr.op === '!' && operand.type === 'literal' && typeof operand.value === 'boolean') {
        return boolLiteral(!operand.value);
      }
      return { type: 'unaryOp', op: expr.op, operand };
    }
    case 'ternary': {
      const condition = foldConstants(expr.condition, fns, fnScopes, visited);
      const consequent = foldConstants(expr.consequent, fns, fnScopes, visited);
      const alternate = foldConstants(expr.alternate, fns, fnScopes, visited);
      if (condition.type === 'literal' && typeof condition.value === 'boolean') {
        if (condition.value) return consequent;
        return alternate;
      }
      return { type: 'ternary', condition, consequent, alternate };
    }
    case 'functionCall': {
      if (expr.args.length !== 0 || !fns) return expr;
      const fn = fns.get(expr.name);
      if (!fn || fn.parameters.length !== 0 || visited?.has(fn)) return expr;
      const nextVisited = new Set(visited);
      nextVisited.add(fn);
      const calleeScope = fnScopes?.get(fn) ?? fns;
      const foldedBody = foldConstants(expandFunctionBody(fn), calleeScope, fnScopes, nextVisited);
      if (foldedBody.type === 'literal' && foldedBody.value === false) {
        return boolLiteral(false);
      }
      return expr;
    }
    default:
      return expr;
  }
}

/** Every expression a function evaluates: each let value, then the return expression. */
function functionExpressions(fn: FunctionDef): Expression[] {
  return [...fn.lets.map((l) => l.value), fn.body];
}

function propTarget(expr: Expression, prop: string): Expression | null {
  if (expr.type === 'memberAccess' && expr.property === prop) return expr.object;
  if (expr.type === 'bracketAccess' && expr.index.type === 'literal' && expr.index.value === prop) {
    return expr.object;
  }
  return null;
}

function isRequestAuth(e: Expression): boolean {
  const obj = propTarget(e, 'auth');
  return obj !== null && obj.type === 'identifier' && obj.name === 'request';
}

function isRequestAuthUid(e: Expression): boolean {
  const obj = propTarget(e, 'uid');
  return obj !== null && isRequestAuth(obj);
}

function isRequestResource(e: Expression): boolean {
  const reqObj = propTarget(e, 'resource');
  return reqObj !== null && reqObj.type === 'identifier' && reqObj.name === 'request';
}

function isRequestResourceData(e: Expression): boolean {
  const resObj = propTarget(e, 'data');
  if (!resObj) return false;
  return isRequestResource(resObj);
}

function isResourceData(e: Expression): boolean {
  const obj = propTarget(e, 'data');
  return obj !== null && obj.type === 'identifier' && obj.name === 'resource';
}

function isNullLiteral(e: Expression): boolean {
  return e.type === 'literal' && e.value === null;
}

function isAuthComparisonWithNull(e: Expression, op: '==' | '!='): boolean {
  if (e.type !== 'binaryOp' || e.op !== op) return false;
  return (
    (isRequestAuth(e.left) && isNullLiteral(e.right)) ||
    (isNullLiteral(e.left) && isRequestAuth(e.right))
  );
}

function isAuthUidComparisonWithPathVar(
  e: Expression,
  op: '==' | '!=',
  pathVars: ReadonlySet<string>,
): boolean {
  if (e.type !== 'binaryOp' || e.op !== op) return false;
  if (isRequestAuthUid(e.left) && e.right.type === 'identifier' && pathVars.has(e.right.name)) {
    return true;
  }
  if (isRequestAuthUid(e.right) && e.left.type === 'identifier' && pathVars.has(e.left.name)) {
    return true;
  }
  return false;
}

function substituteParameters(
  expr: Expression,
  bindings: ReadonlyMap<string, Expression>,
): Expression {
  if (bindings.size === 0) return expr;
  switch (expr.type) {
    case 'identifier':
      return bindings.get(expr.name) ?? expr;
    case 'binaryOp':
      return {
        ...expr,
        left: substituteParameters(expr.left, bindings),
        right: substituteParameters(expr.right, bindings),
      };
    case 'unaryOp':
      return { ...expr, operand: substituteParameters(expr.operand, bindings) };
    case 'ternary':
      return {
        ...expr,
        condition: substituteParameters(expr.condition, bindings),
        consequent: substituteParameters(expr.consequent, bindings),
        alternate: substituteParameters(expr.alternate, bindings),
      };
    case 'methodCall':
      return {
        ...expr,
        object: substituteParameters(expr.object, bindings),
        args: expr.args.map((a) => substituteParameters(a, bindings)),
      };
    case 'functionCall':
      return { ...expr, args: expr.args.map((a) => substituteParameters(a, bindings)) };
    case 'bracketAccess':
      return {
        ...expr,
        object: substituteParameters(expr.object, bindings),
        index: substituteParameters(expr.index, bindings),
      };
    case 'sliceAccess':
      return {
        ...expr,
        object: substituteParameters(expr.object, bindings),
        start: substituteParameters(expr.start, bindings),
        end: substituteParameters(expr.end, bindings),
      };
    case 'memberAccess':
      return { ...expr, object: substituteParameters(expr.object, bindings) };
    case 'inExpr':
      return {
        ...expr,
        element: substituteParameters(expr.element, bindings),
        collection: substituteParameters(expr.collection, bindings),
      };
    case 'isExpr':
      return { ...expr, value: substituteParameters(expr.value, bindings) };
    case 'listLiteral':
      return { ...expr, elements: expr.elements.map((el) => substituteParameters(el, bindings)) };
    case 'mapLiteral':
      return {
        ...expr,
        entries: expr.entries.map((entry) => ({
          key: substituteParameters(entry.key, bindings),
          value: substituteParameters(entry.value, bindings),
        })),
      };
    case 'pathLiteral':
      return {
        ...expr,
        segments: expr.segments.map((seg) => {
          if (typeof seg === 'string') return seg;
          return substituteParameters(seg, bindings);
        }),
      };
    default:
      return expr;
  }
}

function expandCalledFunction(fn: FunctionDef, callArgs: readonly Expression[]): Expression {
  if (fn.parameters.length !== callArgs.length) {
    return boolLiteral(false);
  }
  const expanded = expandFunctionBody(fn);
  if (fn.parameters.length === 0) {
    return expanded;
  }
  const bindings = new Map<string, Expression>();
  for (let i = 0; i < fn.parameters.length; i++) {
    const param = fn.parameters[i];
    const arg = callArgs[i];
    if (param !== undefined && arg !== undefined) {
      bindings.set(param, arg);
    }
  }
  return substituteParameters(expanded, bindings);
}

function guardsConditionTransitive(
  expr: Expression,
  checkAtom: (e: Expression) => boolean | null,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  visited = new Set<FunctionDef>(),
): boolean {
  if (expr.type === 'binaryOp' && expr.op === '||') {
    return (
      guardsConditionTransitive(expr.left, checkAtom, fns, fnScopes, visited) &&
      guardsConditionTransitive(expr.right, checkAtom, fns, fnScopes, visited)
    );
  }
  if (expr.type === 'binaryOp' && expr.op === '&&') {
    return (
      guardsConditionTransitive(expr.left, checkAtom, fns, fnScopes, visited) ||
      guardsConditionTransitive(expr.right, checkAtom, fns, fnScopes, visited)
    );
  }
  if (expr.type === 'ternary') {
    const condGuards = guardsConditionTransitive(expr.condition, checkAtom, fns, fnScopes, visited);
    const thenGuards = condGuards || guardsConditionTransitive(expr.consequent, checkAtom, fns, fnScopes, visited);
    if (isLitBool(expr.alternate, false)) return thenGuards;
    const elseGuards = guardsConditionTransitive(expr.alternate, checkAtom, fns, fnScopes, visited);
    if (isLitBool(expr.consequent, false)) return elseGuards;
    return thenGuards && elseGuards;
  }
  const atomResult = checkAtom(expr);
  if (atomResult !== null) return atomResult;

  let found = false;
  walkExpr(expr, (e) => {
    if (found || e.type !== 'functionCall') return;
    const fn = fns.get(e.name);
    if (!fn || visited.has(fn)) return;
    const nextVisited = new Set(visited);
    nextVisited.add(fn);
    const calleeScope = fnScopes.get(fn) ?? fns;
    const body = expandCalledFunction(fn, e.args);
    if (guardsConditionTransitive(body, checkAtom, calleeScope, fnScopes, nextVisited)) {
      found = true;
    }
  });
  return found;
}

function checkAuthAtom(expr: Expression): boolean | null {
  if (expr.type === 'unaryOp' && expr.op === '!') {
    if (isAuthComparisonWithNull(expr.operand, '==')) return true;
    if (isAuthComparisonWithNull(expr.operand, '!=')) return false;
    return false;
  }
  if (isAuthComparisonWithNull(expr, '==')) return false;
  if (exprContains(expr, isRequestAuth)) return true;
  return null;
}

function checkPathUidAtom(expr: Expression, pathVars: ReadonlySet<string>): boolean | null {
  if (expr.type === 'unaryOp' && expr.op === '!') {
    if (isAuthUidComparisonWithPathVar(expr.operand, '!=', pathVars)) return true;
    return false;
  }
  if (isAuthUidComparisonWithPathVar(expr, '==', pathVars)) return true;
  return null;
}

function checkRequestDataAtom(expr: Expression, isStorage = false): boolean | null {
  const targetPred = isStorage ? isRequestResource : isRequestResourceData;
  if (exprContains(expr, targetPred)) return true;
  return null;
}

export function guardsAuthTransitive(
  expr: Expression,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
): boolean {
  return guardsConditionTransitive(expr, checkAuthAtom, fns, fnScopes);
}

export function guardsPathUidTransitive(
  expr: Expression,
  pathVars: ReadonlySet<string>,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
): boolean {
  if (pathVars.size === 0) return false;
  return guardsConditionTransitive(expr, (e) => checkPathUidAtom(e, pathVars), fns, fnScopes);
}

export function validatesRequestDataTransitive(
  expr: Expression,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  isStorage = false,
): boolean {
  return guardsConditionTransitive(expr, (e) => checkRequestDataAtom(e, isStorage), fns, fnScopes);
}

function referencesExprAnyTransitive(
  expr: Expression,
  pred: (e: Expression) => boolean,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  visited = new Set<FunctionDef>(),
): boolean {
  if (exprContains(expr, pred)) return true;
  let found = false;
  walkExpr(expr, (e) => {
    if (found || e.type !== 'functionCall') return;
    const fn = fns.get(e.name);
    if (!fn || visited.has(fn)) return;
    visited.add(fn);
    const calleeScope = fnScopes.get(fn) ?? fns;
    if (functionExpressions(fn).some((x) => referencesExprAnyTransitive(x, pred, calleeScope, fnScopes, visited))) {
      found = true;
    }
  });
  return found;
}

export function referencesRequestDataAnyTransitive(
  expr: Expression,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
): boolean {
  return referencesExprAnyTransitive(expr, isRequestResourceData, fns, fnScopes);
}

export function referencesResourceDataAnyTransitive(
  expr: Expression,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
): boolean {
  return referencesExprAnyTransitive(expr, isResourceData, fns, fnScopes);
}
