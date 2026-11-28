// Bounded pure-IR expansion for Firestore, RTDB, and Storage lowering.
// Handles multi-binding `require` blocks, acyclic helper-function inlining,
// and coordinates with `derive-project.ts` under explicit node, depth,
// call-depth, and target expression-unit limits.
import type { Expression } from '../grammar/FirestoreAST.js';
import type { CheckedFunction, CheckedPolicyIR } from './check.js';
import {
  buildDeriveExpansionPlan as buildDerivePlanWithInliner,
  collectDirectCalls,
  computeDeriveCompleteReason,
  countTreeWithin,
  ExpansionAbort,
  findForbiddenMapKey,
  rewriteDerivedRefs,
  type DeriveExpansionPlan,
  type HelperAnalysis,
} from './derive-project.js';
import { estimateIRExprUnits, type BoundedOpCostDetail } from './diagnostics.js';
import { collectBoundedOps, irChildren, type IRDerivation, type IRExpr, type IRRequirement } from './ir.js';

export { computeDeriveCompleteReason, type DeriveExpansionPlan, type HelperAnalysis };

export const DEFAULT_EXPANSION_NODE_LIMIT = 256;
export const DEFAULT_EXPANSION_DEPTH_LIMIT = 40;
export const DEFAULT_INLINE_CALL_DEPTH_LIMIT = 16;

export interface ExpandBudgetOptions {
  maxNodes?: number;
  maxDepth?: number;
  maxCallDepth?: number;
  targetUnitLimit?: number | null;
}

export interface RequirementExpansionResult {
  readonly ok: boolean;
  readonly expr?: Expression;
  readonly rtdbLets?: readonly { name: string; value: Expression }[];
  readonly rtdbCondition?: Expression;
  readonly expanded: boolean;
  readonly usesDerivedProjection: boolean;
  readonly projectedDerivePaths: readonly string[];
  readonly strictlyCoveredPaths: readonly string[];
  readonly inlinedHelpers: readonly string[];
  readonly inlinedLets: number;
  readonly helperUnits: number;
  readonly deriveUnits: number;
  readonly expandedNodes: number;
  readonly expansionNodeLimit: number;
  readonly expandedUnits: number | null;
  readonly budgetExceeded: boolean;
  readonly problems: readonly string[];
  readonly helperBoundedOps: readonly BoundedOpCostDetail[];
}

/** Analyze every helper in topological order for loops and transitive bounded ops (including unused lets). */
export function analyzeHelpers(
  functions: ReadonlyMap<string, CheckedFunction>,
  topoOrder: readonly string[],
): Map<string, HelperAnalysis> {
  const out = new Map<string, HelperAnalysis>();
  for (const name of topoOrder) {
    const entry = functions.get(name);
    if (!entry) continue;
    const { fn, deps, loop } = entry;
    const ops = new Set<string>();
    for (const l of fn.lets) for (const op of collectBoundedOps(l.value)) ops.add('bounded.' + op);
    for (const op of collectBoundedOps(fn.body)) ops.add('bounded.' + op);
    let hasLoop = Boolean(loop);
    let blockingHelper: string | undefined = ops.size || hasLoop ? name : undefined;
    for (const dep of deps) {
      const child = out.get(dep);
      if (!child) continue;
      if (child.hasLoop) {
        hasLoop = true;
        blockingHelper ??= child.blockingHelper ?? dep;
      }
      for (const op of child.boundedOps) {
        ops.add(op);
        blockingHelper ??= child.blockingHelper ?? dep;
      }
    }
    out.set(name, {
      pure: !hasLoop && ops.size === 0,
      hasLoop,
      boundedOps: [...ops],
      ...(blockingHelper ? { blockingHelper } : {}),
    });
  }
  return out;
}

function collectTransitiveHelperBoundedOps(
  calls: Iterable<string>,
  functions: ReadonlyMap<string, CheckedFunction>,
): BoundedOpCostDetail[] {
  const seen = new Set<string>();
  const ops: BoundedOpCostDetail[] = [];
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const entry = functions.get(name);
    if (!entry) return;
    for (const l of entry.fn.lets) estimateIRExprUnits(l.value, ops);
    estimateIRExprUnits(entry.fn.body, ops);
    for (const dep of entry.deps) visit(dep);
  };
  for (const c of calls) visit(c);
  return ops;
}

function checkPureCallsAndOps(
  expr: IRExpr,
  functions: ReadonlyMap<string, CheckedFunction>,
  analyses: ReadonlyMap<string, HelperAnalysis>,
  problems: string[],
  seenCalls: Set<string>,
): void {
  for (const op of collectBoundedOps(expr)) problems.push('Requires bounded.' + op);
  const calls = new Set<string>();
  collectDirectCalls(expr, functions, calls);
  for (const name of calls) {
    seenCalls.add(name);
    const info = analyses.get(name);
    if (!info) {
      problems.push('Requires helper functions: ' + name);
      continue;
    }
    if (!info.pure) {
      const target = info.blockingHelper ?? name;
      if (info.hasLoop) problems.push(`Requires helper function ${target} with for...of loop`);
      if (info.boundedOps.length) problems.push(`Requires ${info.boundedOps.join(', ')} via helper ${target}`);
    }
  }
}

interface InlineState {
  readonly functions: ReadonlyMap<string, CheckedFunction>;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxCallDepth: number;
  readonly inlinedHelpers: Set<string>;
  readonly active: Set<string>;
  nodes: number;
  helperUnits: number;
  hasInlined: boolean;
}

function makeInlineState(
  functions: ReadonlyMap<string, CheckedFunction>,
  maxNodes: number,
  maxDepth: number,
  maxCallDepth: number,
): InlineState {
  return {
    functions,
    maxNodes,
    maxDepth,
    maxCallDepth,
    inlinedHelpers: new Set(),
    active: new Set(),
    nodes: 0,
    helperUnits: 0,
    hasInlined: false,
  };
}

function inlinePureExpr(
  expr: Expression,
  env: ReadonlyMap<string, Expression>,
  state: InlineState,
  depth: number,
  callDepth: number,
): Expression {
  if (++state.nodes > state.maxNodes) {
    throw new ExpansionAbort(`Expanded expression exceeds ${state.maxNodes}-node inlining budget`, true);
  }
  if (depth > state.maxDepth) {
    throw new ExpansionAbort(`Expanded expression exceeds nesting depth budget (${state.maxDepth})`, true);
  }
  switch (expr.type) {
    case 'literal':
      return expr;
    case 'identifier': {
      const bound = env.get(expr.name);
      if (!bound) return expr;
      state.nodes = countTreeWithin(bound, { nodes: state.nodes - 1, maxNodes: state.maxNodes, maxDepth: state.maxDepth }, depth);
      return bound;
    }
    case 'memberAccess':
      return { ...expr, object: inlinePureExpr(expr.object, env, state, depth + 1, callDepth) };
    case 'methodCall':
      return {
        ...expr,
        object: inlinePureExpr(expr.object, env, state, depth + 1, callDepth),
        args: expr.args.map((a) => inlinePureExpr(a, env, state, depth + 1, callDepth)),
      };
    case 'bracketAccess':
      return {
        ...expr,
        object: inlinePureExpr(expr.object, env, state, depth + 1, callDepth),
        index: inlinePureExpr(expr.index, env, state, depth + 1, callDepth),
      };
    case 'sliceAccess':
      return {
        ...expr,
        object: inlinePureExpr(expr.object, env, state, depth + 1, callDepth),
        start: inlinePureExpr(expr.start, env, state, depth + 1, callDepth),
        end: inlinePureExpr(expr.end, env, state, depth + 1, callDepth),
      };
    case 'binaryOp':
      return {
        ...expr,
        left: inlinePureExpr(expr.left, env, state, depth + 1, callDepth),
        right: inlinePureExpr(expr.right, env, state, depth + 1, callDepth),
      };
    case 'unaryOp':
      return { ...expr, operand: inlinePureExpr(expr.operand, env, state, depth + 1, callDepth) };
    case 'ternary':
      return {
        ...expr,
        condition: inlinePureExpr(expr.condition, env, state, depth + 1, callDepth),
        consequent: inlinePureExpr(expr.consequent, env, state, depth + 1, callDepth),
        alternate: inlinePureExpr(expr.alternate, env, state, depth + 1, callDepth),
      };
    case 'inExpr':
      return {
        ...expr,
        element: inlinePureExpr(expr.element, env, state, depth + 1, callDepth),
        collection: inlinePureExpr(expr.collection, env, state, depth + 1, callDepth),
      };
    case 'isExpr':
      return { ...expr, value: inlinePureExpr(expr.value, env, state, depth + 1, callDepth) };
    case 'listLiteral':
      return { ...expr, elements: expr.elements.map((el) => inlinePureExpr(el, env, state, depth + 1, callDepth)) };
    case 'mapLiteral':
      return {
        ...expr,
        entries: expr.entries.map((en) => ({
          key: inlinePureExpr(en.key, env, state, depth + 1, callDepth),
          value: inlinePureExpr(en.value, env, state, depth + 1, callDepth),
        })),
      };
    case 'pathLiteral':
      return {
        ...expr,
        segments: expr.segments.map((seg) =>
          typeof seg === 'string' ? seg : inlinePureExpr(seg, env, state, depth + 1, callDepth),
        ),
      };
    case 'functionCall': {
      const callee = state.functions.get(expr.name);
      if (!callee) {
        return { ...expr, args: expr.args.map((a) => inlinePureExpr(a, env, state, depth + 1, callDepth)) };
      }
      if (state.active.has(expr.name)) {
        throw new ExpansionAbort('Recursive helper call cannot be inlined: ' + expr.name, false);
      }
      if (callDepth + 1 > state.maxCallDepth) {
        throw new ExpansionAbort(`Helper inlining call depth exceeds budget (${state.maxCallDepth}) at ${expr.name}`, true);
      }
      const inlinedArgs = expr.args.map((a) => inlinePureExpr(a, env, state, depth + 1, callDepth));
      // Fresh lexical scope prevents variable capture between caller and callee.
      const calleeEnv = new Map<string, Expression>();
      callee.fn.parameters.forEach((param, i) => { calleeEnv.set(param, inlinedArgs[i]!); });
      state.active.add(expr.name);
      try {
        for (const binding of callee.fn.lets) {
          calleeEnv.set(binding.name, inlinePureExpr(binding.value as Expression, calleeEnv, state, depth + 1, callDepth + 1));
        }
        const beforeUnits = inlinedArgs.reduce((s, a) => s + estimateIRExprUnits(a), 1);
        const body = inlinePureExpr(callee.fn.body as Expression, calleeEnv, state, depth + 1, callDepth + 1);
        state.helperUnits += Math.max(0, estimateIRExprUnits(body) - beforeUnits);
        state.inlinedHelpers.add(expr.name);
        state.hasInlined = true;
        return body;
      } finally {
        state.active.delete(expr.name);
      }
    }
  }
}

export function buildDeriveExpansionPlan(
  derivation: IRDerivation,
  functions: ReadonlyMap<string, CheckedFunction>,
  analyses: ReadonlyMap<string, HelperAnalysis>,
  options: ExpandBudgetOptions = {},
): DeriveExpansionPlan {
  const maxNodes = options.maxNodes ?? DEFAULT_EXPANSION_NODE_LIMIT;
  const maxDepth = options.maxDepth ?? DEFAULT_EXPANSION_DEPTH_LIMIT;
  const maxCallDepth = options.maxCallDepth ?? DEFAULT_INLINE_CALL_DEPTH_LIMIT;
  return buildDerivePlanWithInliner(derivation, functions, analyses, (expr) =>
    inlinePureExpr(expr, new Map(), makeInlineState(functions, maxNodes * 4, maxDepth, maxCallDepth), 0, 0),
  );
}

function countAllNodes(expr: IRExpr): number {
  let count = 1;
  for (const child of irChildren(expr)) count += countAllNodes(child);
  return count;
}

/** Expand a transition requirement's lets, acyclic helpers, and nested derive projections within budget. */
export function expandRequirementForTarget(
  rule: IRRequirement,
  checked: CheckedPolicyIR,
  analyses: ReadonlyMap<string, HelperAnalysis>,
  derivePlan: DeriveExpansionPlan | undefined,
  options: ExpandBudgetOptions = {},
): RequirementExpansionResult {
  const maxNodes = options.maxNodes ?? DEFAULT_EXPANSION_NODE_LIMIT;
  const maxDepth = options.maxDepth ?? DEFAULT_EXPANSION_DEPTH_LIMIT;
  const maxCallDepth = options.maxCallDepth ?? DEFAULT_INLINE_CALL_DEPTH_LIMIT;
  const targetUnitLimit = options.targetUnitLimit ?? null;

  const problems: string[] = [];
  const seenCalls = new Set<string>();
  for (const binding of rule.lets) {
    checkPureCallsAndOps(binding.value, checked.functions, analyses, problems, seenCalls);
  }
  checkPureCallsAndOps(rule.condition, checked.functions, analyses, problems, seenCalls);
  const helperBoundedOps = collectTransitiveHelperBoundedOps(seenCalls, checked.functions);
  if (problems.length) {
    return {
      ok: false, expanded: false, usesDerivedProjection: false,
      projectedDerivePaths: [], strictlyCoveredPaths: [], inlinedHelpers: [],
      inlinedLets: rule.lets.length, helperUnits: 0, deriveUnits: 0,
      expandedNodes: 0, expansionNodeLimit: maxNodes, expandedUnits: null,
      budgetExceeded: false, problems: [...new Set(problems)], helperBoundedOps,
    };
  }

  const usesDerive = checked.usesDerived.has(rule.name);
  const state = makeInlineState(checked.functions, maxNodes * 4, maxDepth, maxCallDepth);

  try {
    if (!rule.lets.length && !seenCalls.size && !usesDerive) {
      const pureCond = rule.condition as Expression;
      const forbidden = findForbiddenMapKey(pureCond);
      if (forbidden) {
        throw new ExpansionAbort(
          forbidden === '<dynamic>'
            ? 'Dynamic map literal key cannot be lowered safely'
            : 'Forbidden map key cannot be lowered: ' + forbidden,
          false,
        );
      }
      const units = estimateIRExprUnits(pureCond);
      const nodes = countAllNodes(pureCond);
      if (targetUnitLimit !== null && units > targetUnitLimit) {
        return {
          ok: false, expanded: false, usesDerivedProjection: false,
          projectedDerivePaths: [], strictlyCoveredPaths: [], inlinedHelpers: [],
          inlinedLets: 0, helperUnits: 0, deriveUnits: 0,
          expandedNodes: nodes, expansionNodeLimit: maxNodes, expandedUnits: units,
          budgetExceeded: true, helperBoundedOps,
          problems: [`Requirement exceeds target expression budget (${units}/${targetUnitLimit} units)`],
        };
      }
      return {
        ok: true, expr: pureCond, rtdbLets: [], rtdbCondition: pureCond,
        expanded: false, usesDerivedProjection: false,
        projectedDerivePaths: [], strictlyCoveredPaths: [], inlinedHelpers: [],
        inlinedLets: 0, helperUnits: 0, deriveUnits: 0,
        expandedNodes: nodes, expansionNodeLimit: maxNodes, expandedUnits: units,
        budgetExceeded: false, problems: [], helperBoundedOps,
      };
    }

    const letEnv = new Map<string, Expression>();
    for (const binding of rule.lets) {
      letEnv.set(binding.name, inlinePureExpr(binding.value as Expression, letEnv, state, 0, 0));
    }
    let expandedExpr = inlinePureExpr(rule.condition as Expression, letEnv, state, 0, 0);
    let projectedDerivePaths: string[] = [];
    let strictlyCoveredPaths: string[] = [];
    let deriveUnits = 0;
    let expandedNodes = countTreeWithin(expandedExpr, { nodes: 0, maxNodes, maxDepth }, 0);

    if (usesDerive) {
      if (!derivePlan) throw new ExpansionAbort('Requires derive', false);
      const rew = rewriteDerivedRefs(expandedExpr, derivePlan, checked.functions, analyses, maxNodes, maxDepth);
      expandedExpr = rew.expr;
      projectedDerivePaths = rew.projectedPaths;
      strictlyCoveredPaths = rew.strictlyCovered;
      deriveUnits = rew.deriveUnits;
      expandedNodes = rew.expandedNodes;
      // Standalone triggers `derive` eagerly whenever `usesDerived` holds (even for unused lets/args).
      // Refuse lowering when `derive` contains fatal-capable collection ops and no path remained to attach completeReason.
      if (projectedDerivePaths.length === 0 && derivePlan.operations.size > 0) {
        throw new ExpansionAbort(
          'Materializing derive requires ' +
            [...new Set(derivePlan.operations.values())].join(', ') +
            ': ' +
            [...derivePlan.operations.keys()].join(', '),
          false,
        );
      }
    }

    const forbidden = findForbiddenMapKey(expandedExpr);
    if (forbidden) {
      throw new ExpansionAbort(
        forbidden === '<dynamic>'
          ? 'Dynamic map literal key cannot be lowered safely'
          : 'Forbidden map key cannot be lowered: ' + forbidden,
        false,
      );
    }

    const expandedUnits = estimateIRExprUnits(expandedExpr);
    if (targetUnitLimit !== null && expandedUnits > targetUnitLimit) {
      return {
        ok: false, expanded: rule.lets.length > 0 || state.hasInlined || usesDerive,
        usesDerivedProjection: projectedDerivePaths.length > 0,
        projectedDerivePaths, strictlyCoveredPaths,
        inlinedHelpers: [...state.inlinedHelpers], inlinedLets: rule.lets.length,
        helperUnits: state.helperUnits, deriveUnits,
        expandedNodes, expansionNodeLimit: maxNodes, expandedUnits,
        budgetExceeded: true, helperBoundedOps,
        problems: [`Expanded expression exceeds target expression budget (${expandedUnits}/${targetUnitLimit} units)`],
      };
    }

    let rtdbLets: { name: string; value: Expression }[] | undefined;
    let rtdbCondition: Expression | undefined;
    if (!usesDerive && rule.lets.length) {
      const empty = new Map<string, Expression>();
      const rs = makeInlineState(checked.functions, maxNodes * 4, maxDepth, maxCallDepth);
      rtdbLets = rule.lets.map((l) => ({ name: l.name, value: inlinePureExpr(l.value as Expression, empty, rs, 0, 0) }));
      rtdbCondition = inlinePureExpr(rule.condition as Expression, empty, rs, 0, 0);
    }

    return {
      ok: true, expr: expandedExpr,
      rtdbLets: rtdbLets ?? [], rtdbCondition: rtdbCondition ?? expandedExpr,
      expanded: rule.lets.length > 0 || state.hasInlined || usesDerive,
      usesDerivedProjection: projectedDerivePaths.length > 0,
      projectedDerivePaths, strictlyCoveredPaths,
      inlinedHelpers: [...state.inlinedHelpers], inlinedLets: rule.lets.length,
      helperUnits: state.helperUnits, deriveUnits,
      expandedNodes, expansionNodeLimit: maxNodes, expandedUnits,
      budgetExceeded: false, problems: [], helperBoundedOps,
    };
  } catch (err) {
    const budgetExceeded = err instanceof ExpansionAbort ? err.budgetExceeded : false;
    return {
      ok: false, expanded: rule.lets.length > 0 || state.hasInlined || usesDerive,
      usesDerivedProjection: false, projectedDerivePaths: [], strictlyCoveredPaths: [],
      inlinedHelpers: [...state.inlinedHelpers], inlinedLets: rule.lets.length,
      helperUnits: state.helperUnits, deriveUnits: 0,
      expandedNodes: state.nodes, expansionNodeLimit: maxNodes, expandedUnits: null,
      budgetExceeded, helperBoundedOps,
      problems: [err instanceof Error ? err.message : String(err)],
    };
  }
}
