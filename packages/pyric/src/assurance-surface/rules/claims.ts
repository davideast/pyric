/**
 * Token claims the rules require of a caller for a target path and operation
 * (`auth.token.hasAccess != null` on every granting route), so probe actors
 * carry required gates without receiving disjunctive escape-hatch claims
 * (`|| auth.token.admin == true`) or claims from unrelated paths.
 */
import {
  collectRootMatches,
  parseToAST,
  topLevelMatches,
  type Expression,
  type FirestoreRules,
  type FunctionDef,
  type LetBinding,
  type MatchBlock,
  type Operation,
} from '../../rules/internal/index.js';
import { parseRtdbExpressionTree, type RtdbExpressionTree } from '../../rules/internal/rtdb.js';
import {
  extractServiceHeader,
  normalizeExplicitResourceId,
} from '../../sandbox/internal/resource-pattern-header.js';
import { overlapsPattern, parseResourcePattern } from '../../sandbox/internal/resource-pattern.js';
import {
  formatMatchSegment,
  lowerModularRulesInMemory,
  parseRulesAstWithMultiMatch,
} from './rules-ast-utils.js';

/** Claims set on every Firebase ID token; never inferred as custom claims. */
const STANDARD_CLAIMS = new Set([
  'email',
  'email_verified',
  'name',
  'picture',
  'uid',
  'sub',
  'firebase',
  'phone_number',
  'sign_in_provider',
]);

const MAX_INLINE_DEPTH = 6;

export type Claims = Record<string, unknown>;

export interface ClaimTarget {
  path: string;
  op?: string;
  bucket?: string;
  modules?: Readonly<Record<string, string>>;
}

export interface RequiredClaimsOptions {
  readonly modules?: Readonly<Record<string, string>>;
}

function splitSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function setClaimOwn(target: Claims, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function singleClaim(key: string, value: unknown): Claims {
  const out: Claims = {};
  setClaimOwn(out, key, value);
  return out;
}

function unionClaims(left: Claims, right: Claims): Claims {
  const out: Claims = {};
  for (const key of Object.getOwnPropertyNames(left)) {
    if (STANDARD_CLAIMS.has(key)) continue;
    setClaimOwn(out, key, Object.getOwnPropertyDescriptor(left, key)?.value);
  }
  for (const key of Object.getOwnPropertyNames(right)) {
    if (STANDARD_CLAIMS.has(key) || Object.hasOwn(out, key)) continue;
    setClaimOwn(out, key, Object.getOwnPropertyDescriptor(right, key)?.value);
  }
  return out;
}

function intersectClaimList(list: Claims[]): Claims {
  if (list.length === 0) return {};
  const first = list[0];
  const out: Claims = {};
  for (const key of Object.getOwnPropertyNames(first)) {
    if (STANDARD_CLAIMS.has(key)) continue;
    const value = Object.getOwnPropertyDescriptor(first, key)?.value;
    const inAll = list
      .slice(1)
      .every(
        (item) =>
          Object.hasOwn(item, key)
          && Object.getOwnPropertyDescriptor(item, key)?.value === value,
      );
    if (inAll) setClaimOwn(out, key, value);
  }
  return out;
}

function copyClaimsInto(source: Claims, into: Claims): Claims {
  for (const key of Object.getOwnPropertyNames(source)) {
    if (STANDARD_CLAIMS.has(key) || Object.hasOwn(into, key)) continue;
    setClaimOwn(into, key, Object.getOwnPropertyDescriptor(source, key)?.value);
  }
  return into;
}

/** Required claims for a Realtime Database path and operation. */
export function rtdbRequiredClaims(rulesJson: unknown, target: ClaimTarget, into: Claims = {}): Claims {
  const root = (rulesJson as { rules?: unknown } | null)?.rules;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return into;

  const segments = splitSegments(target.path);
  const isRead = target.op === 'get' || target.op === 'query' || target.op === 'list' || target.op === 'read';
  const isDelete = target.op === 'delete' || target.op === 'remove';
  let permKey = '.write';
  if (isRead) permKey = '.read';

  const grantingBranches: Claims[] = [];
  let validateRequired: Claims = {};

  const walkPath = (node: unknown, index: number): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;

    const permValue = record[permKey];
    if (permValue === true) {
      grantingBranches.push({});
    } else if (typeof permValue === 'string') {
      const parsed = parseRtdbExpressionTree(permValue);
      if (parsed.ok && rtdbEffectiveBool(parsed.tree, false) !== false) {
        grantingBranches.push(rtdbExprClaims(parsed.tree, false));
      }
    }

    if (!isRead && !isDelete) {
      const validateValue = record['.validate'];
      if (typeof validateValue === 'string') {
        const parsed = parseRtdbExpressionTree(validateValue);
        if (parsed.ok) {
          validateRequired = unionClaims(validateRequired, rtdbExprClaims(parsed.tree, false));
        }
      }
    }

    if (index >= segments.length) return;
    const seg = segments[index];
    const isTemplateVar = seg.startsWith('$') || (seg.startsWith('{') && seg.endsWith('}'));
    if (!isTemplateVar && Object.hasOwn(record, seg) && !seg.startsWith('.') && !seg.startsWith('$')) {
      walkPath(record[seg], index + 1);
      return;
    }
    for (const [childKey, childVal] of Object.entries(record)) {
      if (childKey.startsWith('$')) {
        walkPath(childVal, index + 1);
      }
    }
  };

  walkPath(root, 0);
  const permRequired = intersectClaimList(grantingBranches);
  const combined = unionClaims(permRequired, validateRequired);
  return copyClaimsInto(combined, into);
}

function rtdbStaticBool(tree: RtdbExpressionTree): boolean | undefined {
  if (tree.type === 'boolean') return tree.value;
  if (tree.type === 'unary' && tree.operator === '!') {
    const inner = rtdbStaticBool(tree.argument);
    return inner === undefined ? undefined : !inner;
  }
  return undefined;
}

function rtdbEffectiveBool(tree: RtdbExpressionTree, negated: boolean): boolean | undefined {
  const raw = rtdbStaticBool(tree);
  if (raw === undefined) return undefined;
  return negated ? !raw : raw;
}

function isRtdbAuthToken(tree: RtdbExpressionTree): boolean {
  if (tree.type === 'member' && tree.property === 'token') {
    return tree.object.type === 'identifier' && tree.object.name === 'auth';
  }
  if (tree.type === 'index' && tree.index.type === 'string' && tree.index.value === 'token') {
    return tree.object.type === 'identifier' && tree.object.name === 'auth';
  }
  return false;
}

function rtdbTokenClaim(tree: RtdbExpressionTree): string | undefined {
  if (tree.type === 'member' && isRtdbAuthToken(tree.object)) {
    return tree.property;
  }
  if (tree.type === 'index' && tree.index.type === 'string' && isRtdbAuthToken(tree.object)) {
    return tree.index.value;
  }
  return undefined;
}

function rtdbLiteral(tree: RtdbExpressionTree): { value: unknown } | undefined {
  if (tree.type === 'string') return { value: tree.value };
  if (tree.type === 'boolean') return { value: tree.value };
  if (tree.type === 'number') return { value: Number(tree.raw) };
  return undefined;
}

function rtdbExprClaims(tree: RtdbExpressionTree, negated: boolean): Claims {
  if (tree.type === 'unary') {
    if (tree.operator === '!') return rtdbExprClaims(tree.argument, !negated);
    return {};
  }
  if (tree.type === 'binary' && ((tree.operator === '&&' && !negated) || (tree.operator === '||' && negated))) {
    return unionClaims(rtdbExprClaims(tree.left, negated), rtdbExprClaims(tree.right, negated));
  }
  if (tree.type === 'binary' && ((tree.operator === '||' && !negated) || (tree.operator === '&&' && negated))) {
    const branches: Claims[] = [];
    if (rtdbEffectiveBool(tree.left, negated) !== false) branches.push(rtdbExprClaims(tree.left, negated));
    if (rtdbEffectiveBool(tree.right, negated) !== false) branches.push(rtdbExprClaims(tree.right, negated));
    return intersectClaimList(branches);
  }
  if (tree.type === 'ternary') {
    const effCons = rtdbEffectiveBool(tree.consequent, negated);
    const effAlt = rtdbEffectiveBool(tree.alternate, negated);
    if (effCons === false && effAlt === false) return {};
    if (effAlt === false) {
      return unionClaims(rtdbExprClaims(tree.test, false), rtdbExprClaims(tree.consequent, negated));
    }
    if (effCons === false) {
      return unionClaims(rtdbExprClaims(tree.test, true), rtdbExprClaims(tree.alternate, negated));
    }
    const thenBranch = unionClaims(rtdbExprClaims(tree.test, false), rtdbExprClaims(tree.consequent, negated));
    const elseBranch = unionClaims(rtdbExprClaims(tree.test, true), rtdbExprClaims(tree.alternate, negated));
    return intersectClaimList([thenBranch, elseBranch]);
  }
  if (tree.type === 'binary') {
    const isEq = tree.operator === '==' || tree.operator === '===';
    const isNeq = tree.operator === '!=' || tree.operator === '!==';
    if (isEq || isNeq) {
      const leftClaim = rtdbTokenClaim(tree.left);
      const claim = leftClaim ?? rtdbTokenClaim(tree.right);
      if (claim) {
        if (STANDARD_CLAIMS.has(claim)) return {};
        let other = tree.left;
        if (leftClaim) other = tree.right;
        const isPosEq = (isEq && !negated) || (isNeq && negated);
        const isPosNeq = (isNeq && !negated) || (isEq && negated);
        if (isPosNeq && other.type === 'null') return singleClaim(claim, true);
        const lit = rtdbLiteral(other);
        if (isPosEq && lit) return singleClaim(claim, lit.value);
        return {};
      }
      const leftBool = rtdbStaticBool(tree.left);
      const rightBool = rtdbStaticBool(tree.right);
      if (leftBool !== undefined || rightBool !== undefined) {
        const boolVal = leftBool ?? rightBool ?? false;
        let target = tree.left;
        if (leftBool !== undefined) target = tree.right;
        const flips = (isEq && !boolVal) || (isNeq && boolVal);
        return rtdbExprClaims(target, flips ? !negated : negated);
      }
    }
    return {};
  }
  if (!negated) {
    const bare = rtdbTokenClaim(tree);
    if (bare && !STANDARD_CLAIMS.has(bare)) {
      return singleClaim(bare, true);
    }
  }
  return {};
}

/** Required claims for a Firestore document path and operation. */
export function firestoreRequiredClaims(
  source: string,
  target: ClaimTarget,
  into: Claims = {},
  options?: RequiredClaimsOptions,
): Claims {
  const modules = options?.modules ?? target.modules;
  const lowerOpts: {
    targetService: 'cloud.firestore';
    modules?: Readonly<Record<string, string>>;
  } = { targetService: 'cloud.firestore' };
  if (modules !== undefined) lowerOpts.modules = modules;
  const lowered = lowerModularRulesInMemory(source, lowerOpts);
  const ast = parseToAST(lowered);
  if (!ast) return into;

  const declScopes = indexFunctionScopes(ast);
  let services = [ast.service];
  if (ast.services && ast.services.length > 0) services = ast.services;

  const matchingAllows: Claims[] = [];
  for (const service of services) {
    if (!/firestore/.test(service.name)) continue;
    const rootScope = [
      ...(ast.functions ?? []),
      ...(service.functions ?? []),
    ];
    const scopedAst: FirestoreRules = { ...ast, service };
    const matches = collectRootMatches(scopedAst, target.path, rootScope);
    for (const match of matches) {
      for (const allow of match.block.allows) {
        if (!allowCoversOp(allow.operations, target.op)) continue;
        if (fsEffectiveBool(allow.condition, match.functions, new Map(), declScopes, 0, false) === false) continue;
        matchingAllows.push(fsExprClaims(allow.condition, match.functions, new Map(), declScopes, 0, false));
      }
    }
  }

  return copyClaimsInto(intersectClaimList(matchingAllows), into);
}

/** Required claims for a Cloud Storage object path and operation. */
export function storageRequiredClaims(
  source: string,
  target: ClaimTarget,
  into: Claims = {},
  options?: RequiredClaimsOptions,
): Claims {
  const modules = options?.modules ?? target.modules;
  const parseOpts: {
    targetService: 'firebase.storage';
    modules?: Readonly<Record<string, string>>;
  } = { targetService: 'firebase.storage' };
  if (modules !== undefined) parseOpts.modules = modules;
  const services = parseRulesAstWithMultiMatch(source, parseOpts);
  if (services.length === 0) return into;

  const targetPattern = parseResourcePattern('storage', target.path, target.bucket);
  const normalizedTargetBucket = normalizeExplicitResourceId('storage', target.bucket);
  const matchingAllows: Claims[] = [];

  for (const svc of services) {
    if (!/storage/.test(svc.name)) continue;
    const declScopes = new WeakMap<FunctionDef, FunctionDef[]>();
    const rootFns = svc.functions.flat();
    for (const fn of rootFns) declScopes.set(fn, rootFns);

    const walk = (block: MatchBlock, parentSegments: readonly string[], parentFns: FunctionDef[]): void => {
      const currentFns = [...parentFns, ...block.functions];
      for (const fn of block.functions) declScopes.set(fn, currentFns);
      const fullSegments = [...parentSegments, ...block.path.segments.map(formatMatchSegment)];
      const rawRulePath = `/${fullSegments.join('/')}`;
      const header = extractServiceHeader('storage', rawRulePath);
      if (
        normalizedTargetBucket !== undefined
        && header.headerKind === 'concrete'
        && header.headerResourceId !== normalizedTargetBucket
      ) {
        return;
      }
      if (header.headerKind === 'concrete' || header.headerKind === 'wildcard') {
        const rulePattern = parseResourcePattern('storage', rawRulePath, target.bucket);
        if (overlapsPattern(rulePattern, targetPattern)) {
          for (const allow of block.allows) {
            if (!allowCoversOp(allow.operations, target.op)) continue;
            if (fsEffectiveBool(allow.condition, currentFns, new Map(), declScopes, 0, false) === false) continue;
            matchingAllows.push(fsExprClaims(allow.condition, currentFns, new Map(), declScopes, 0, false));
          }
        }
      }
      for (const child of block.children) {
        walk(child, fullSegments, currentFns);
      }
    };

    for (const topMatch of svc.matches) {
      walk(topMatch, [], rootFns);
    }
  }

  return copyClaimsInto(intersectClaimList(matchingAllows), into);
}

function indexFunctionScopes(ast: FirestoreRules): WeakMap<FunctionDef, FunctionDef[]> {
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

function allowCoversOp(operations: Operation[], targetOp: string | undefined): boolean {
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
    if (functions[i].name === name) return functions[i];
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
    return inner === undefined ? undefined : !inner;
  }
  return undefined;
}

function fsEffectiveBool(
  rawExpr: Expression,
  functions: FunctionDef[],
  lets: ReadonlyMap<string, Expression>,
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
  negated: boolean,
): boolean | undefined {
  const raw = fsStaticBool(rawExpr, functions, lets, declScopes, depth);
  if (raw === undefined) return undefined;
  return negated ? !raw : raw;
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

function fsTokenClaim(
  expr: Expression,
  functions: FunctionDef[],
  lets: ReadonlyMap<string, Expression>,
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
): string | undefined {
  const unwrapped = resolveValueExpr(expr, functions, lets, declScopes, depth);
  const access = fsMemberOrStringKey(unwrapped, functions, lets, declScopes, depth);
  if (!access) return undefined;
  if (isFsAuthToken(access.object, functions, lets, declScopes, depth)) {
    return access.key;
  }
  return undefined;
}

function fsExprClaims(
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
    const leftClaim = fsTokenClaim(expr.left, functions, lets, declScopes, depth);
    const claim = leftClaim ?? fsTokenClaim(expr.right, functions, lets, declScopes, depth);
    if (claim) {
      if (STANDARD_CLAIMS.has(claim)) return {};
      let otherExpr = expr.left;
      if (leftClaim) otherExpr = expr.right;
      const other = resolveValueExpr(otherExpr, functions, lets, declScopes, depth);
      if (other.type !== 'literal') return {};
      const isPosEq = (expr.op === '==' && !negated) || (expr.op === '!=' && negated);
      const isPosNeq = (expr.op === '!=' && !negated) || (expr.op === '==' && negated);
      if (isPosNeq && other.value === null) return singleClaim(claim, true);
      if (isPosEq && other.value !== null && !(other.value instanceof Uint8Array)) {
        return singleClaim(claim, other.value);
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
      return fsExprClaims(target, functions, lets, declScopes, depth, flips ? !negated : negated);
    }
    return {};
  }
  if (expr.type === 'inExpr') {
    if (!negated) {
      const elemClaim = fsTokenClaim(expr.element, functions, lets, declScopes, depth);
      if (elemClaim && !STANDARD_CLAIMS.has(elemClaim)) {
        const col = resolveValueExpr(expr.collection, functions, lets, declScopes, depth);
        if (col.type === 'listLiteral') {
          for (const rawItem of col.elements) {
            const item = resolveValueExpr(rawItem, functions, lets, declScopes, depth);
            if (item.type === 'literal' && item.value !== null && !(item.value instanceof Uint8Array)) {
              return singleClaim(elemClaim, item.value);
            }
          }
        }
      }
      if (isFsAuthToken(expr.collection, functions, lets, declScopes, depth)) {
        const keyExpr = resolveValueExpr(expr.element, functions, lets, declScopes, depth);
        if (
          keyExpr.type === 'literal'
          && typeof keyExpr.value === 'string'
          && !STANDARD_CLAIMS.has(keyExpr.value)
        ) {
          return singleClaim(keyExpr.value, true);
        }
      }
    }
    return {};
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
  if (!negated) {
    const bare = fsTokenClaim(expr, functions, lets, declScopes, depth);
    if (bare && !STANDARD_CLAIMS.has(bare)) {
      return singleClaim(bare, true);
    }
  }
  return {};
}
