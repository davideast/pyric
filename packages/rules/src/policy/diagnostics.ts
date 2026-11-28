// Machine-readable failure traces and placement/budget diagnostics for Policy IR.
// Isomorphic TypeScript: pure ECMAScript, 100% JSON-serializable outputs.
import type { Expression, SourceLoc } from '../grammar/FirestoreAST.js';
import { EXPRESSION_LIMIT } from '../linter/expression-cost.js';
import { EvalError, ResourceLimitError } from '../simulator/eval-error.js';
import { FirestoreSet } from '../simulator/firestore-set.js';
import { MapDiff } from '../simulator/mapdiff.js';
import { isRulesMap } from '../simulator/rules-type.js';
import type { ExprTraceEntry } from '../simulator/trace-recorder.js';
import { Bytes } from '../simulator/wrappers/bytes.js';
import { Duration } from '../simulator/wrappers/duration.js';
import { RulesFloat } from '../simulator/wrappers/float.js';
import { Timestamp } from '../simulator/wrappers/timestamp.js';
import { irChildren, type IRExpr, type IRRequirement } from './ir.js';

export interface PolicySpan {
  line: number;
  col: number;
  location: string;
}

export interface EvaluatedBindingTrace {
  name: string;
  scope: 'derive' | 'require';
  value?: unknown;
  error?: string;
  fatal?: true;
  span?: PolicySpan;
}

export interface SubExpressionOperandTrace {
  source: string;
  value?: unknown;
  error?: string;
}

export interface SubExpressionTrace {
  source: string;
  kind: string;
  operator?: string;
  value?: unknown;
  error?: string;
  operands?: SubExpressionOperandTrace[];
}

export interface PolicyFailureTrace {
  requirement: string;
  span: PolicySpan;
  source: string;
  outcome: 'false' | 'eval-error' | 'resource-limit';
  fatal: boolean;
  bindings: EvaluatedBindingTrace[];
  failingSubExpression?: SubExpressionTrace;
  derived?: Record<string, unknown> | { $error: string };
  expressionUnitsUsed: number;
  expressionLimit: number;
}

export type PlacementReasonCode =
  | 'LOWERED'
  | 'USES_BOUNDED_OP'
  | 'USES_DERIVE'
  | 'USES_DERIVE_COLLECTION'
  | 'USES_HELPER_FUNCTIONS'
  | 'USES_LOCAL_BINDINGS'
  | 'MISSING_BINDING'
  | 'WRONG_SNAPSHOT_ORIGIN'
  | 'UNTRUSTED_DERIVE_INPUT'
  | 'PROJECTION_BUDGET_EXCEEDED'
  | 'EXPRESSION_BUDGET_EXCEEDED'
  | 'UNSUPPORTED_EXPRESSION'
  | 'UNVERIFIED_DERIVE_SIBLINGS'
  | 'INVALID_BINDING_PROJECTION'
  | 'LOOP_NOT_LOWERABLE';

export interface PlacementProblemDetail {
  code: PlacementReasonCode;
  message: string;
  detail?: string;
}

export interface BoundedOpCostDetail {
  op: string;
  limit: number;
  estimatedWorstCaseUnits: number;
}

export interface ExpressionCostBreakdown {
  sourceUnits: number;
  sourceLimit: number;
  targetUnits: number | null;
  targetLimit: number | null;
  withinSourceBudget: boolean;
  withinTargetBudget: boolean | null;
  letUnits: number;
  conditionUnits: number;
  boundedOps: BoundedOpCostDetail[];
  helperUnits?: number;
  deriveUnits?: number;
  inlinedHelpers?: string[];
  inlinedLets?: number;
  projectedDerivePaths?: string[];
  expandedNodes?: number;
  expansionNodeLimit?: number;
  targetChars?: number;
  targetCharLimit?: number;
  fallbackSummary?: string;
}

export interface RequirementCostExtras {
  expandedUnits?: number | null;
  helperUnits?: number;
  deriveUnits?: number;
  inlinedHelpers?: readonly string[];
  inlinedLets?: number;
  projectedDerivePaths?: readonly string[];
  expandedNodes?: number;
  expansionNodeLimit?: number;
  targetChars?: number;
  targetCharLimit?: number;
  extraBoundedOps?: readonly BoundedOpCostDetail[];
  budgetExceeded?: boolean;
  enforcement?: string;
  problems?: readonly string[];
}

export function makePolicySpan(loc: SourceLoc | undefined, fallbackLocation?: string): PolicySpan {
  if (loc) {
    return { line: loc.line, col: loc.col, location: `${loc.line}:${loc.col}` };
  }
  if (fallbackLocation) {
    const [l, c] = fallbackLocation.split(':').map(Number);
    return {
      line: Number.isFinite(l) ? l! : 1,
      col: Number.isFinite(c) ? c! : 1,
      location: fallbackLocation,
    };
  }
  return { line: 1, col: 1, location: '1:1' };
}

const MAX_DIAG_NODES = 512;
const MAX_DIAG_STRING = 512;

/** Convert any Rules/JS value into a bounded, strictly JSON-serializable diagnostic payload. */
export function toDiagnosticJsonValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget: { nodes: number } = { nodes: 0 },
): unknown {
  if (++budget.nodes > MAX_DIAG_NODES) return { $truncated: 'max-nodes' };
  if (depth > 16) return { $truncated: 'max-depth' };
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_DIAG_STRING ? value.slice(0, MAX_DIAG_STRING) + '...(truncated)' : value;
  }
  if (value === undefined) return null;
  if (typeof value === 'bigint') {
    return value >= -9007199254740991n && value <= 9007199254740991n
      ? Number(value)
      : { $int64: value.toString() };
  }
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return { $float: '-0' };
    if (Number.isNaN(value)) return { $float: 'NaN' };
    if (value === Infinity) return { $float: 'Infinity' };
    if (value === -Infinity) return { $float: '-Infinity' };
    return value;
  }
  if (value instanceof RulesFloat) {
    return toDiagnosticJsonValue(value.value, depth + 1, seen, budget);
  }
  if (value instanceof Bytes) {
    return { $bytes: value.toBase64(), size: value.size() };
  }
  if (value instanceof Timestamp) {
    return { $timestamp: value.toString(), seconds: value.seconds, nanos: value.nanos };
  }
  if (value instanceof Duration) {
    return { $duration: value.toString(), seconds: value.seconds, nanos: value.nanos };
  }
  if (value instanceof FirestoreSet) {
    return { $set: value.toArray().slice(0, 64).map((v) => toDiagnosticJsonValue(v, depth + 1, seen, budget)) };
  }
  if (value instanceof MapDiff) {
    return { $mapDiff: true };
  }
  if (value instanceof EvalError) {
    return {
      $error: value.message,
      ...(value instanceof ResourceLimitError ? { fatal: true } : {}),
    };
  }
  if (value instanceof Error) {
    return { $error: value.message };
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return { $truncated: 'cycle' };
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const cap = Math.min(value.length, 64);
        const out = [];
        for (let i = 0; i < cap; i++) {
          if (budget.nodes >= MAX_DIAG_NODES) {
            out.push({ $truncated: 'max-nodes' });
            break;
          }
          out.push(toDiagnosticJsonValue(value[i], depth + 1, seen, budget));
        }
        if (value.length > cap) out.push({ $truncated: value.length - cap });
        return out;
      }
      if (isRulesMap(value)) {
        const keys = Object.keys(value);
        const cap = Math.min(keys.length, 64);
        const out: Record<string, unknown> = {};
        for (let i = 0; i < cap; i++) {
          if (budget.nodes >= MAX_DIAG_NODES) {
            out.$truncated = 'max-nodes';
            break;
          }
          const k = keys[i]!;
          out[k] = toDiagnosticJsonValue(value[k], depth + 1, seen, budget);
        }
        if (keys.length > cap) out.$truncatedKeys = keys.length - cap;
        return out;
      }
      return String(value);
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

/** Pinpoint the deepest falsifying or erroring sub-expression from a TraceRecorder capture. */
export function extractFailingSubExpression(
  entries: readonly ExprTraceEntry[],
): SubExpressionTrace | undefined {
  if (!entries.length) return undefined;
  let index = 0;
  // Walk down through falsifying conjunctions/disjunctions or propagating error nodes.
  while (index >= 0 && index < entries.length) {
    const cur = entries[index]!;
    if (cur.operator === '&&' && cur.value === false) {
      const next = entries.findIndex((e, i) => i > index && e.parent === index && e.value === false);
      if (next === -1) break;
      index = next;
      continue;
    }
    if (cur.error !== undefined) {
      const next = entries.findIndex((e, i) => i > index && e.parent === index && e.error !== undefined);
      if (next === -1) break;
      index = next;
      continue;
    }
    break;
  }
  const target = entries[index];
  if (!target) return undefined;
  const children = entries.filter((e) => e.parent === index);
  const operands: SubExpressionOperandTrace[] | undefined = children.length
    ? children.map((child) => ({
        source: child.source,
        ...(child.error !== undefined
          ? { error: child.error }
          : { value: toDiagnosticJsonValue(child.value) }),
      }))
    : undefined;
  return {
    source: target.source,
    kind: target.kind,
    ...(target.operator !== undefined ? { operator: target.operator } : {}),
    ...(target.error !== undefined
      ? { error: target.error }
      : { value: toDiagnosticJsonValue(target.value) }),
    ...(operands ? { operands } : {}),
  };
}

/** Build a complete machine-readable failure trace for `judge(...)`. */
export function buildFailureTrace(params: {
  rule: IRRequirement;
  outcome: 'false' | 'eval-error' | 'resource-limit';
  bindings: EvaluatedBindingTrace[];
  entries: readonly ExprTraceEntry[];
  derived?: unknown;
  hasDerived: boolean;
  expressionUnitsUsed: number;
  expressionLimit: number;
  errorMessage?: string;
}): PolicyFailureTrace {
  const failingSubExpression =
    extractFailingSubExpression(params.entries) ??
    (params.errorMessage
      ? { source: params.rule.source, kind: params.rule.condition.type, error: params.errorMessage }
      : { source: params.rule.source, kind: params.rule.condition.type, value: false });

  let derivedTrace: Record<string, unknown> | { $error: string } | undefined;
  if (params.hasDerived) {
    if (params.derived instanceof Error) {
      derivedTrace = { $error: params.derived.message };
    } else if (params.derived && typeof params.derived === 'object') {
      derivedTrace = toDiagnosticJsonValue(params.derived) as Record<string, unknown>;
    }
  }

  return {
    requirement: params.rule.name,
    span: makePolicySpan(params.rule.loc, params.rule.location),
    source: params.rule.source,
    outcome: params.outcome,
    fatal: params.outcome === 'resource-limit',
    bindings: params.bindings,
    failingSubExpression,
    ...(derivedTrace !== undefined ? { derived: derivedTrace } : {}),
    expressionUnitsUsed: params.expressionUnitsUsed,
    expressionLimit: params.expressionLimit,
  };
}

/** Conservative Rules-v2 expression unit estimate for an IR expression tree. */
export function estimateIRExprUnits(expr: IRExpr, boundedOps?: BoundedOpCostDetail[]): number {
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return 1;
    case 'ternary':
      return (
        4 +
        estimateIRExprUnits(expr.condition, boundedOps) +
        Math.max(
          estimateIRExprUnits(expr.consequent, boundedOps),
          estimateIRExprUnits(expr.alternate, boundedOps),
        )
      );
    case 'isExpr':
      return 2 + estimateIRExprUnits(expr.value, boundedOps);
    case 'binaryOp':
      return (
        (expr.op === '&&' || expr.op === '||' ? 2 : 1) +
        estimateIRExprUnits(expr.left, boundedOps) +
        estimateIRExprUnits(expr.right, boundedOps)
      );
    case 'boundedOp': {
      const listCost = estimateIRExprUnits(expr.list, boundedOps);
      let worst: number;
      if (expr.op === 'append') {
        worst = listCost + estimateIRExprUnits(expr.suffix, boundedOps) + expr.limit;
      } else if (expr.op === 'fold') {
        const initCost = estimateIRExprUnits(expr.initial, boundedOps);
        const letCost = expr.lets.reduce((s, l) => s + 1 + estimateIRExprUnits(l.value, boundedOps), 0);
        const bodyCost = estimateIRExprUnits(expr.body, boundedOps);
        worst = listCost + initCost + expr.limit * (1 + letCost + bodyCost);
      } else {
        const bodyCost = estimateIRExprUnits(expr.body, boundedOps);
        worst = listCost + expr.limit * (1 + bodyCost);
      }
      boundedOps?.push({ op: 'bounded.' + expr.op, limit: expr.limit, estimatedWorstCaseUnits: worst });
      return worst;
    }
    default: {
      let total = 1;
      for (const child of irChildren(expr)) total += estimateIRExprUnits(child, boundedOps);
      return total;
    }
  }
}

/** Classify raw placement problem messages into structured machine-readable reason codes. */
export function classifyPlacementProblems(
  problems: readonly string[],
  lowered: boolean,
  loweredReason: string,
): PlacementProblemDetail[] {
  if (lowered && !problems.length) {
    return [{ code: 'LOWERED', message: loweredReason }];
  }
  return problems.map((message) => {
    let code: PlacementReasonCode = 'UNSUPPORTED_EXPRESSION';
    let detail: string | undefined;
    if (message.startsWith('Requires bounded.') || message.includes('decoded collection and bounded.')) {
      code = 'USES_BOUNDED_OP';
      if (message.includes('via helper ')) detail = message.slice(message.indexOf('via helper '));
    } else if (message.startsWith('Materializing derive requires')) {
      code = 'USES_DERIVE_COLLECTION';
    } else if (message.startsWith('Requires derive')) {
      code = 'USES_DERIVE';
    } else if (message.includes('with for...of loop')) {
      code = 'LOOP_NOT_LOWERABLE';
    } else if (message.startsWith('Requires helper function')) {
      code = 'USES_HELPER_FUNCTIONS';
    } else if (message.startsWith('Requires local bindings')) {
      code = 'USES_LOCAL_BINDINGS';
    } else if (message.startsWith('Missing binding:')) {
      code = 'MISSING_BINDING';
      detail = message.slice('Missing binding:'.length).trim();
    } else if (
      message.startsWith('Wrong snapshot:') ||
      message.includes(' requires before, bound to') ||
      message.includes(' requires after, bound to')
    ) {
      code = 'WRONG_SNAPSHOT_ORIGIN';
    } else if (
      message.includes('requires a trusted stored input') ||
      message.includes('requires a trusted Storage input')
    ) {
      code = 'UNTRUSTED_DERIVE_INPUT';
    } else if (message.includes('projection budget') || message.includes('projection depth budget')) {
      code = 'PROJECTION_BUDGET_EXCEEDED';
      detail = extractBudgetDetail(message);
    } else if (
      message.includes('budget') ||
      message.includes('emission limit') ||
      message.includes('inlining budget')
    ) {
      code = 'EXPRESSION_BUDGET_EXCEEDED';
      detail = extractBudgetDetail(message);
    } else if (message.startsWith('Unverified derive outputs:')) {
      code = 'UNVERIFIED_DERIVE_SIBLINGS';
      detail = message.slice('Unverified derive outputs:'.length).trim();
    } else if (
      message.startsWith('Invalid Firestore read') ||
      message.startsWith('Expected a data projection') ||
      message.startsWith('Invalid Storage read') ||
      message.startsWith('Expected a Storage data projection') ||
      message.startsWith('Invalid Storage field projection') ||
      message.startsWith('Invalid RTDB snapshot binding')
    ) {
      code = 'INVALID_BINDING_PROJECTION';
    } else if (
      message.includes('ordered accumulator') ||
      message.includes('checked input') ||
      message.includes('computed list elements')
    ) {
      code = 'LOOP_NOT_LOWERABLE';
    }
    return detail ? { code, message, detail } : { code, message };
  });
}

function extractBudgetDetail(message: string): string | undefined {
  const match = /\(([^)]+)\)/.exec(message) ?? /(\d+-node|\d+\s+units|\d+\s+characters)/.exec(message);
  return match?.[1];
}

function formatFallbackSummary(params: {
  enforcement: string;
  sourceUnits: number;
  targetUnits: number | null;
  targetLimit: number | null;
  expandedNodes?: number;
  expansionNodeLimit?: number;
  targetChars?: number;
  targetCharLimit?: number;
  inlinedLets?: number;
  inlinedHelpers?: readonly string[];
  helperUnits?: number;
  projectedDerivePaths?: readonly string[];
  deriveUnits?: number;
  boundedOps: readonly BoundedOpCostDetail[];
  problems?: readonly string[];
}): string {
  const parts: string[] = [`Fallback (${params.enforcement}): source ${params.sourceUnits} units`];
  if (params.targetUnits !== null && params.targetLimit !== null) {
    parts.push(`expanded ${params.targetUnits}/${params.targetLimit} target units`);
  } else if (params.targetUnits !== null) {
    parts.push(`expanded ${params.targetUnits} target units`);
  }
  if (params.expandedNodes !== undefined && params.expansionNodeLimit !== undefined && params.expandedNodes > params.expansionNodeLimit) {
    parts.push(`nodes ${params.expandedNodes}/${params.expansionNodeLimit}`);
  }
  if (params.targetChars !== undefined && params.targetCharLimit !== undefined && params.targetChars > params.targetCharLimit) {
    parts.push(`chars ${params.targetChars}/${params.targetCharLimit}`);
  }
  if (params.inlinedLets) parts.push(`${params.inlinedLets} let(s)`);
  if (params.inlinedHelpers?.length) {
    const hu = params.helperUnits ? ` (+${params.helperUnits} units)` : '';
    parts.push(`helpers [${params.inlinedHelpers.join(', ')}]${hu}`);
  }
  if (params.projectedDerivePaths?.length) {
    const du = params.deriveUnits ? ` (+${params.deriveUnits} units)` : '';
    parts.push(`derive [${params.projectedDerivePaths.join(', ')}]${du}`);
  }
  if (params.boundedOps.length) {
    const opDesc = params.boundedOps.map((o) => `${o.op}(limit ${o.limit}, worst ${o.estimatedWorstCaseUnits})`).join(', ');
    parts.push(`bounded ops: ${opDesc}`);
  }
  if (params.problems?.length) {
    parts.push(`reason: ${params.problems[0]}`);
  }
  return parts.join('; ');
}

/** Compute source and target expression-cost breakdown for a requirement. */
export function buildRequirementCost(
  rule: IRRequirement,
  sourceLimit: number,
  loweredExpr?: Expression,
  targetLimit: number | null = EXPRESSION_LIMIT,
  extras?: RequirementCostExtras,
): ExpressionCostBreakdown {
  const boundedOps: BoundedOpCostDetail[] = [];
  const letUnits = rule.lets.reduce((sum, l) => sum + 1 + estimateIRExprUnits(l.value, boundedOps), 0);
  const conditionUnits = estimateIRExprUnits(rule.condition, boundedOps);
  if (extras?.extraBoundedOps?.length) {
    for (const op of extras.extraBoundedOps) boundedOps.push(op);
  }
  const sourceUnits = letUnits + conditionUnits;
  const computedTarget = loweredExpr
    ? estimateIRExprUnits(loweredExpr)
    : extras?.expandedUnits !== undefined
      ? extras.expandedUnits
      : null;
  const withinTargetBudget =
    extras?.budgetExceeded
      ? false
      : computedTarget !== null && targetLimit !== null
        ? computedTarget <= targetLimit
        : null;
  const isFallback = !loweredExpr && Boolean(extras?.enforcement);
  const fallbackSummary = isFallback
    ? formatFallbackSummary({
        enforcement: extras!.enforcement!,
        sourceUnits,
        targetUnits: computedTarget,
        targetLimit,
        expandedNodes: extras?.expandedNodes,
        expansionNodeLimit: extras?.expansionNodeLimit,
        targetChars: extras?.targetChars,
        targetCharLimit: extras?.targetCharLimit,
        inlinedLets: extras?.inlinedLets,
        inlinedHelpers: extras?.inlinedHelpers,
        helperUnits: extras?.helperUnits,
        projectedDerivePaths: extras?.projectedDerivePaths,
        deriveUnits: extras?.deriveUnits,
        boundedOps,
        problems: extras?.problems,
      })
    : undefined;
  return {
    sourceUnits,
    sourceLimit,
    targetUnits: computedTarget,
    targetLimit,
    withinSourceBudget: sourceUnits <= sourceLimit,
    withinTargetBudget,
    letUnits,
    conditionUnits,
    boundedOps,
    ...(extras?.helperUnits !== undefined && extras.helperUnits > 0 ? { helperUnits: extras.helperUnits } : {}),
    ...(extras?.deriveUnits !== undefined && extras.deriveUnits > 0 ? { deriveUnits: extras.deriveUnits } : {}),
    ...(extras?.inlinedHelpers?.length ? { inlinedHelpers: [...extras.inlinedHelpers] } : {}),
    ...(extras?.inlinedLets ? { inlinedLets: extras.inlinedLets } : {}),
    ...(extras?.projectedDerivePaths?.length ? { projectedDerivePaths: [...extras.projectedDerivePaths] } : {}),
    ...(extras?.expandedNodes !== undefined && extras.expandedNodes > 0 ? { expandedNodes: extras.expandedNodes } : {}),
    ...(extras?.expansionNodeLimit !== undefined ? { expansionNodeLimit: extras.expansionNodeLimit } : {}),
    ...(extras?.targetChars !== undefined ? { targetChars: extras.targetChars } : {}),
    ...(extras?.targetCharLimit !== undefined ? { targetCharLimit: extras.targetCharLimit } : {}),
    ...(fallbackSummary ? { fallbackSummary } : {}),
  };
}
