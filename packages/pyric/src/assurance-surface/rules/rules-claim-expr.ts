/**
 * Firestore and Cloud Storage Security Rules AST expression visitor for
 * required `request.auth.token` claims.
 */
import {
  topLevelMatches,
  type Expression,
  type FirestoreRules,
  type FunctionDef,
  type LetBinding,
  type MatchBlock,
  type Operation,
} from '../../rules/internal/index.js';
import {
  intersectClaimList,
  nestedClaim,
  presenceClaim,
  STANDARD_CLAIMS,
  unionClaims,
  type Claims,
} from './claim-algebra.js';

const MAX_INLINE_DEPTH = 6;

export function indexFunctionScopes(ast: FirestoreRules): WeakMap<FunctionDef, FunctionDef[]> {
  const scopes = new WeakMap<FunctionDef, FunctionDef[]>();
  const globalFns = [...(ast.functions ?? [])];
  for (const fn of globalFns) scopes.set(fn, globalFns);

  let services = [ast.service];
  if (ast.services && ast.services.length > 0) services = ast.services;
  const walkBlock = (block: MatchBlock, parent: FunctionDef[]): void => {
    const current = [...parent, ...block.functions];
    for (const fn of block.functions) scopes.set(fn, current);
    for (const child of block.children) walkBlock(child, current);
  };
  for (const service of services) {
    const serviceScope = [...globalFns, ...(service.functions ?? [])];
    for (const fn of service.functions ?? []) scopes.set(fn, serviceScope);
    for (const topMatch of topLevelMatches(service)) {
      walkBlock(topMatch, serviceScope);
    }
  }
  return scopes;
}

export function allowCoversOp(operations: Operation[], targetOp: string | undefined): boolean {
  if (!targetOp) return true;
  for (const op of operations) {
    if (op === targetOp) return true;
    if (op === 'read' && (targetOp === 'get' || targetOp === 'list' || targetOp === 'query')) return true;
    if (op === 'write' && (targetOp === 'create' || targetOp === 'update' || targetOp === 'delete' || targetOp === 'set')) {
      return true;
    }
  }
  return false;
}

function findInScope(functions: FunctionDef[], name: string): FunctionDef | undefined {
  for (let i = functions.length - 1; i >= 0; i--) {
    if (functions[i]!.name === name) return functions[i];
  }
  return undefined;
}

function resolveBoundIdent(expr: Expression, lets: ReadonlyMap<string, Expression>): Expression {
  if (expr.type === 'identifier') {
    return lets.get(expr.name) ?? expr;
  }
  return expr;
}

function resolveValueExpr(
  rawExpr: Expression,
  functions: FunctionDef[],
  lets: ReadonlyMap<string, Expression>,
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
): Expression {
  const expr = resolveBoundIdent(rawExpr, lets);
  if (expr.type === 'functionCall' && depth < MAX_INLINE_DEPTH) {
    const fn = findInScope(functions, expr.name);
    if (fn && fn.parameters.length === expr.args.length) {
      const paramMap = new Map<string, Expression>();
      for (let i = 0; i < fn.parameters.length; i += 1) {
        paramMap.set(
          fn.parameters[i]!,
          resolveValueExpr(expr.args[i]!, functions, lets, declScopes, depth + 1),
        );
      }
      const fnScope = declScopes.get(fn) ?? functions;
      const fnLets = buildLetMap(fn.lets, paramMap, fnScope, declScopes, depth + 1);
      return resolveValueExpr(fn.body, fnScope, fnLets, declScopes, depth + 1);
    }
  }
  return expr;
}

function buildLetMap(
  bindings: LetBinding[],
  base: ReadonlyMap<string, Expression>,
  functions: FunctionDef[],
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
): Map<string, Expression> {
  const next = new Map(base);
  for (const binding of bindings) {
    next.set(binding.name, resolveValueExpr(binding.value, functions, next, declScopes, depth));
  }
  return next;
}

function fsStaticBool(
  rawExpr: Expression,
  functions: FunctionDef[],
  lets: ReadonlyMap<string, Expression>,
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
): boolean | undefined {
  const expr = resolveValueExpr(rawExpr, functions, lets, declScopes, depth);
  if (expr.type === 'literal' && typeof expr.value === 'boolean') return expr.value;
  if (expr.type === 'unaryOp' && expr.op === '!') {
    const inner = fsStaticBool(expr.operand, functions, lets, declScopes, depth + 1);
    if (inner === undefined) return undefined;
    return !inner;
  }
  return undefined;
}

export function fsEffectiveBool(
  rawExpr: Expression,
  functions: FunctionDef[],
  lets: ReadonlyMap<string, Expression>,
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
  negated: boolean,
): boolean | undefined {
  const raw = fsStaticBool(rawExpr, functions, lets, declScopes, depth);
  if (raw === undefined) return undefined;
  if (negated) return !raw;
  return raw;
}

function fsMemberOrStringKey(
  expr: Expression,
  functions: FunctionDef[],
  lets: ReadonlyMap<string, Expression>,
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
): { object: Expression; key: string } | undefined {
  if (expr.type === 'memberAccess') {
    return { object: expr.object, key: expr.property };
  }
  if (expr.type === 'bracketAccess') {
    const idx = resolveValueExpr(expr.index, functions, lets, declScopes, depth);
    if (idx.type === 'literal' && typeof idx.value === 'string') {
      return { object: expr.object, key: idx.value };
    }
  }
  return undefined;
}

function isFsAuthToken(
  expr: Expression,
  functions: FunctionDef[],
  lets: ReadonlyMap<string, Expression>,
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
): boolean {
  const unwrapped = resolveValueExpr(expr, functions, lets, declScopes, depth);
  const tokenAccess = fsMemberOrStringKey(unwrapped, functions, lets, declScopes, depth);
  if (!tokenAccess || tokenAccess.key !== 'token') return false;
  const auth = resolveValueExpr(tokenAccess.object, functions, lets, declScopes, depth);
  const authAccess = fsMemberOrStringKey(auth, functions, lets, declScopes, depth);
  if (!authAccess || authAccess.key !== 'auth') return false;
  const req = resolveValueExpr(authAccess.object, functions, lets, declScopes, depth);
  return req.type === 'identifier' && req.name === 'request';
}

function isFsAuthTokenKeys(
  expr: Expression,
  functions: FunctionDef[],
  lets: ReadonlyMap<string, Expression>,
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
): boolean {
  const unwrapped = resolveValueExpr(expr, functions, lets, declScopes, depth);
  if (unwrapped.type !== 'methodCall' || unwrapped.method !== 'keys' || unwrapped.args.length !== 0) {
    return false;
  }
  return isFsAuthToken(unwrapped.object, functions, lets, declScopes, depth);
}

function fsTokenClaimPath(
  expr: Expression,
  functions: FunctionDef[],
  lets: ReadonlyMap<string, Expression>,
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
): readonly string[] | undefined {
  const unwrapped = resolveValueExpr(expr, functions, lets, declScopes, depth);
  if (
    unwrapped.type === 'methodCall'
    && unwrapped.method === 'get'
    && unwrapped.args.length >= 1
    && unwrapped.args.length <= 2
    && isFsAuthToken(unwrapped.object, functions, lets, declScopes, depth)
  ) {
    const keyArg = resolveValueExpr(unwrapped.args[0]!, functions, lets, declScopes, depth);
    if (keyArg.type === 'literal' && typeof keyArg.value === 'string' && keyArg.value.length > 0) {
      return [keyArg.value];
    }
    if (keyArg.type === 'listLiteral' && keyArg.elements.length > 0) {
      const segs: string[] = [];
      for (const rawEl of keyArg.elements) {
        const el = resolveValueExpr(rawEl, functions, lets, declScopes, depth);
        if (el.type !== 'literal' || typeof el.value !== 'string' || el.value.length === 0) {
          return undefined;
        }
        segs.push(el.value);
      }
      return segs;
    }
    return undefined;
  }
  const access = fsMemberOrStringKey(unwrapped, functions, lets, declScopes, depth);
  if (!access) return undefined;
  if (isFsAuthToken(access.object, functions, lets, declScopes, depth)) {
    return [access.key];
  }
  return undefined;
}

export function fsExprClaims(
  rawExpr: Expression,
  functions: FunctionDef[],
  lets: ReadonlyMap<string, Expression>,
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
  negated: boolean,
): Claims {
  const expr = resolveBoundIdent(rawExpr, lets);
  if (expr.type === 'unaryOp') {
    if (expr.op === '!') {
      return fsExprClaims(expr.operand, functions, lets, declScopes, depth, !negated);
    }
    return {};
  }
  if (expr.type === 'binaryOp' && ((expr.op === '&&' && !negated) || (expr.op === '||' && negated))) {
    const left = fsExprClaims(expr.left, functions, lets, declScopes, depth, negated);
    const right = fsExprClaims(expr.right, functions, lets, declScopes, depth, negated);
    return unionClaims(left, right);
  }
  if (expr.type === 'binaryOp' && ((expr.op === '||' && !negated) || (expr.op === '&&' && negated))) {
    const branches: Claims[] = [];
    if (fsEffectiveBool(expr.left, functions, lets, declScopes, depth, negated) !== false) {
      branches.push(fsExprClaims(expr.left, functions, lets, declScopes, depth, negated));
    }
    if (fsEffectiveBool(expr.right, functions, lets, declScopes, depth, negated) !== false) {
      branches.push(fsExprClaims(expr.right, functions, lets, declScopes, depth, negated));
    }
    return intersectClaimList(branches);
  }
  if (expr.type === 'ternary') {
    const effCons = fsEffectiveBool(expr.consequent, functions, lets, declScopes, depth, negated);
    const effAlt = fsEffectiveBool(expr.alternate, functions, lets, declScopes, depth, negated);
    if (effCons === false && effAlt === false) return {};
    if (effAlt === false) {
      return unionClaims(
        fsExprClaims(expr.condition, functions, lets, declScopes, depth, false),
        fsExprClaims(expr.consequent, functions, lets, declScopes, depth, negated),
      );
    }
    if (effCons === false) {
      return unionClaims(
        fsExprClaims(expr.condition, functions, lets, declScopes, depth, true),
        fsExprClaims(expr.alternate, functions, lets, declScopes, depth, negated),
      );
    }
    const thenBranch = unionClaims(
      fsExprClaims(expr.condition, functions, lets, declScopes, depth, false),
      fsExprClaims(expr.consequent, functions, lets, declScopes, depth, negated),
    );
    const elseBranch = unionClaims(
      fsExprClaims(expr.condition, functions, lets, declScopes, depth, true),
      fsExprClaims(expr.alternate, functions, lets, declScopes, depth, negated),
    );
    return intersectClaimList([thenBranch, elseBranch]);
  }
  if (expr.type === 'binaryOp' && (expr.op === '==' || expr.op === '!=')) {
    const leftClaim = fsTokenClaimPath(expr.left, functions, lets, declScopes, depth);
    const claimPath = leftClaim ?? fsTokenClaimPath(expr.right, functions, lets, declScopes, depth);
    if (claimPath && claimPath.length > 0) {
      if (STANDARD_CLAIMS.has(claimPath[0]!)) return {};
      let otherExpr = expr.left;
      if (leftClaim) otherExpr = expr.right;
      const other = resolveValueExpr(otherExpr, functions, lets, declScopes, depth);
      if (other.type !== 'literal') return {};
      const isPosEq = (expr.op === '==' && !negated) || (expr.op === '!=' && negated);
      const isPosNeq = (expr.op === '!=' && !negated) || (expr.op === '==' && negated);
      if (isPosNeq && other.value === null) return nestedClaim(claimPath, true, true);
      if (
        isPosNeq
        && typeof other.value === 'boolean'
        && claimPath.length === 1
        && claimPath[0] === 'email_verified'
      ) {
        return nestedClaim(claimPath, !other.value, false);
      }
      if (isPosEq && other.value !== null && !(other.value instanceof Uint8Array)) {
        return nestedClaim(claimPath, other.value, false);
      }
      return {};
    }
    const leftBool = fsStaticBool(expr.left, functions, lets, declScopes, depth);
    const rightBool = fsStaticBool(expr.right, functions, lets, declScopes, depth);
    if (leftBool !== undefined || rightBool !== undefined) {
      const boolVal = leftBool ?? rightBool ?? false;
      let target = expr.left;
      if (leftBool !== undefined) target = expr.right;
      const flips = (expr.op === '==' && !boolVal) || (expr.op === '!=' && boolVal);
      let nextNegated = negated;
      if (flips) nextNegated = !negated;
      return fsExprClaims(target, functions, lets, declScopes, depth, nextNegated);
    }
    return {};
  }
  if (expr.type === 'inExpr') {
    if (!negated) {
      const elemClaim = fsTokenClaimPath(expr.element, functions, lets, declScopes, depth);
      if (elemClaim && elemClaim.length > 0 && !STANDARD_CLAIMS.has(elemClaim[0]!)) {
        const col = resolveValueExpr(expr.collection, functions, lets, declScopes, depth);
        if (col.type === 'listLiteral') {
          for (const rawItem of col.elements) {
            const item = resolveValueExpr(rawItem, functions, lets, declScopes, depth);
            if (item.type === 'literal' && item.value !== null && !(item.value instanceof Uint8Array)) {
              return nestedClaim(elemClaim, item.value, false);
            }
          }
        }
      }
      if (
        isFsAuthToken(expr.collection, functions, lets, declScopes, depth)
        || isFsAuthTokenKeys(expr.collection, functions, lets, declScopes, depth)
      ) {
        const keyExpr = resolveValueExpr(expr.element, functions, lets, declScopes, depth);
        if (
          keyExpr.type === 'literal'
          && typeof keyExpr.value === 'string'
          && !STANDARD_CLAIMS.has(keyExpr.value)
        ) {
          return presenceClaim(keyExpr.value);
        }
      }
    }
    return {};
  }
  if (expr.type === 'methodCall') {
    if (
      !negated
      && (expr.method === 'hasAll' || expr.method === 'hasAny')
      && expr.args.length === 1
      && isFsAuthTokenKeys(expr.object, functions, lets, declScopes, depth)
    ) {
      const listArg = resolveValueExpr(expr.args[0]!, functions, lets, declScopes, depth);
      if (listArg.type === 'listLiteral') {
        let acc: Claims = {};
        for (const rawEl of listArg.elements) {
          const el = resolveValueExpr(rawEl, functions, lets, declScopes, depth);
          if (
            el.type === 'literal'
            && typeof el.value === 'string'
            && el.value.length > 0
            && !STANDARD_CLAIMS.has(el.value)
          ) {
            acc = unionClaims(acc, presenceClaim(el.value));
            if (expr.method === 'hasAny') return acc;
          }
        }
        return acc;
      }
    }
  }
  if (expr.type === 'functionCall' && depth < MAX_INLINE_DEPTH) {
    const fn = findInScope(functions, expr.name);
    if (fn && fn.parameters.length === expr.args.length) {
      const paramMap = new Map<string, Expression>();
      for (let i = 0; i < fn.parameters.length; i += 1) {
        paramMap.set(
          fn.parameters[i]!,
          resolveValueExpr(expr.args[i]!, functions, lets, declScopes, depth + 1),
        );
      }
      const fnScope = declScopes.get(fn) ?? functions;
      const fnLets = buildLetMap(fn.lets, paramMap, fnScope, declScopes, depth + 1);
      return fsExprClaims(fn.body, fnScope, fnLets, declScopes, depth + 1, negated);
    }
    return {};
  }
  const bare = fsTokenClaimPath(expr, functions, lets, declScopes, depth);
  if (bare && bare.length > 0 && !STANDARD_CLAIMS.has(bare[0]!)) {
    if (negated) {
      if (bare.length === 1 && bare[0] === 'email_verified') {
        return nestedClaim(bare, false, false);
      }
      return {};
    }
    return nestedClaim(bare, true, true);
  }
  return {};
}
