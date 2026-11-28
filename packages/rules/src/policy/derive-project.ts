// Deeper nested and multi-field `derive` projection planner and rewriter.
// Rewrites `derived.<path>` chains across compound expressions while tracking
// strictly-evaluated leaves so unverified sibling outputs are never bypassed.
import type { Expression } from '../grammar/FirestoreAST.js';
import { expressionChildren } from '../grammar/call-depth-limits.js';
import { substituteIdentifiers } from '../simulator/query-proof-scope.js';
import type { CheckedFunction } from './check.js';
import { estimateIRExprUnits, type BoundedOpCostDetail } from './diagnostics.js';
import { field } from './firestore.js';
import { collectBoundedOps, isPureRulesExpr, walkIR, type IRDerivation, type IRExpr } from './ir.js';

const FORBIDDEN_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface HelperAnalysis {
  readonly pure: boolean;
  readonly hasLoop: boolean;
  readonly boundedOps: readonly string[];
  readonly blockingHelper?: string;
}

export interface DeriveExpansionPlan {
  readonly operations: ReadonlyMap<string, string>;
  readonly rootMap?: Extract<Expression, { type: 'mapLiteral' }>;
  readonly mapError?: string;
  readonly invalidHelperError?: string;
  readonly nonLiteralLeaves: readonly string[];
  readonly deriveSourceUnits: number;
  readonly deriveBoundedOps: readonly BoundedOpCostDetail[];
}

export class ExpansionAbort extends Error {
  readonly budgetExceeded: boolean;
  constructor(message: string, budgetExceeded = false) {
    super(message);
    this.budgetExceeded = budgetExceeded;
  }
}

export interface TreeCounter {
  nodes: number;
  maxNodes: number;
  maxDepth: number;
}

export function countTreeWithin(expr: Expression, counter: TreeCounter, depth = 0): number {
  if (++counter.nodes > counter.maxNodes) {
    throw new ExpansionAbort(`Expanded expression exceeds ${counter.maxNodes}-node inlining budget`, true);
  }
  if (depth > counter.maxDepth) {
    throw new ExpansionAbort(`Expanded expression exceeds nesting depth budget (${counter.maxDepth})`, true);
  }
  for (const child of expressionChildren(expr)) {
    countTreeWithin(child, counter, depth + 1);
  }
  return counter.nodes;
}

export function collectDirectCalls(
  expr: IRExpr,
  functions: ReadonlyMap<string, CheckedFunction>,
  out: Set<string>,
): void {
  walkIR(expr, (node) => {
    if (node.type === 'functionCall' && functions.has(node.name)) out.add(node.name);
  });
}

function findForbiddenMapKey(expr: Expression, seen = new Set<Expression>()): string | undefined {
  if (seen.has(expr)) return undefined;
  seen.add(expr);
  if (expr.type === 'mapLiteral') {
    for (const en of expr.entries) {
      const k = en.key.type === 'literal' && typeof en.key.value === 'string' ? en.key.value : undefined;
      if (k && FORBIDDEN_MAP_KEYS.has(k)) return k;
    }
  }
  for (const child of expressionChildren(expr)) {
    const found = findForbiddenMapKey(child, seen);
    if (found) return found;
  }
  return undefined;
}

function validateDeriveMapKeys(
  node: Expression,
  prefix: string,
  nonLiteralLeaves: string[],
  topLevel: boolean,
): string | undefined {
  if (node.type !== 'mapLiteral') {
    return topLevel ? 'Requires a returned map literal' : undefined;
  }
  const seen = new Set<string>();
  for (const entry of node.entries) {
    if (entry.key.type !== 'literal' || typeof entry.key.value !== 'string') {
      return 'Requires unique, literal derive output keys';
    }
    const key = entry.key.value;
    if (FORBIDDEN_MAP_KEYS.has(key)) return 'Forbidden derive output key: ' + key;
    if (seen.has(key)) return 'Requires unique, literal derive output keys';
    seen.add(key);
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (entry.value.type === 'mapLiteral') {
      const nestedErr = validateDeriveMapKeys(entry.value, fullPath, nonLiteralLeaves, false);
      if (nestedErr) return nestedErr;
    } else if (entry.value.type !== 'literal') {
      nonLiteralLeaves.push(fullPath);
    }
    const innerForbidden = findForbiddenMapKey(entry.value);
    if (innerForbidden) return 'Forbidden derive output key: ' + innerForbidden;
  }
  return undefined;
}

function collectOperationDeps(expr: Expression, operations: ReadonlyMap<string, string>): string[] {
  if (operations.size === 0) return [];
  const seen = new Set<Expression>();
  const deps = new Set<string>();
  const walk = (node: Expression) => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node.type === 'identifier' && operations.has(node.name)) deps.add(node.name);
    for (const child of expressionChildren(node)) walk(child);
  };
  walk(expr);
  return [...deps];
}

/** Build a reusable expansion plan for a transition's optional `derive` block. */
export function buildDeriveExpansionPlan(
  derivation: IRDerivation,
  functions: ReadonlyMap<string, CheckedFunction>,
  analyses: ReadonlyMap<string, HelperAnalysis>,
  inlineExpr: (expr: Expression) => Expression,
): DeriveExpansionPlan {
  const operations = new Map<string, string>();
  const deriveBoundedOps: BoundedOpCostDetail[] = [];
  let deriveSourceUnits = 0;
  const locals = new Map<string, Expression>();
  let invalidHelperError: string | undefined;

  for (const binding of derivation.lets) {
    deriveSourceUnits += 1 + estimateIRExprUnits(binding.value, deriveBoundedOps);
    const directOps = collectBoundedOps(binding.value);
    const directCalls = new Set<string>();
    collectDirectCalls(binding.value, functions, directCalls);
    let helperOp: string | undefined;
    for (const c of directCalls) {
      const info = analyses.get(c);
      if (info && !info.pure) {
        helperOp = info.hasLoop ? 'loop' : info.boundedOps[0] ?? 'helper';
        break;
      }
    }
    if (directOps.length) {
      operations.set(binding.name, 'bounded.' + directOps[0]!);
    } else if (helperOp) {
      operations.set(binding.name, helperOp);
    } else if (isPureRulesExpr(binding.value)) {
      try {
        const substituted = substituteIdentifiers(binding.value, locals);
        const subDeps = collectOperationDeps(substituted, operations);
        locals.set(binding.name, directCalls.size && !subDeps.length ? inlineExpr(substituted) : substituted);
      } catch (err) {
        invalidHelperError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  deriveSourceUnits += estimateIRExprUnits(derivation.expr, deriveBoundedOps);
  if (!isPureRulesExpr(derivation.expr)) {
    const ops = collectBoundedOps(derivation.expr);
    operations.set('<return>', 'bounded.' + (ops[0] ?? 'op'));
    return {
      operations,
      mapError: 'Requires ' + ops.map((o) => 'bounded.' + o).join(', '),
      nonLiteralLeaves: [],
      deriveSourceUnits,
      deriveBoundedOps,
    };
  }
  const returnCalls = new Set<string>();
  collectDirectCalls(derivation.expr, functions, returnCalls);
  for (const c of returnCalls) {
    const info = analyses.get(c);
    if (info && !info.pure) {
      operations.set('<return>', info.hasLoop ? 'loop' : info.boundedOps[0] ?? 'helper');
    }
  }
  if (derivation.expr.type !== 'mapLiteral') {
    return {
      operations,
      mapError: 'Requires a returned map literal',
      nonLiteralLeaves: [],
      deriveSourceUnits,
      deriveBoundedOps,
    };
  }

  let expandedEntries: Array<{ key: Expression; value: Expression }>;
  try {
    expandedEntries = derivation.expr.entries.map((entry) => {
      const keyExpr = substituteIdentifiers(entry.key, locals);
      const rawVal = substituteIdentifiers(entry.value, locals);
      const calls = new Set<string>();
      collectDirectCalls(rawVal, functions, calls);
      const impureCall = [...calls].some((c) => !analyses.get(c)?.pure);
      const hasOpDep = collectOperationDeps(rawVal, operations).length > 0;
      return { key: keyExpr, value: calls.size && !impureCall && !hasOpDep ? inlineExpr(rawVal) : rawVal };
    });
  } catch (err) {
    return {
      operations,
      invalidHelperError: err instanceof Error ? err.message : String(err),
      nonLiteralLeaves: [],
      deriveSourceUnits,
      deriveBoundedOps,
    };
  }

  const rootMap: Extract<Expression, { type: 'mapLiteral' }> = { type: 'mapLiteral', entries: expandedEntries };
  const nonLiteralLeaves: string[] = [];
  const mapError = validateDeriveMapKeys(rootMap, '', nonLiteralLeaves, true);
  return {
    operations,
    rootMap: mapError ? undefined : rootMap,
    mapError,
    invalidHelperError,
    nonLiteralLeaves,
    deriveSourceUnits,
    deriveBoundedOps,
  };
}

function attachMembers(base: Expression, props: readonly string[]): Expression {
  let cur = base;
  for (const property of props) cur = { type: 'memberAccess', object: cur, property };
  return cur;
}

function lookupDerivedPath(
  rootMap: Extract<Expression, { type: 'mapLiteral' }>,
  segments: readonly string[],
): { value: Expression; matchedPath: string } | { error: string } {
  let cur: Expression = rootMap;
  const consumed: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (cur.type !== 'mapLiteral') {
      return { value: attachMembers(cur, segments.slice(i)), matchedPath: consumed.join('.') };
    }
    const found: { key: Expression; value: Expression } | undefined = cur.entries.find(
      (e) => e.key.type === 'literal' && e.key.value === seg,
    );
    if (!found) return { error: 'Unknown derive output: ' + [...consumed, seg].join('.') };
    consumed.push(seg);
    cur = found.value;
  }
  return { value: cur, matchedPath: consumed.join('.') };
}

function collectMapLeaves(node: Expression, prefix: string, out: Set<string>): void {
  if (node.type === 'mapLiteral') {
    for (const entry of node.entries) {
      if (entry.key.type === 'literal' && typeof entry.key.value === 'string') {
        collectMapLeaves(entry.value, prefix ? `${prefix}.${entry.key.value}` : entry.key.value, out);
      }
    }
    return;
  }
  if (node.type !== 'literal') out.add(prefix);
}

/** Rewrite all `derived.<path>` reads while recording strictly-evaluated leaf paths. */
export function rewriteDerivedRefs(
  expr: Expression,
  plan: DeriveExpansionPlan,
  functions: ReadonlyMap<string, CheckedFunction>,
  analyses: ReadonlyMap<string, HelperAnalysis>,
  maxNodes: number,
  maxDepth: number,
): {
  expr: Expression;
  projectedPaths: string[];
  strictlyCovered: string[];
  deriveUnits: number;
  expandedNodes: number;
} {
  if (plan.mapError) throw new ExpansionAbort(plan.mapError, false);
  if (plan.invalidHelperError) {
    throw new ExpansionAbort(plan.invalidHelperError, plan.invalidHelperError.includes('budget'));
  }
  const rootMap = plan.rootMap;
  if (!rootMap) throw new ExpansionAbort('Requires a returned map literal', false);

  const projectedPaths = new Set<string>();
  const strictlyCovered = new Set<string>();
  let deriveUnits = 0;
  let nodes = 0;

  function rewrite(node: Expression, strict: 'true' | 'eval' | 'none', depth: number): Expression {
    if (++nodes > maxNodes) {
      throw new ExpansionAbort(`Derived expression exceeds projection budget (${maxNodes} nodes)`, true);
    }
    if (depth > maxDepth) {
      throw new ExpansionAbort(`Derived expression exceeds projection depth budget (${maxDepth})`, true);
    }
    const dotted = field(node);
    if (dotted === 'derived') {
      throw new ExpansionAbort('Requires derive: bare derived reference cannot be projected', false);
    }
    if (dotted && dotted.startsWith('derived.')) {
      const segs = dotted.slice('derived.'.length).split('.');
      const resolved = lookupDerivedPath(rootMap!, segs);
      if ('error' in resolved) throw new ExpansionAbort(resolved.error, false);
      const opDeps = collectOperationDeps(resolved.value, plan.operations);
      if (opDeps.length) {
        const features = [...new Set(opDeps.map((d) => plan.operations.get(d)!))];
        throw new ExpansionAbort('Requires ' + features.join(', ') + ': ' + opDeps.join(', '), false);
      }
      const deriveCalls = new Set<string>();
      collectDirectCalls(resolved.value, functions, deriveCalls);
      for (const c of deriveCalls) {
        const info = analyses.get(c);
        if (info && !info.pure) {
          const target = info.blockingHelper ?? c;
          throw new ExpansionAbort(
            info.hasLoop
              ? `Requires helper function ${target} with for...of loop`
              : `Requires ${info.boundedOps.join(', ')} via helper ${target}`,
            false,
          );
        }
      }
      nodes = countTreeWithin(resolved.value, { nodes: nodes - 1, maxNodes, maxDepth }, depth);
      deriveUnits += Math.max(0, estimateIRExprUnits(resolved.value) - segs.length);
      projectedPaths.add(resolved.matchedPath);
      if (strict !== 'none') {
        if (resolved.value.type === 'mapLiteral') collectMapLeaves(resolved.value, resolved.matchedPath, strictlyCovered);
        else strictlyCovered.add(resolved.matchedPath);
      }
      return resolved.value;
    }

    const sub = strict === 'none' ? 'none' : 'eval';
    switch (node.type) {
      case 'literal':
      case 'identifier':
        return node;
      case 'memberAccess':
        return { ...node, object: rewrite(node.object, sub, depth + 1) };
      case 'methodCall':
        return { ...node, object: rewrite(node.object, sub, depth + 1), args: node.args.map((a) => rewrite(a, sub, depth + 1)) };
      case 'bracketAccess':
        return { ...node, object: rewrite(node.object, sub, depth + 1), index: rewrite(node.index, sub, depth + 1) };
      case 'sliceAccess':
        return {
          ...node,
          object: rewrite(node.object, sub, depth + 1),
          start: rewrite(node.start, sub, depth + 1),
          end: rewrite(node.end, sub, depth + 1),
        };
      case 'unaryOp':
        return { ...node, operand: rewrite(node.operand, sub, depth + 1) };
      case 'binaryOp': {
        if (node.op === '&&') {
          const andMode = strict === 'true' ? 'true' : 'none';
          return { ...node, left: rewrite(node.left, andMode, depth + 1), right: rewrite(node.right, andMode, depth + 1) };
        }
        if (node.op === '||') {
          return { ...node, left: rewrite(node.left, 'none', depth + 1), right: rewrite(node.right, 'none', depth + 1) };
        }
        return { ...node, left: rewrite(node.left, sub, depth + 1), right: rewrite(node.right, sub, depth + 1) };
      }
      case 'ternary':
        return {
          ...node,
          condition: rewrite(node.condition, sub, depth + 1),
          consequent: rewrite(node.consequent, 'none', depth + 1),
          alternate: rewrite(node.alternate, 'none', depth + 1),
        };
      case 'inExpr':
        return { ...node, element: rewrite(node.element, sub, depth + 1), collection: rewrite(node.collection, sub, depth + 1) };
      case 'isExpr':
        return { ...node, value: rewrite(node.value, sub, depth + 1) };
      case 'listLiteral':
        return { ...node, elements: node.elements.map((e) => rewrite(e, sub, depth + 1)) };
      case 'mapLiteral':
        return { ...node, entries: node.entries.map((en) => ({ key: rewrite(en.key, sub, depth + 1), value: rewrite(en.value, sub, depth + 1) })) };
      case 'pathLiteral':
        return { ...node, segments: node.segments.map((s) => (typeof s === 'string' ? s : rewrite(s, sub, depth + 1))) };
      case 'functionCall':
        return { ...node, args: node.args.map((a) => rewrite(a, sub, depth + 1)) };
    }
  }

  const rewritten = rewrite(expr, 'true', 0);
  return {
    expr: rewritten,
    projectedPaths: [...projectedPaths],
    strictlyCovered: [...strictlyCovered],
    deriveUnits,
    expandedNodes: nodes,
  };
}

/**
 * Compute unverified `derive` siblings across all lowered requirements projecting `derived.*`.
 * Preserves the exact `'Unverified derive outputs: ...'` message format for backwards compatibility.
 */
export function computeDeriveCompleteReason(
  plan: DeriveExpansionPlan | undefined,
  strictlyCovered: ReadonlySet<string>,
  allProjectedPaths: ReadonlySet<string>,
): string | undefined {
  if (!plan || allProjectedPaths.size === 0) return undefined;
  if (plan.operations.size) {
    return (
      'Materializing derive requires ' +
      [...new Set(plan.operations.values())].join(', ') +
      ': ' +
      [...plan.operations.keys()].join(', ')
    );
  }
  const leaves = plan.nonLiteralLeaves;
  if (!leaves.length) return undefined;
  if (leaves.length === 1 && allProjectedPaths.size === 1 && allProjectedPaths.has(leaves[0]!)) {
    return undefined;
  }
  const missingLeaves = leaves.filter((leaf) => !strictlyCovered.has(leaf));
  if (!missingLeaves.length) return undefined;
  const collapsed = new Set<string>();
  for (const leaf of missingLeaves) {
    const top = leaf.split('.')[0]!;
    const hasCoveredSibling = [...strictlyCovered].some((c) => c === top || c.startsWith(top + '.'));
    collapsed.add(hasCoveredSibling ? leaf : top);
  }
  return 'Unverified derive outputs: ' + [...collapsed].join(', ');
}
