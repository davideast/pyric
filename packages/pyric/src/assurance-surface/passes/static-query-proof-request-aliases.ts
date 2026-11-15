/**
 * Request-alias resolution for {@link staticQueryProofPass} possibility checks:
 * tracks `request`, `request.auth`, and `request.auth.token` prefixes through
 * helper parameters, `let` bindings, helper returns, and member/bracket
 * projections so unseeded context checks recognize aliased auth/token accesses.
 */
import {
  substituteIdentifiers,
  type Expression,
  type FunctionDef,
} from '@pyric/rules/internal';

const MAX_REQUEST_ALIAS_DEPTH = 3;

function isStaticPropertyAccess(
  expr: Expression,
): expr is Extract<Expression, { type: 'memberAccess' | 'bracketAccess' }> {
  if (expr.type === 'memberAccess') return true;
  return (
    expr.type === 'bracketAccess'
    && expr.index.type === 'literal'
    && typeof expr.index.value === 'string'
  );
}

function requestAliasDepth(expr: Expression): number | null {
  if (expr.type === 'identifier') {
    if (expr.name === 'request') return 0;
    return null;
  }
  if (isStaticPropertyAccess(expr)) {
    const baseDepth = requestAliasDepth(expr.object);
    if (baseDepth === null || baseDepth >= MAX_REQUEST_ALIAS_DEPTH) return null;
    return baseDepth + 1;
  }
  return null;
}

export function applyRequestAliases(
  expr: Expression,
  aliases: ReadonlyMap<string, Expression>,
): Expression {
  if (aliases.size === 0) return expr;
  return substituteIdentifiers(expr, aliases);
}

export function resolveRequestAliasExpr(
  expr: Expression,
  scopeFunctions: ReadonlyMap<string, FunctionDef>,
  visited: ReadonlySet<FunctionDef>,
): Expression | null {
  if (requestAliasDepth(expr) !== null) return expr;
  if (isStaticPropertyAccess(expr)) {
    const resolvedObject = resolveRequestAliasExpr(expr.object, scopeFunctions, visited);
    if (resolvedObject === null) return null;
    let rebuilt: Expression;
    if (expr.type === 'memberAccess') {
      rebuilt = { ...expr, object: resolvedObject };
    } else {
      rebuilt = { ...expr, object: resolvedObject };
    }
    if (requestAliasDepth(rebuilt) === null) return null;
    return rebuilt;
  }
  if (expr.type !== 'functionCall') return null;
  const fnDef = scopeFunctions.get(expr.name);
  if (!fnDef || visited.has(fnDef) || fnDef.parameters.length !== expr.args.length) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(fnDef);
  const aliases = new Map<string, Expression>();
  for (let i = 0; i < fnDef.parameters.length; i += 1) {
    const param = fnDef.parameters[i];
    const arg = expr.args[i];
    if (param === undefined || arg === undefined) continue;
    const argAlias = resolveRequestAliasExpr(arg, scopeFunctions, nextVisited);
    if (argAlias !== null) {
      aliases.set(param, argAlias);
    }
  }
  for (const binding of fnDef.lets) {
    const value = applyRequestAliases(binding.value, aliases);
    const resolved = resolveRequestAliasExpr(value, scopeFunctions, nextVisited);
    if (resolved !== null) {
      aliases.set(binding.name, resolved);
    } else {
      aliases.delete(binding.name);
    }
  }
  const body = applyRequestAliases(fnDef.body, aliases);
  return resolveRequestAliasExpr(body, scopeFunctions, nextVisited);
}

export function resolveNodeForUnseededCheck(
  node: Expression,
  scopeFunctions: ReadonlyMap<string, FunctionDef>,
  visitedFns: ReadonlySet<FunctionDef>,
): Expression {
  const direct = resolveRequestAliasExpr(node, scopeFunctions, visitedFns);
  if (direct !== null) return direct;
  if (node.type === 'bracketAccess' || node.type === 'methodCall') {
    const resolvedObject = resolveRequestAliasExpr(node.object, scopeFunctions, visitedFns);
    if (resolvedObject !== null) {
      return { ...node, object: resolvedObject };
    }
  }
  if (node.type === 'inExpr') {
    const resolvedCollection = resolveRequestAliasExpr(
      node.collection,
      scopeFunctions,
      visitedFns,
    );
    if (resolvedCollection !== null) {
      return { ...node, collection: resolvedCollection };
    }
  }
  return node;
}

export function rebindParentForResolvedNode(
  node: Expression,
  resolvedNode: Expression,
  parent: Expression | null,
): Expression | null {
  if (resolvedNode === node || parent === null) return parent;
  if (parent.type === 'binaryOp') {
    if (parent.left === node) return { ...parent, left: resolvedNode };
    if (parent.right === node) return { ...parent, right: resolvedNode };
  }
  if (parent.type === 'inExpr' && parent.element === node) {
    return { ...parent, element: resolvedNode };
  }
  return parent;
}
