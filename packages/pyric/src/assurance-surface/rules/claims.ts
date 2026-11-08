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
import { extractServiceHeader } from '../../sandbox/internal/resource-pattern-header.js';
import { overlapsPattern, parseResourcePattern } from '../../sandbox/internal/resource-pattern.js';
import { formatMatchSegment, parseRulesAstWithMultiMatch } from './rules-ast-utils.js';

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
}

function splitSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function unionClaims(left: Claims, right: Claims): Claims {
  const out: Claims = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (STANDARD_CLAIMS.has(key) || Object.hasOwn(out, key)) continue;
    out[key] = value;
  }
  return out;
}

function intersectClaimList(list: Claims[]): Claims {
  if (list.length === 0) return {};
  const first = list[0];
  const out: Claims = {};
  for (const [key, value] of Object.entries(first)) {
    if (STANDARD_CLAIMS.has(key)) continue;
    const inAll = list.slice(1).every((item) => Object.hasOwn(item, key) && item[key] === value);
    if (inAll) out[key] = value;
  }
  return out;
}

function copyClaimsInto(source: Claims, into: Claims): Claims {
  for (const [key, value] of Object.entries(source)) {
    if (STANDARD_CLAIMS.has(key) || Object.hasOwn(into, key)) continue;
    into[key] = value;
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
      if (parsed.ok && !isRtdbFalseLiteral(parsed.tree)) {
        grantingBranches.push(rtdbExprClaims(parsed.tree));
      }
    }

    if (!isRead && !isDelete) {
      const validateValue = record['.validate'];
      if (typeof validateValue === 'string') {
        const parsed = parseRtdbExpressionTree(validateValue);
        if (parsed.ok) {
          validateRequired = unionClaims(validateRequired, rtdbExprClaims(parsed.tree));
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

function isRtdbFalseLiteral(tree: RtdbExpressionTree): boolean {
  return tree.type === 'boolean' && tree.value === false;
}

function rtdbTokenClaim(tree: RtdbExpressionTree): string | undefined {
  if (tree.type !== 'member') return undefined;
  const obj = tree.object;
  if (obj.type === 'member' && obj.property === 'token' && obj.object.type === 'identifier' && obj.object.name === 'auth') {
    return tree.property;
  }
  return undefined;
}

function rtdbLiteral(tree: RtdbExpressionTree): { value: unknown } | undefined {
  if (tree.type === 'string') return { value: tree.value };
  if (tree.type === 'boolean') return { value: tree.value };
  if (tree.type === 'number') return { value: Number(tree.raw) };
  return undefined;
}

function rtdbExprClaims(tree: RtdbExpressionTree): Claims {
  if (tree.type === 'binary' && tree.operator === '&&') {
    return unionClaims(rtdbExprClaims(tree.left), rtdbExprClaims(tree.right));
  }
  if (tree.type === 'binary' && tree.operator === '||') {
    const branches: Claims[] = [];
    if (!isRtdbFalseLiteral(tree.left)) branches.push(rtdbExprClaims(tree.left));
    if (!isRtdbFalseLiteral(tree.right)) branches.push(rtdbExprClaims(tree.right));
    return intersectClaimList(branches);
  }
  if (tree.type === 'ternary') {
    const thenBranch = unionClaims(rtdbExprClaims(tree.test), rtdbExprClaims(tree.consequent));
    if (isRtdbFalseLiteral(tree.alternate)) return thenBranch;
    if (isRtdbFalseLiteral(tree.consequent)) return rtdbExprClaims(tree.alternate);
    return intersectClaimList([thenBranch, rtdbExprClaims(tree.alternate)]);
  }
  if (tree.type === 'binary' && (tree.operator === '!=' || tree.operator === '!==')) {
    const leftClaim = rtdbTokenClaim(tree.left);
    const claim = leftClaim ?? rtdbTokenClaim(tree.right);
    let other = tree.left;
    if (leftClaim) other = tree.right;
    if (claim && other.type === 'null' && !STANDARD_CLAIMS.has(claim)) {
      return { [claim]: true };
    }
    return {};
  }
  if (tree.type === 'binary' && (tree.operator === '==' || tree.operator === '===')) {
    const leftClaim = rtdbTokenClaim(tree.left);
    const claim = leftClaim ?? rtdbTokenClaim(tree.right);
    let other = tree.left;
    if (leftClaim) other = tree.right;
    const lit = rtdbLiteral(other);
    if (claim && lit && !STANDARD_CLAIMS.has(claim)) {
      return { [claim]: lit.value };
    }
    return {};
  }
  const bare = rtdbTokenClaim(tree);
  if (bare && !STANDARD_CLAIMS.has(bare)) {
    return { [bare]: true };
  }
  return {};
}

/** Required claims for a Firestore document path and operation. */
export function firestoreRequiredClaims(source: string, target: ClaimTarget, into: Claims = {}): Claims {
  const ast = parseToAST(source);
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
      ...service.match.functions,
    ];
    const scopedAst: FirestoreRules = { ...ast, service };
    const matches = collectRootMatches(scopedAst, target.path, rootScope);
    for (const match of matches) {
      for (const allow of match.block.allows) {
        if (!allowCoversOp(allow.operations, target.op)) continue;
        if (isFsFalseLiteral(allow.condition)) continue;
        matchingAllows.push(fsExprClaims(allow.condition, match.functions, new Map(), declScopes, 0));
      }
    }
  }

  return copyClaimsInto(intersectClaimList(matchingAllows), into);
}

/** Required claims for a Cloud Storage object path and operation. */
export function storageRequiredClaims(source: string, target: ClaimTarget, into: Claims = {}): Claims {
  const services = parseRulesAstWithMultiMatch(source);
  if (services.length === 0) return into;

  const targetPattern = parseResourcePattern('storage', target.path, target.bucket);
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
      if (header.headerKind === 'concrete' || header.headerKind === 'wildcard') {
        const rulePattern = parseResourcePattern('storage', rawRulePath, target.bucket);
        if (overlapsPattern(rulePattern, targetPattern)) {
          for (const allow of block.allows) {
            if (!allowCoversOp(allow.operations, target.op)) continue;
            if (isFsFalseLiteral(allow.condition)) continue;
            matchingAllows.push(fsExprClaims(allow.condition, currentFns, new Map(), declScopes, 0));
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

function isFsFalseLiteral(expr: Expression): boolean {
  return expr.type === 'literal' && expr.value === false;
}

function findInScope(functions: FunctionDef[], name: string): FunctionDef | undefined {
  for (let i = functions.length - 1; i >= 0; i--) {
    if (functions[i].name === name) return functions[i];
  }
  return undefined;
}

function fsTokenClaim(expr: Expression, lets: ReadonlyMap<string, Expression>): string | undefined {
  const unwrapped = resolveLet(expr, lets);
  if (unwrapped.type !== 'memberAccess') return undefined;
  const obj = resolveLet(unwrapped.object, lets);
  if (obj.type !== 'memberAccess' || obj.property !== 'token') return undefined;
  const auth = resolveLet(obj.object, lets);
  if (auth.type === 'memberAccess' && auth.property === 'auth') {
    const req = resolveLet(auth.object, lets);
    if (req.type === 'identifier' && req.name === 'request') return unwrapped.property;
  }
  return undefined;
}

function resolveLet(expr: Expression, lets: ReadonlyMap<string, Expression>): Expression {
  let cur = expr;
  for (let i = 0; i < 8 && cur.type === 'identifier'; i++) {
    const next = lets.get(cur.name);
    if (!next) break;
    cur = next;
  }
  return cur;
}

function buildLetMap(bindings: LetBinding[], base: ReadonlyMap<string, Expression>): Map<string, Expression> {
  const next = new Map(base);
  for (const binding of bindings) {
    next.set(binding.name, resolveLet(binding.value, next));
  }
  return next;
}

function fsExprClaims(
  rawExpr: Expression,
  functions: FunctionDef[],
  lets: ReadonlyMap<string, Expression>,
  declScopes: WeakMap<FunctionDef, FunctionDef[]>,
  depth: number,
): Claims {
  const expr = resolveLet(rawExpr, lets);
  if (expr.type === 'binaryOp' && expr.op === '&&') {
    const left = fsExprClaims(expr.left, functions, lets, declScopes, depth);
    const right = fsExprClaims(expr.right, functions, lets, declScopes, depth);
    return unionClaims(left, right);
  }
  if (expr.type === 'binaryOp' && expr.op === '||') {
    const branches: Claims[] = [];
    if (!isFsFalseLiteral(expr.left)) {
      branches.push(fsExprClaims(expr.left, functions, lets, declScopes, depth));
    }
    if (!isFsFalseLiteral(expr.right)) {
      branches.push(fsExprClaims(expr.right, functions, lets, declScopes, depth));
    }
    return intersectClaimList(branches);
  }
  if (expr.type === 'ternary') {
    const thenBranch = unionClaims(
      fsExprClaims(expr.condition, functions, lets, declScopes, depth),
      fsExprClaims(expr.consequent, functions, lets, declScopes, depth),
    );
    if (isFsFalseLiteral(expr.alternate)) return thenBranch;
    if (isFsFalseLiteral(expr.consequent)) {
      return fsExprClaims(expr.alternate, functions, lets, declScopes, depth);
    }
    const elseBranch = fsExprClaims(expr.alternate, functions, lets, declScopes, depth);
    return intersectClaimList([thenBranch, elseBranch]);
  }
  if (expr.type === 'binaryOp' && (expr.op === '==' || expr.op === '!=')) {
    const leftClaim = fsTokenClaim(expr.left, lets);
    const claim = leftClaim ?? fsTokenClaim(expr.right, lets);
    let otherExpr = expr.left;
    if (leftClaim) otherExpr = expr.right;
    const other = resolveLet(otherExpr, lets);
    if (!claim || STANDARD_CLAIMS.has(claim) || other.type !== 'literal') return {};
    if (expr.op === '!=' && other.value === null) return { [claim]: true };
    if (expr.op === '==' && other.value !== null && !(other.value instanceof Uint8Array)) {
      return { [claim]: other.value };
    }
    return {};
  }
  if (expr.type === 'functionCall' && expr.args.length === 0 && depth < MAX_INLINE_DEPTH) {
    const fn = findInScope(functions, expr.name);
    if (fn && fn.parameters.length === 0) {
      const fnScope = declScopes.get(fn) ?? functions;
      const fnLets = buildLetMap(fn.lets, new Map());
      return fsExprClaims(fn.body, fnScope, fnLets, declScopes, depth + 1);
    }
    return {};
  }
  const bare = fsTokenClaim(expr, lets);
  if (bare && !STANDARD_CLAIMS.has(bare)) {
    return { [bare]: true };
  }
  return {};
}
