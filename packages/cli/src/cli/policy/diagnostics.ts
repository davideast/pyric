/**
 * Structured diagnostics, source-span extraction, uniform placement splits,
 * and expression-cost aggregation for `pyric policy`.
 */
import type {
  BoundedOpCostDetail,
  ExpressionCostBreakdown,
  FunctionPlacementItem,
  PlacementProblemDetail,
  PlacementReasonCode,
  PolicyCliDiagnostic,
  PolicyCostItem,
  PolicyCostSummary,
  PolicyDiagnosticCode,
  PolicyDiagnosticStage,
  PolicyPlacementSummary,
  PolicySpan,
  RawFirestoreRow,
  RawRtdbRow,
  RawStorageRow,
  TargetPlacementReport,
  TargetPlacementRow,
} from './types.js';

const MAX_EXCERPT_LEN = 200;

function excerptForLine(source: string, line: number): string | undefined {
  if (!Number.isInteger(line) || line < 1) return undefined;
  const lines = source.split(/\r?\n/);
  const text = lines[line - 1];
  if (text === undefined) return undefined;
  return text.length > MAX_EXCERPT_LEN ? `${text.slice(0, MAX_EXCERPT_LEN)}...` : text;
}

function makeSpan(
  line: number,
  col: number,
  source?: string,
  inferred = false,
): PolicySpan {
  const safeLine = Number.isInteger(line) && line >= 1 ? line : 1;
  const safeCol = Number.isInteger(col) && col >= 1 ? col : 1;
  const excerpt = source !== undefined ? excerptForLine(source, safeLine) : undefined;
  return {
    line: safeLine,
    col: safeCol,
    location: `${safeLine}:${safeCol}`,
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(inferred ? { inferred: true as const } : {}),
  };
}

export function spanFromLocation(location: string, source?: string): PolicySpan {
  const [rawLine, rawCol] = location.split(':');
  const line = Number(rawLine);
  const col = Number(rawCol);
  return makeSpan(
    Number.isFinite(line) ? line : 1,
    Number.isFinite(col) ? col : 1,
    source,
  );
}

function maskCommentsAndStrings(source: string): string {
  return source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g,
    (match) => match.replace(/[^\n]/g, ' '),
  );
}

function offsetToSpan(source: string, offset: number): PolicySpan {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return makeSpan(line, col, source, true);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findNthMatchOffset(masked: string, pattern: RegExp, nth: number): number | null {
  let count = 0;
  for (const m of masked.matchAll(pattern)) {
    count += 1;
    if (count === nth && m.index !== undefined) return m.index;
  }
  return null;
}

export function extractDiagnosticLocation(
  message: string,
  source: string,
): { span: PolicySpan | null; requirement?: string } {
  // Ohm parse error: "Line 4, col 12:"
  const ohmMatch = /\bLine\s+(\d+),\s*col\s+(\d+):/.exec(message);
  if (ohmMatch) {
    return {
      span: makeSpan(Number(ohmMatch[1]), Number(ohmMatch[2]), source),
    };
  }

  // Requirement static check error: "reqName at 5:3: ..."
  const reqMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+at\s+(\d+):(\d+):/.exec(message);
  if (reqMatch) {
    return {
      requirement: reqMatch[1],
      span: makeSpan(Number(reqMatch[2]), Number(reqMatch[3]), source),
    };
  }

  // Generic "at line:col" or leading "line:col:"
  const atMatch = /(?:\bat\s+|^)(\d+):(\d+)\b/.exec(message);
  if (atMatch) {
    return {
      span: makeSpan(Number(atMatch[1]), Number(atMatch[2]), source),
    };
  }

  // Heuristic declaration span lookup on comment/string-masked source.
  const masked = maskCommentsAndStrings(source);
  if (/^derive\s+(?:requires|must)\b/.test(message)) {
    const idx = findNthMatchOffset(masked, /\bderive\b/g, 1);
    if (idx !== null) return { span: offsetToSpan(source, idx) };
  }

  const recMatch = /^Recursive calls are unsupported at ([A-Za-z_][A-Za-z0-9_]*)/.exec(message);
  if (recMatch) {
    const idx = findNthMatchOffset(
      masked,
      new RegExp(`\\bfunction\\s+${escapeRegExp(recMatch[1]!)}\\b`, 'g'),
      1,
    );
    if (idx !== null) return { span: offsetToSpan(source, idx) };
  }

  const dupFn = /^Duplicate function ([A-Za-z_][A-Za-z0-9_]*)/.exec(message);
  if (dupFn) {
    const re = new RegExp(`\\bfunction\\s+${escapeRegExp(dupFn[1]!)}\\b`, 'g');
    const idx = findNthMatchOffset(masked, re, 2) ?? findNthMatchOffset(masked, re, 1);
    if (idx !== null) return { span: offsetToSpan(source, idx) };
  }

  const reservedFn = /^Reserved function name ([A-Za-z_][A-Za-z0-9_]*)/.exec(message);
  if (reservedFn) {
    const idx = findNthMatchOffset(
      masked,
      new RegExp(`\\bfunction\\s+${escapeRegExp(reservedFn[1]!)}\\b`, 'g'),
      1,
    );
    if (idx !== null) return { span: offsetToSpan(source, idx) };
  }

  const unknownExt = /^Unknown extension[:\s]+['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(message);
  if (unknownExt) {
    const idx = findNthMatchOffset(
      masked,
      new RegExp(`\\bextension\\s+${escapeRegExp(unknownExt[1]!)}\\b`, 'g'),
      1,
    );
    if (idx !== null) return { span: offsetToSpan(source, idx) };
  }

  const dupBind = /^Duplicate binding:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(message);
  if (dupBind) {
    const name = escapeRegExp(dupBind[1]!);
    const reqIdx = findNthMatchOffset(masked, new RegExp(`\\brequire\\s+${name}\\b`, 'g'), 2);
    if (reqIdx !== null) {
      return { span: offsetToSpan(source, reqIdx), requirement: dupBind[1] };
    }
    const letIdx = findNthMatchOffset(masked, new RegExp(`\\blet\\s+${name}\\b`, 'g'), 2);
    if (letIdx !== null) return { span: offsetToSpan(source, letIdx) };
  }

  return { span: null };
}

export function classifyCompilerErrorCode(
  message: string,
  stage: 'parse' | 'static-check',
): PolicyDiagnosticCode {
  if (stage === 'parse') {
    if (message.includes('exceeds parser nesting limit')) return 'NESTING_LIMIT_EXCEEDED';
    if (/exceeds \d+ characters/.test(message)) return 'SOURCE_TOO_LARGE';
    return 'SYNTAX_ERROR';
  }
  if (message.includes('expression limit must be an integer')) return 'EXPRESSION_LIMIT_ERROR';
  if (message.includes('requires use extension ')) return 'MISSING_EXTENSION';
  if (/unknown extension/i.test(message)) return 'UNKNOWN_EXTENSION';
  if (message.includes('Recursive calls are unsupported')) return 'RECURSIVE_CALL';
  if (/Duplicate (?:binding|function)|Reserved function name/.test(message)) {
    return 'DUPLICATE_DECLARATION';
  }
  if (/undeclared|unknown (?:identifier|binding|variable|function)/i.test(message)) {
    return 'UNDECLARED_IDENTIFIER';
  }
  if (/integer literal|out of range|number literal/i.test(message)) {
    return 'INVALID_LITERAL';
  }
  return 'STATIC_CHECK_ERROR';
}

export function makeCompilerDiagnostic(
  error: unknown,
  source: string,
  stage: 'parse' | 'static-check',
): PolicyCliDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const { span, requirement } = extractDiagnosticLocation(message, source);
  return {
    severity: 'error',
    code: classifyCompilerErrorCode(message, stage),
    stage,
    message,
    span,
    ...(requirement !== undefined ? { requirement } : {}),
  };
}

export function makeSimpleDiagnostic(
  code: PolicyDiagnosticCode,
  stage: PolicyDiagnosticStage,
  message: string,
  options: {
    severity?: 'error' | 'warning';
    span?: PolicySpan | null;
    target?: PolicyCliDiagnostic['target'];
    requirement?: string;
    scenario?: string;
  } = {},
): PolicyCliDiagnostic {
  return {
    severity: options.severity ?? 'error',
    code,
    stage,
    message,
    span: options.span ?? null,
    ...(options.target !== undefined ? { target: options.target } : {}),
    ...(options.requirement !== undefined ? { requirement: options.requirement } : {}),
    ...(options.scenario !== undefined ? { scenario: options.scenario } : {}),
  };
}

function classifySinglePlacementMessage(message: string): PlacementProblemDetail {
  let code: PlacementReasonCode = 'UNSUPPORTED_EXPRESSION';
  if (message.startsWith('Requires bounded.') || message.includes('decoded collection and bounded.')) {
    code = 'USES_BOUNDED_OP';
  } else if (message.startsWith('Materializing derive requires')) {
    code = 'USES_DERIVE_COLLECTION';
  } else if (message.startsWith('Requires derive')) {
    code = 'USES_DERIVE';
  } else if (message.startsWith('Requires helper functions')) {
    code = 'USES_HELPER_FUNCTIONS';
  } else if (message.startsWith('Requires local bindings')) {
    code = 'USES_LOCAL_BINDINGS';
  } else if (message.startsWith('Missing binding:')) {
    code = 'MISSING_BINDING';
  } else if (
    message.startsWith('Wrong snapshot:') ||
    message.includes(' requires before, bound to') ||
    message.includes(' requires after, bound to')
  ) {
    code = 'WRONG_SNAPSHOT_ORIGIN';
  } else if (message.includes('requires a trusted stored input')) {
    code = 'UNTRUSTED_DERIVE_INPUT';
  } else if (message.includes('projection budget')) {
    code = 'PROJECTION_BUDGET_EXCEEDED';
  } else if (message.includes('budget')) {
    code = 'EXPRESSION_BUDGET_EXCEEDED';
  } else if (message.startsWith('Unverified derive outputs:')) {
    code = 'UNVERIFIED_DERIVE_SIBLINGS';
  } else if (
    message.startsWith('Invalid Storage ') ||
    message.startsWith('Invalid Firestore read') ||
    message.startsWith('Expected a Storage data projection') ||
    message.startsWith('Expected a data projection')
  ) {
    code = 'INVALID_BINDING_PROJECTION';
  }
  return { code, message };
}

function splitReasonMessages(reason: string): string[] {
  return reason
    .split(/;\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function finalizeTargetReport(
  target: 'firestore' | 'storage' | 'rtdb',
  rows: TargetPlacementRow[],
): TargetPlacementReport {
  const loweredRequirements = rows.filter((r) => r.lowered).map((r) => r.requirement);
  const residualRequirements = rows.filter((r) => !r.lowered).map((r) => r.requirement);
  return {
    target,
    complete: residualRequirements.length === 0,
    summary: {
      total: rows.length,
      lowered: loweredRequirements.length,
      residual: residualRequirements.length,
      loweredRequirements,
      residualRequirements,
    },
    rows,
  };
}

export function buildFirestorePlacementReport(
  rows: readonly RawFirestoreRow[],
  source: string,
): TargetPlacementReport {
  const normalized: TargetPlacementRow[] = rows.map((row) => ({
    requirement: row.requirement,
    location: row.location,
    span: makeSpan(row.span.line, row.span.col, source),
    source: row.source,
    enforcement: row.enforcement,
    lowered: Boolean(row.predicate) && row.completeReason === undefined,
    reason: row.reason,
    ...(row.completeReason !== undefined ? { completeReason: row.completeReason } : {}),
    ...(row.predicate !== undefined ? { predicate: row.predicate } : {}),
    features: [...row.features],
    inputs: [...row.inputs],
    origins: { ...row.origins },
    bindings: { ...row.bindings },
    diagnostics: row.diagnostics.map((d) => ({ ...d })),
    cost: { ...row.cost, boundedOps: row.cost.boundedOps.map((b) => ({ ...b })) },
  }));
  return finalizeTargetReport('firestore', normalized);
}

export function buildRtdbPlacementReport(
  rows: readonly RawRtdbRow[],
  source: string,
): TargetPlacementReport {
  const normalized: TargetPlacementRow[] = rows.map((row) => ({
    requirement: row.requirement,
    location: row.span.location,
    span: makeSpan(row.span.line, row.span.col, source),
    source: row.source,
    enforcement: row.enforcement,
    lowered: Boolean(row.predicate),
    reason: row.reason,
    ...(row.predicate !== undefined ? { predicate: row.predicate } : {}),
    features: [...row.features],
    inputs: [...row.inputs],
    bindings: { ...row.bindings },
    diagnostics: row.diagnostics.map((d) => ({ ...d })),
    cost: { ...row.cost, boundedOps: row.cost.boundedOps.map((b) => ({ ...b })) },
  }));
  return finalizeTargetReport('rtdb', normalized);
}

export function buildStoragePlacementReport(
  rows: readonly RawStorageRow[],
  baselineCosts: ReadonlyMap<string, ExpressionCostBreakdown>,
  expressionLimit: number,
  source: string,
): TargetPlacementReport {
  const normalized: TargetPlacementRow[] = rows.map((row) => {
    const hasPredicate = Boolean(row.predicate);
    const diagnostics: PlacementProblemDetail[] = hasPredicate
      ? [{ code: 'LOWERED', message: row.reason }]
      : splitReasonMessages(row.reason).map(classifySinglePlacementMessage);
    if (row.completeReason !== undefined) {
      diagnostics.push(classifySinglePlacementMessage(row.completeReason));
    }
    const base = baselineCosts.get(row.requirement);
    const cost: ExpressionCostBreakdown = base
      ? {
          sourceUnits: base.sourceUnits,
          sourceLimit: base.sourceLimit,
          targetUnits: null,
          targetLimit: null,
          withinSourceBudget: base.withinSourceBudget,
          withinTargetBudget: null,
          letUnits: base.letUnits,
          conditionUnits: base.conditionUnits,
          boundedOps: base.boundedOps.map((b) => ({ ...b })),
        }
      : {
          sourceUnits: 0,
          sourceLimit: expressionLimit,
          targetUnits: null,
          targetLimit: null,
          withinSourceBudget: true,
          withinTargetBudget: null,
          letUnits: 0,
          conditionUnits: 0,
          boundedOps: [],
        };
    return {
      requirement: row.requirement,
      location: row.location,
      span: spanFromLocation(row.location, source),
      source: row.source,
      enforcement: row.enforcement,
      lowered: hasPredicate && row.completeReason === undefined,
      reason: row.reason,
      ...(row.completeReason !== undefined ? { completeReason: row.completeReason } : {}),
      ...(row.predicate !== undefined ? { predicate: row.predicate } : {}),
      features: [...row.features],
      inputs: [...row.inputs],
      origins: { ...row.origins },
      bindings: { ...row.bindings },
      diagnostics,
      cost,
    };
  });
  return finalizeTargetReport('storage', normalized);
}

function summarizeTargetCost(report: TargetPlacementReport) {
  let sum = 0;
  let hasTargetUnits = false;
  let targetLimit: number | null = null;
  let withinAll: boolean | null = null;
  for (const row of report.rows) {
    if (row.cost.targetLimit !== null) targetLimit = row.cost.targetLimit;
    if (row.cost.targetUnits !== null) {
      hasTargetUnits = true;
      sum += row.cost.targetUnits;
    }
    if (row.cost.withinTargetBudget !== null) {
      withinAll = withinAll === null ? row.cost.withinTargetBudget : withinAll && row.cost.withinTargetBudget;
    }
  }
  return {
    totalTargetUnits: hasTargetUnits ? sum : null,
    targetLimit,
    withinTargetBudget:
      hasTargetUnits && targetLimit !== null ? sum <= targetLimit && withinAll !== false : withinAll,
  };
}

export function estimateGenericIrUnits(
  node: unknown,
  boundedOps: BoundedOpCostDetail[],
): number {
  if (!node || typeof node !== 'object') return 0;
  const expr = node as Record<string, unknown>;
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return 1;
    case 'ternary':
      return (
        4 +
        estimateGenericIrUnits(expr.condition, boundedOps) +
        Math.max(
          estimateGenericIrUnits(expr.consequent, boundedOps),
          estimateGenericIrUnits(expr.alternate, boundedOps),
        )
      );
    case 'isExpr':
      return 2 + estimateGenericIrUnits(expr.value, boundedOps);
    case 'binaryOp':
      return (
        (expr.op === '&&' || expr.op === '||' ? 2 : 1) +
        estimateGenericIrUnits(expr.left, boundedOps) +
        estimateGenericIrUnits(expr.right, boundedOps)
      );
    case 'boundedOp': {
      const limit = typeof expr.limit === 'number' ? expr.limit : 0;
      const listCost = estimateGenericIrUnits(expr.list, boundedOps);
      let worst: number;
      if (expr.op === 'append') {
        worst = listCost + estimateGenericIrUnits(expr.suffix, boundedOps) + limit;
      } else if (expr.op === 'fold') {
        const initCost = estimateGenericIrUnits(expr.initial, boundedOps);
        const lets = Array.isArray(expr.lets) ? expr.lets : [];
        const letCost = lets.reduce(
          (s: number, l) => s + 1 + estimateGenericIrUnits((l as { value?: unknown }).value, boundedOps),
          0,
        );
        worst = listCost + initCost + limit * (1 + letCost + estimateGenericIrUnits(expr.body, boundedOps));
      } else {
        worst = listCost + limit * (1 + estimateGenericIrUnits(expr.body, boundedOps));
      }
      boundedOps.push({
        op: `bounded.${String(expr.op)}`,
        limit,
        estimatedWorstCaseUnits: worst,
      });
      return worst;
    }
    default: {
      let total = 1;
      for (const key of ['object', 'index', 'start', 'end', 'operand', 'element', 'collection']) {
        if (expr[key] !== undefined) total += estimateGenericIrUnits(expr[key], boundedOps);
      }
      for (const arrKey of ['args', 'elements']) {
        const list = expr[arrKey];
        if (Array.isArray(list)) {
          for (const item of list) total += estimateGenericIrUnits(item, boundedOps);
        }
      }
      if (Array.isArray(expr.entries)) {
        for (const entry of expr.entries as Array<{ key?: unknown; value?: unknown }>) {
          total += estimateGenericIrUnits(entry.key, boundedOps);
          total += estimateGenericIrUnits(entry.value, boundedOps);
        }
      }
      if (Array.isArray(expr.segments)) {
        for (const seg of expr.segments) {
          if (typeof seg !== 'string') total += estimateGenericIrUnits(seg, boundedOps);
        }
      }
      return total;
    }
  }
}

export function buildCostSummary(
  expressionLimit: number,
  items: PolicyCostItem[],
  placement: PolicyPlacementSummary,
): PolicyCostSummary {
  let totalSourceUnits = 0;
  let maxItemUnits = 0;
  let withinSourceBudget = true;
  const boundedOps: Array<BoundedOpCostDetail & { owner: string }> = [];
  for (const item of items) {
    totalSourceUnits += item.cost.sourceUnits;
    if (item.cost.sourceUnits > maxItemUnits) maxItemUnits = item.cost.sourceUnits;
    if (!item.cost.withinSourceBudget) withinSourceBudget = false;
    for (const op of item.cost.boundedOps) {
      boundedOps.push({ owner: item.name, ...op });
    }
  }
  const byTarget: PolicyCostSummary['byTarget'] = {};
  if (placement.firestore) byTarget.firestore = summarizeTargetCost(placement.firestore);
  if (placement.storage) byTarget.storage = summarizeTargetCost(placement.storage);
  if (placement.rtdb) byTarget.rtdb = summarizeTargetCost(placement.rtdb);
  return {
    expressionLimit,
    totalSourceUnits,
    maxItemUnits,
    withinSourceBudget: withinSourceBudget && totalSourceUnits <= expressionLimit,
    boundedOps,
    items,
    byTarget,
  };
}

export function emptyCostSummary(expressionLimit: number): PolicyCostSummary {
  return {
    expressionLimit,
    totalSourceUnits: 0,
    maxItemUnits: 0,
    withinSourceBudget: true,
    boundedOps: [],
    items: [],
    byTarget: {},
  };
}

export function functionCostItems(functions: readonly FunctionPlacementItem[]): PolicyCostItem[] {
  return functions.map((fn) => ({
    name: fn.name,
    kind: 'function' as const,
    span: fn.span,
    cost: fn.cost,
  }));
}
