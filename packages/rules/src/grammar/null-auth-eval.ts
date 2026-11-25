import type { Expression, FunctionDef } from './FirestoreAST.js';

/**
 * Abstract value of an expression when `request.auth == null` (signed-out request).
 * Tracks exact boolean possibilities `(canBeTrue, canBeFalse)` so CEL commutative
 * error absorption (`error || true`, `!(error && false)`) and negated/folded auth
 * predicates (`isSignedIn() == false`, `(request.auth == null) == true`,
 * `request.auth in [null]`, `request.auth == null || true`) are classified soundly.
 */
type NullAuthValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'request' }
  | { readonly kind: 'scalar'; readonly value: string | number | Uint8Array }
  | { readonly kind: 'list'; readonly elements: readonly NullAuthValue[] }
  | { readonly kind: 'map' }
  | { readonly kind: 'path' }
  | { readonly kind: 'error' }
  | { readonly kind: 'bool'; readonly canBeTrue: boolean; readonly canBeFalse: boolean }
  | { readonly kind: 'unknown' };

const VAL_NULL: NullAuthValue = { kind: 'null' };
const VAL_REQUEST: NullAuthValue = { kind: 'request' };
const VAL_ERROR: NullAuthValue = { kind: 'error' };
const VAL_UNKNOWN: NullAuthValue = { kind: 'unknown' };
const VAL_TRUE: NullAuthValue = { kind: 'bool', canBeTrue: true, canBeFalse: false };
const VAL_FALSE: NullAuthValue = { kind: 'bool', canBeTrue: false, canBeFalse: true };

function boolValue(flag: boolean): NullAuthValue {
  if (flag) return VAL_TRUE;
  return VAL_FALSE;
}

function makeBoolOrError(canBeTrue: boolean, canBeFalse: boolean): NullAuthValue {
  if (!canBeTrue && !canBeFalse) return VAL_ERROR;
  return { kind: 'bool', canBeTrue, canBeFalse };
}

function isErrorValue(val: NullAuthValue): boolean {
  if (val.kind === 'error') return true;
  if (val.kind === 'bool' && !val.canBeTrue && !val.canBeFalse) return true;
  return false;
}

function boolCapabilities(val: NullAuthValue): { canBeTrue: boolean; canBeFalse: boolean } {
  if (val.kind === 'bool') return { canBeTrue: val.canBeTrue, canBeFalse: val.canBeFalse };
  if (val.kind === 'unknown') return { canBeTrue: true, canBeFalse: true };
  return { canBeTrue: false, canBeFalse: false };
}

function scalarsEqual(a: string | number | Uint8Array, b: string | number | Uint8Array): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  return a === b;
}

function evalEqualityNullAuth(
  left: NullAuthValue,
  right: NullAuthValue,
  invert: boolean,
): NullAuthValue {
  if (isErrorValue(left) || isErrorValue(right)) return VAL_ERROR;
  if (left.kind === 'unknown' || right.kind === 'unknown') return VAL_UNKNOWN;

  let canEq = false;
  let canNeq = false;

  if (left.kind === 'null' && right.kind === 'null') {
    canEq = true;
  } else if (left.kind === 'null' || right.kind === 'null') {
    canNeq = true;
  } else if (left.kind === 'bool' && right.kind === 'bool') {
    if (!left.canBeTrue && !left.canBeFalse) return VAL_ERROR;
    if (!right.canBeTrue && !right.canBeFalse) return VAL_ERROR;
    canEq = (left.canBeTrue && right.canBeTrue) || (left.canBeFalse && right.canBeFalse);
    canNeq = (left.canBeTrue && right.canBeFalse) || (left.canBeFalse && right.canBeTrue);
  } else if (left.kind === 'scalar' && right.kind === 'scalar') {
    if (scalarsEqual(left.value, right.value)) {
      canEq = true;
    } else {
      canNeq = true;
    }
  } else if (left.kind !== right.kind) {
    canNeq = true;
  } else {
    return VAL_UNKNOWN;
  }

  if (invert) {
    return { kind: 'bool', canBeTrue: canNeq, canBeFalse: canEq };
  }
  return { kind: 'bool', canBeTrue: canEq, canBeFalse: canNeq };
}

function evalInListNullAuth(el: NullAuthValue, items: readonly NullAuthValue[]): NullAuthValue {
  let sawMatch = false;
  let sawUncertain = false;
  for (const item of items) {
    const eq = evalEqualityNullAuth(el, item, false);
    if (eq.kind === 'unknown') {
      sawUncertain = true;
    } else if (eq.kind === 'bool') {
      if (eq.canBeTrue && !eq.canBeFalse) {
        sawMatch = true;
      } else if (eq.canBeTrue) {
        sawUncertain = true;
      }
    }
  }
  if (sawMatch) return VAL_TRUE;
  if (sawUncertain) return VAL_UNKNOWN;
  return VAL_FALSE;
}

function evalIsExprNullAuth(val: NullAuthValue, typeName: string): NullAuthValue {
  if (val.kind === 'error') return VAL_ERROR;
  if (val.kind === 'null') return boolValue(typeName === 'null');
  if (val.kind === 'bool') {
    if (!val.canBeTrue && !val.canBeFalse) return VAL_ERROR;
    return boolValue(typeName === 'bool');
  }
  if (val.kind === 'list') return boolValue(typeName === 'list');
  if (val.kind === 'map') return boolValue(typeName === 'map');
  if (val.kind === 'path') return boolValue(typeName === 'path');
  if (val.kind === 'scalar') {
    if (typeof val.value === 'string') return boolValue(typeName === 'string');
    if (val.value instanceof Uint8Array) return boolValue(typeName === 'bytes');
    if (typeName === 'number') return VAL_TRUE;
    if (typeName === 'int' || typeName === 'float') return VAL_UNKNOWN;
    return VAL_FALSE;
  }
  return VAL_UNKNOWN;
}

function evalNullAuth(
  expr: Expression,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  env: ReadonlyMap<string, NullAuthValue>,
  visited: ReadonlySet<FunctionDef>,
): NullAuthValue {
  switch (expr.type) {
    case 'literal': {
      if (expr.value === null) return VAL_NULL;
      if (typeof expr.value === 'boolean') return boolValue(expr.value);
      return { kind: 'scalar', value: expr.value };
    }
    case 'identifier': {
      const bound = env.get(expr.name);
      if (bound !== undefined) return bound;
      if (expr.name === 'request') return VAL_REQUEST;
      return VAL_UNKNOWN;
    }
    case 'memberAccess': {
      const obj = evalNullAuth(expr.object, fns, fnScopes, env, visited);
      if (obj.kind === 'request') {
        if (expr.property === 'auth') return VAL_NULL;
        return VAL_UNKNOWN;
      }
      if (obj.kind === 'unknown' || obj.kind === 'map') return VAL_UNKNOWN;
      return VAL_ERROR;
    }
    case 'bracketAccess': {
      const obj = evalNullAuth(expr.object, fns, fnScopes, env, visited);
      const idx = evalNullAuth(expr.index, fns, fnScopes, env, visited);
      if (obj.kind === 'error' || idx.kind === 'error') return VAL_ERROR;
      if (obj.kind === 'request') {
        if (idx.kind === 'scalar' && idx.value === 'auth') return VAL_NULL;
        return VAL_UNKNOWN;
      }
      if (obj.kind === 'unknown' || obj.kind === 'map' || obj.kind === 'list') return VAL_UNKNOWN;
      return VAL_ERROR;
    }
    case 'sliceAccess': {
      const obj = evalNullAuth(expr.object, fns, fnScopes, env, visited);
      const start = evalNullAuth(expr.start, fns, fnScopes, env, visited);
      const end = evalNullAuth(expr.end, fns, fnScopes, env, visited);
      if (obj.kind === 'error' || start.kind === 'error' || end.kind === 'error') return VAL_ERROR;
      if (obj.kind === 'unknown' || obj.kind === 'list' || obj.kind === 'scalar') {
        return VAL_UNKNOWN;
      }
      return VAL_ERROR;
    }
    case 'pathLiteral': {
      for (const seg of expr.segments) {
        if (typeof seg !== 'string') {
          const v = evalNullAuth(seg, fns, fnScopes, env, visited);
          if (v.kind === 'error') return VAL_ERROR;
        }
      }
      return { kind: 'path' };
    }
    case 'listLiteral': {
      const elements: NullAuthValue[] = [];
      for (const item of expr.elements) {
        const v = evalNullAuth(item, fns, fnScopes, env, visited);
        if (v.kind === 'error') return VAL_ERROR;
        elements.push(v);
      }
      return { kind: 'list', elements };
    }
    case 'mapLiteral': {
      for (const entry of expr.entries) {
        const k = evalNullAuth(entry.key, fns, fnScopes, env, visited);
        const v = evalNullAuth(entry.value, fns, fnScopes, env, visited);
        if (k.kind === 'error' || v.kind === 'error') return VAL_ERROR;
      }
      return { kind: 'map' };
    }
    case 'methodCall': {
      const obj = evalNullAuth(expr.object, fns, fnScopes, env, visited);
      if (obj.kind === 'error' || obj.kind === 'null') return VAL_ERROR;
      for (const arg of expr.args) {
        if (evalNullAuth(arg, fns, fnScopes, env, visited).kind === 'error') return VAL_ERROR;
      }
      return VAL_UNKNOWN;
    }
    case 'functionCall': {
      const argVals = expr.args.map((arg) => evalNullAuth(arg, fns, fnScopes, env, visited));
      const fn = fns.get(expr.name);
      if (fn !== undefined) {
        if (fn.parameters.length !== argVals.length || visited.has(fn)) return VAL_UNKNOWN;
        const nextVisited = new Set(visited);
        nextVisited.add(fn);
        const calleeScope = fnScopes.get(fn) ?? fns;
        const fnEnv = new Map<string, NullAuthValue>();
        for (let i = 0; i < fn.parameters.length; i++) {
          const param = fn.parameters[i];
          const val = argVals[i];
          if (param !== undefined && val !== undefined) fnEnv.set(param, val);
        }
        for (const binding of fn.lets) {
          fnEnv.set(
            binding.name,
            evalNullAuth(binding.value, calleeScope, fnScopes, fnEnv, nextVisited),
          );
        }
        return evalNullAuth(fn.body, calleeScope, fnScopes, fnEnv, nextVisited);
      }
      if (argVals.some((v) => v.kind === 'error')) return VAL_ERROR;
      return VAL_UNKNOWN;
    }
    case 'isExpr': {
      const val = evalNullAuth(expr.value, fns, fnScopes, env, visited);
      return evalIsExprNullAuth(val, expr.typeName);
    }
    case 'inExpr': {
      const el = evalNullAuth(expr.element, fns, fnScopes, env, visited);
      const col = evalNullAuth(expr.collection, fns, fnScopes, env, visited);
      if (el.kind === 'error' || col.kind === 'error' || col.kind === 'null') return VAL_ERROR;
      if (col.kind === 'list') return evalInListNullAuth(el, col.elements);
      return VAL_UNKNOWN;
    }
    case 'unaryOp': {
      const opnd = evalNullAuth(expr.operand, fns, fnScopes, env, visited);
      if (opnd.kind === 'error') return VAL_ERROR;
      if (expr.op === '!') {
        const cap = boolCapabilities(opnd);
        if (!cap.canBeTrue && !cap.canBeFalse) return VAL_ERROR;
        return { kind: 'bool', canBeTrue: cap.canBeFalse, canBeFalse: cap.canBeTrue };
      }
      if (opnd.kind === 'scalar' && typeof opnd.value === 'number') {
        return { kind: 'scalar', value: -opnd.value };
      }
      if (opnd.kind === 'unknown') return VAL_UNKNOWN;
      return VAL_ERROR;
    }
    case 'ternary': {
      const cond = boolCapabilities(evalNullAuth(expr.condition, fns, fnScopes, env, visited));
      if (!cond.canBeTrue && !cond.canBeFalse) return VAL_ERROR;
      if (cond.canBeTrue && !cond.canBeFalse) {
        return evalNullAuth(expr.consequent, fns, fnScopes, env, visited);
      }
      if (cond.canBeFalse && !cond.canBeTrue) {
        return evalNullAuth(expr.alternate, fns, fnScopes, env, visited);
      }
      const consVal = evalNullAuth(expr.consequent, fns, fnScopes, env, visited);
      const altVal = evalNullAuth(expr.alternate, fns, fnScopes, env, visited);
      if (isErrorValue(consVal) && isErrorValue(altVal)) return VAL_ERROR;
      if (consVal.kind === 'null' && altVal.kind === 'null') return VAL_NULL;
      if (
        consVal.kind === 'scalar' &&
        altVal.kind === 'scalar' &&
        scalarsEqual(consVal.value, altVal.value)
      ) {
        return consVal;
      }
      const consBoolLike = consVal.kind === 'bool' || isErrorValue(consVal);
      const altBoolLike = altVal.kind === 'bool' || isErrorValue(altVal);
      if (consBoolLike && altBoolLike) {
        const consCap = boolCapabilities(consVal);
        const altCap = boolCapabilities(altVal);
        return makeBoolOrError(
          consCap.canBeTrue || altCap.canBeTrue,
          consCap.canBeFalse || altCap.canBeFalse,
        );
      }
      return VAL_UNKNOWN;
    }
    case 'binaryOp': {
      const left = evalNullAuth(expr.left, fns, fnScopes, env, visited);
      const right = evalNullAuth(expr.right, fns, fnScopes, env, visited);
      if (expr.op === '&&') {
        const lCap = boolCapabilities(left);
        const rCap = boolCapabilities(right);
        return makeBoolOrError(
          lCap.canBeTrue && rCap.canBeTrue,
          lCap.canBeFalse || rCap.canBeFalse,
        );
      }
      if (expr.op === '||') {
        const lCap = boolCapabilities(left);
        const rCap = boolCapabilities(right);
        return makeBoolOrError(
          lCap.canBeTrue || rCap.canBeTrue,
          lCap.canBeFalse && rCap.canBeFalse,
        );
      }
      if (expr.op === '==') return evalEqualityNullAuth(left, right, false);
      if (expr.op === '!=') return evalEqualityNullAuth(left, right, true);
      if (
        left.kind === 'error' ||
        right.kind === 'error' ||
        left.kind === 'null' ||
        right.kind === 'null'
      ) {
        return VAL_ERROR;
      }
      return VAL_UNKNOWN;
    }
  }
}

export function canEvaluateTrueUnderNullAuth(
  expr: Expression,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
): boolean {
  const outcome = boolCapabilities(evalNullAuth(expr, fns, fnScopes, new Map(), new Set()));
  return outcome.canBeTrue;
}
