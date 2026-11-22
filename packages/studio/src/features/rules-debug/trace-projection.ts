/**
 * Sub-expression trace, RTDB cascade trace, and request/resource variable
 * projections for Pyric Studio's rules debugger (`model.ts`).
 */
import type { ExprTraceEntry } from 'pyric/rules/internal';
import { locateRtdbTrace, type RtdbRuleEvaluation } from 'pyric/rules/internal/rtdb';

import type { Denial } from './model.js';

export interface TraceStep {
  source: string;
  outcome: 'true' | 'false' | 'skipped' | 'error' | 'unsupported' | 'value';
  value?: unknown;
  error?: string;
  letBinding?: string;
  inlinedFrom?: string;
  depth: number;
  children: TraceStep[];
}

function classifyOutcome(e: ExprTraceEntry): TraceStep['outcome'] {
  if (e.skipped) return 'skipped';
  if (e.error !== undefined) return 'error';
  if (e.value === true) return 'true';
  if (e.value === false) return 'false';
  return 'value';
}

export function projectTraceSteps(denial: Denial): TraceStep[] {
  const entries = denial.evaluatedRule?.expressionTrace;
  if (!entries || entries.length === 0) return [];
  const nodes: TraceStep[] = entries.map((e) => {
    const step: TraceStep = {
      source: e.source,
      outcome: classifyOutcome(e),
      depth: 0,
      children: [],
    };
    if (e.value !== undefined) step.value = e.value;
    if (e.error !== undefined) step.error = e.error;
    if (e.letBinding) step.letBinding = e.letBinding.name;
    if (e.inlinedFrom) step.inlinedFrom = e.inlinedFrom.name;
    return step;
  });
  const roots: TraceStep[] = [];
  entries.forEach((e, i) => {
    const node = nodes[i]!;
    if (e.parent === null || e.parent === undefined || !nodes[e.parent]) {
      roots.push(node);
    } else {
      const parentNode = nodes[e.parent]!;
      node.depth = parentNode.depth + 1;
      parentNode.children.push(node);
    }
  });
  return roots;
}

const RTDB_VERDICT_OUTCOME: Record<RtdbRuleEvaluation['verdict'], TraceStep['outcome']> = {
  ALLOW: 'true',
  DENY: 'false',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
};

export interface RtdbTraceRow {
  path: string;
  kind: RtdbRuleEvaluation['kind'];
  verdict: RtdbRuleEvaluation['verdict'];
  step: TraceStep;
  bindings: Record<string, string>;
  line?: number;
}

export function projectRtdbTrace(denial: Denial, rulesSource?: string): RtdbTraceRow[] {
  const trace = denial.rules?.rtdbTrace;
  if (!trace || trace.length === 0) return [];
  let located: Array<RtdbRuleEvaluation & { line?: number }>;
  if (rulesSource === undefined) {
    located = [...trace];
  } else {
    located = locateRtdbTrace(rulesSource, trace);
  }
  return located.map((entry) => {
    const step: TraceStep = {
      source: entry.conditionText,
      outcome: RTDB_VERDICT_OUTCOME[entry.verdict],
      depth: 0,
      children: [],
    };
    if (entry.verdict === 'ALLOW' || entry.verdict === 'DENY') {
      step.value = entry.verdict === 'ALLOW';
    }
    if (entry.message !== undefined) {
      step.error = entry.message;
    }
    const row: RtdbTraceRow = {
      path: entry.path,
      kind: entry.kind,
      verdict: entry.verdict,
      step,
      bindings: entry.pathVariableBindings,
    };
    if (entry.line !== undefined) row.line = entry.line;
    return row;
  });
}

export interface RuleVariable {
  name: string;
  present: boolean;
  value: unknown;
  absentNote?: string;
}

export function ruleVariables(denial: Denial): RuleVariable[] {
  const vars: RuleVariable[] = [];
  if (denial.database !== undefined) {
    vars.push({
      name: 'database',
      present: true,
      value: denial.database,
    });
  }
  const authVar: RuleVariable = {
    name: 'request.auth',
    present: denial.auth !== null,
    value: denial.auth,
  };
  if (denial.auth === null) {
    authVar.absentNote = 'request.auth was null - the request was unauthenticated.';
  }
  vars.push(authVar);
  vars.push({ name: 'request.method', present: true, value: denial.method });
  vars.push({ name: 'request.path', present: true, value: denial.path });

  const isRead = denial.method === 'get' || denial.method === 'list' || denial.method === 'listen';
  const reqResVar: RuleVariable = {
    name: 'request.resource.data',
    present: denial.resourceData !== undefined,
    value: denial.resourceData ?? null,
  };
  if (denial.resourceData === undefined) {
    if (isRead) {
      reqResVar.absentNote = 'A read carries no proposed write, so request.resource.data is absent.';
    } else {
      reqResVar.absentNote = 'No proposed write payload was captured for this denial.';
    }
  }
  vars.push(reqResVar);

  let resourceValue: { data: unknown; exists: boolean } | null = null;
  if (denial.resourceBefore !== undefined) {
    resourceValue = {
      data: denial.resourceBefore.data,
      exists: denial.resourceBefore.exists,
    };
  }
  const resVar: RuleVariable = {
    name: 'resource',
    present: denial.resourceBefore !== undefined,
    value: resourceValue,
  };
  if (denial.resourceBefore === undefined) {
    resVar.absentNote =
      'The rule evaluated no existing document (e.g. a list/query, or the doc did not exist).';
  }
  vars.push(resVar);
  return vars;
}
