/**
 * Live `unevaluated` verdict inspection projection for Studio Traffic (`verdict.ts`).
 */
import type { ObservedProduction } from 'pyric/sandbox';
import { productionVerdict, rtdbRulesMethod, rulesOperation } from 'pyric/sandbox/internal';
import { locateRtdbRule } from 'pyric/rules/internal/rtdb';

import { declaredOperations, type StudioTrafficEvent } from './verdict.js';

type LiveUnevaluatedLocal = Extract<
  NonNullable<ObservedProduction['local']>,
  { result: 'unevaluated' }
>;
type LiveVerdictGap = LiveUnevaluatedLocal['needs'][number];

interface LiveUnevaluatedGapDetail {
  gap: LiveVerdictGap;
  label: string;
  detail: string;
}

export interface LiveUnevaluatedRuleContext {
  engine: 'firestore' | 'rtdb';
  nodeLabel?: string;
  line?: number;
  expression?: string;
  pathVariableBindings?: Record<string, string>;
}

export interface LiveUnevaluatedInspection {
  service: string;
  method: string;
  rawMethod: string;
  path: string;
  headline: string;
  gaps: LiveUnevaluatedGapDetail[];
  missingPaths?: string[];
  ruleContext?: LiveUnevaluatedRuleContext;
}

const RTDB_GAP_DETAILS: Readonly<Record<LiveVerdictGap, { label: string; detail: string }>> = {
  'stored-document': {
    label: 'stored-document (data / root)',
    detail:
      'The rule reads existing database state (`data` or `root`), which Live mode does not fetch from production.',
  },
  'write-data': {
    label: 'write-data (newData)',
    detail:
      'Realtime Database write payloads (`newData`) are not captured on observed live calls, so `.write` and `.validate` conditions that depend on the written value cannot be proven locally.',
  },
  'claim-values': {
    label: 'claim-values (auth.token)',
    detail:
      'The rule inspects ID token claim values (`auth.token`, including redacted email claims) that were not available to the local evaluator.',
  },
  query: {
    label: 'query (query.*)',
    detail:
      'The rule inspects query parameters (`query.orderByChild`, `query.equalTo`, limits, or bounds) that were not captured on the observed RTDB call.',
  },
};

const FIRESTORE_GAP_DETAILS: Readonly<Record<LiveVerdictGap, { label: string; detail: string }>> = {
  'stored-document': {
    label: 'stored-document (resource / get / exists)',
    detail:
      'The rule reads stored document state (`resource.data`, `get()`, or `exists()`) that was not captured with this observed call.',
  },
  'write-data': {
    label: 'write-data (request.resource.data)',
    detail:
      'The rule inspects incoming write fields (`request.resource.data`) that were not captured with this observed call.',
  },
  'claim-values': {
    label: 'claim-values (request.auth.token)',
    detail:
      'The rule inspects ID token claim values (`request.auth.token`, including redacted email claims) that were not available to the local evaluator.',
  },
  query: {
    label: 'query (request.query)',
    detail:
      'The rule inspects query constraints (`request.query`) whose parameter values are not sent off the client in Live mode.',
  },
};

function liveProductionSentence(
  outcome: ObservedProduction['outcome'],
  method: string,
  path: string,
): string {
  if (outcome.status === 'ok') return `Production allowed ${method} on ${path}.`;
  if (productionVerdict(outcome) === 'denied') return `Production denied ${method} on ${path}.`;
  return `Production failed ${method} on ${path} (${outcome.code}).`;
}

function rtdbUnevaluatedRuleContext(
  local: LiveUnevaluatedLocal,
  rawMethod: string,
  rulesSource: string | undefined,
): LiveUnevaluatedRuleContext | undefined {
  const request = rtdbRulesMethod(rawMethod);
  const isRead = request === 'get' || request === 'list';
  const phase = isRead ? 'read' : 'write';
  let matchedPath = local.rtdb?.matchedPath;
  if (matchedPath === undefined || matchedPath === '') {
    matchedPath = local.rule?.path;
  }
  let expression = local.rtdb?.matchedRule;
  if (expression === undefined || expression === '') {
    expression = local.rule?.expression;
  }
  const bindings = local.rtdb?.pathVariableBindings;
  const hasBindings = bindings !== undefined && Object.keys(bindings).length > 0;
  const hasMatchedPath = matchedPath !== undefined && matchedPath !== '';
  const hasExpression = expression !== undefined && expression !== '';
  if (!hasMatchedPath && !hasExpression && !hasBindings) {
    return undefined;
  }
  const context: LiveUnevaluatedRuleContext = { engine: 'rtdb' };
  if (matchedPath !== undefined && matchedPath !== '') {
    context.nodeLabel = `${matchedPath} .${phase}`;
    if (rulesSource !== undefined && rulesSource.trim() !== '') {
      const located = locateRtdbRule(rulesSource, matchedPath, `.${phase}`);
      if (located !== null && located !== undefined) {
        context.line = located.line;
      }
    }
  }
  if (expression !== undefined && expression !== '') context.expression = expression;
  if (bindings !== undefined && Object.keys(bindings).length > 0) {
    context.pathVariableBindings = bindings;
  }
  return context;
}

function firestoreUnevaluatedRuleContext(
  local: LiveUnevaluatedLocal,
  rulesSource: string | undefined,
): LiveUnevaluatedRuleContext | undefined {
  const rule = local.rule;
  if (rule === undefined) return undefined;
  const context: LiveUnevaluatedRuleContext = { engine: 'firestore' };
  if (rule.line !== undefined) context.line = rule.line;
  if (rule.expression !== undefined && rule.expression !== '') {
    context.expression = rule.expression;
  }
  const operations = declaredOperations(rulesSource, rule.line);
  if (operations !== undefined) {
    context.nodeLabel = `allow ${operations.join(', ')}`;
  } else if (rule.path !== undefined && rule.path !== '') {
    context.nodeLabel = rule.path;
  }
  return context;
}

function storedDocumentGapDetail(
  service: string,
  missingPaths: readonly string[] | undefined,
  fallback: string,
): string {
  if (missingPaths === undefined || missingPaths.length === 0) return fallback;
  const noun = service === 'rtdb' ? 'existing database state' : 'stored document state';
  if (missingPaths.length === 1) {
    return `The rule reads ${noun} at ${missingPaths[0]}, which has not been observed in full during this Live session.`;
  }
  return `The rule reads ${noun} at uncaptured paths (${missingPaths.join(', ')}) that have not been observed in full during this Live session.`;
}

function buildGapEntry(
  gap: LiveVerdictGap,
  service: string,
  missingPaths: readonly string[] | undefined,
  gapTable: Readonly<Record<LiveVerdictGap, { label: string; detail: string }>>,
): LiveUnevaluatedGapDetail {
  const entry = gapTable[gap];
  let detail = entry.detail;
  if (gap === 'stored-document') {
    detail = storedDocumentGapDetail(service, missingPaths, entry.detail);
  }
  return { gap, label: entry.label, detail };
}

export function liveUnevaluatedInspection(
  event: StudioTrafficEvent,
  rulesSource?: string,
): LiveUnevaluatedInspection | undefined {
  const production = event.production;
  const local = production?.local;
  if (production === undefined || local === undefined || local.result !== 'unevaluated') {
    return undefined;
  }
  const service = event.service ?? 'firestore';
  const normalizedMethod = rulesOperation(service, event.method);
  const gapTable = service === 'rtdb' ? RTDB_GAP_DETAILS : FIRESTORE_GAP_DETAILS;
  let missingPaths: string[] | undefined;
  if (local.missingPaths !== undefined && local.missingPaths.length > 0) {
    missingPaths = [...local.missingPaths];
  }
  const gaps = local.needs.map((gap) => buildGapEntry(gap, service, missingPaths, gapTable));
  const lead = liveProductionSentence(production.outcome, event.method, event.path);
  const headline = `${lead} Local rules proof stopped because runtime inputs needed by the rule were not captured.`;
  const inspection: LiveUnevaluatedInspection = {
    service,
    method: normalizedMethod,
    rawMethod: event.method,
    path: event.path,
    headline,
    gaps,
  };
  if (missingPaths !== undefined) {
    inspection.missingPaths = missingPaths;
  }
  let ruleContext: LiveUnevaluatedRuleContext | undefined;
  if (service === 'rtdb') {
    ruleContext = rtdbUnevaluatedRuleContext(local, event.method, rulesSource);
  } else {
    ruleContext = firestoreUnevaluatedRuleContext(local, rulesSource);
  }
  if (ruleContext !== undefined) {
    inspection.ruleContext = ruleContext;
  }
  return inspection;
}
