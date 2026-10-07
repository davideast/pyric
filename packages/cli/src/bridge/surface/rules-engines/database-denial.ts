/**
 * Why one Realtime Database request was denied: the deciding rule, its kind,
 * path and expression, how it failed, and what would make the request pass.
 *
 * The explanation is read from the simulation result. Its `trace` lists every
 * rule the engine evaluated with that rule's verdict and message, and the
 * result's `matchedPath` and `matchedRule` pick the deciding entry from it.
 * The trace is the shape `rules.simulate` returns. When file text is known,
 * each entry also carries the line of its rule key: the text of a draft passed
 * as `rules`, or a `source` that parses to the running ruleset. The result
 * names which ruleset it evaluated, running or draft.
 */
import { getActiveRules } from 'pyric/sandbox/database';
import type { RtdbCaseResult, RtdbRuleEvaluation, RtdbRulesJson } from 'pyric/rules';
import { locateRtdbTrace } from 'pyric/rules/internal/rtdb';
import type { LocatedRtdbRuleEvaluation } from 'pyric/rules/internal/rtdb';
import { operationFailure } from '../context.js';
import type { OperationResult, SurfaceContext } from '../types.js';
import {
  identityFor,
  NO_RULES_LOADED,
  notRules,
  parseRuleset,
  rooted,
  simulateAgainst,
} from './database.js';

/** One request to explain. `data` is any JSON value, as a database write is. */
export interface DatabaseDenialRequest {
  operation: string;
  path: string;
  uid?: string;
  /** The value written; for an `update`, the patch keyed by paths relative to `path`. */
  data?: unknown;
  /** The query a `read` carries, in the members rules read as `query.*`. */
  query?: Record<string, unknown>;
  requestTime?: string;
  /** A draft ruleset, as rules file text, to evaluate instead of the running one. */
  rules?: string;
  /** The text of the rules file the running ruleset was loaded from, used for line lookup only. */
  source?: string;
}

/** The rule kinds a database ruleset carries. */
type RuleKind = RtdbRuleEvaluation['kind'];

/** How the deciding rule failed. */
type DenialCause = 'evaluated-false' | 'runtime-error' | 'no-rule-grants' | 'unsupported';

/** The trace entry shape `rules.simulate` returns: the engine's entry plus its file line when known. */
type TraceEntry = LocatedRtdbRuleEvaluation;

/** The rule kind a request operation exercises: a multi-path `update` is judged by `.write` rules. */
function ruleKindOf(operation: string): RuleKind {
  return operation === 'update' ? 'write' : (operation as RuleKind);
}

/** Whether two parsed rulesets are the same JSON, whatever the key order. */
function sameRules(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, canonical(record[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** The entry that decided the request: the last one matching the result's rule. */
function decidingEntry(trace: readonly TraceEntry[], result: RtdbCaseResult): TraceEntry | null {
  if (result.matchedPath === '' && result.matchedRule === '') return null;
  for (let at = trace.length - 1; at >= 0; at -= 1) {
    const entry = trace[at];
    if (entry.path === result.matchedPath && entry.conditionText === result.matchedRule) return entry;
  }
  return null;
}

function causeOf(deciding: TraceEntry | null, result: RtdbCaseResult): DenialCause {
  if (result.unsupported || deciding?.verdict === 'UNSUPPORTED') return 'unsupported';
  if (deciding === null) {
    return result.matchedPath === '' ? 'no-rule-grants' : 'evaluated-false';
  }
  if (deciding.verdict === 'ERROR') return 'runtime-error';
  return 'evaluated-false';
}

/** A sentence for the cause, naming the rule. */
function reasonOf(
  cause: DenialCause,
  deciding: TraceEntry | null,
  operation: RuleKind,
  result: RtdbCaseResult,
  path: string,
  trace: readonly TraceEntry[],
): string {
  if (cause === 'unsupported') return result.reason;
  if (cause === 'no-rule-grants') {
    return `No '.${operation}' rule on '${path}' or any ancestor grants the request, so it is denied by default.`;
  }
  const kind = deciding?.kind ?? operation;
  const where = `at '${result.matchedPath}'`;
  if (cause === 'runtime-error') {
    const effect = kind === 'validate' ? 'rejects the write' : 'does not grant';
    const message = (deciding?.message ?? '').replace(/\.$/, '');
    return `The '.${kind}' rule ${where} raised RtdbRuleRuntimeError: ${message}. A rule that raises an error ${effect}.`;
  }
  if (kind === 'validate') {
    const granted = trace.some((entry) => entry.kind === 'write' && entry.verdict === 'ALLOW');
    const grant = granted
      ? " A '.write' rule granted the write, and every '.validate' rule on the path must also pass."
      : '';
    return `The '.validate' rule ${where} evaluated to false: ${result.matchedRule}.${grant}`;
  }
  const checked = trace.filter((entry) => entry.kind === kind).length;
  const levels = checked > 1 ? ` None of the ${checked} '.${kind}' rules on the path granted.` : '';
  return `No '.${operation}' rule granted. The deciding rule, ${where}, evaluated to false: ${result.matchedRule}.${levels}`;
}

/** The uid a rule compares `auth.uid` with, as a `$wildcard` binding, when the expression has that form. */
function boundUidOf(expression: string, bindings: Record<string, string>): string | null {
  const forward = /\bauth\.uid\s*===?\s*(\$\w+)/.exec(expression);
  const reverse = /(\$\w+)\s*===?\s*auth\.uid\b/.exec(expression);
  const name = forward?.[1] ?? reverse?.[1];
  return name === undefined ? null : (bindings[name] ?? null);
}

/** What would make the request pass, where it can be stated; null otherwise. */
function fixOf(
  cause: DenialCause,
  deciding: TraceEntry | null,
  operation: RuleKind,
  result: RtdbCaseResult,
  path: string,
  authenticated: boolean,
): string | null {
  if (cause === 'unsupported') return null;
  if (cause === 'no-rule-grants') {
    return `Add a '.${operation}' rule on '${path}' or an ancestor that grants this request.`;
  }
  const kind = deciding?.kind ?? operation;
  if (cause === 'runtime-error') {
    const target = kind === 'validate' ? 'the written value' : 'the data the rule reads';
    return `Change the '.${kind}' expression at '${result.matchedPath}' so it cannot raise for ${target}, for example by checking the value's type first.`;
  }
  if (kind === 'validate') {
    return `Write a value at '${result.matchedPath}' that satisfies: ${result.matchedRule}.`;
  }
  const uid = boundUidOf(result.matchedRule, deciding?.pathVariableBindings ?? {});
  if (uid !== null) return `Run the request as uid '${uid}'.`;
  if (!authenticated && /\bauth\b/.test(result.matchedRule)) {
    return 'Make the request authenticated by passing a uid; the rule reads auth.';
  }
  return null;
}

/**
 * The ruleset to evaluate and the file text its lines are read from. A draft
 * is evaluated from its own text. The running ruleset has no text, so lines
 * come from `source` only when it parses to the same ruleset.
 */
function rulesetFor(
  ctx: SurfaceContext,
  request: DatabaseDenialRequest,
): { ruleset: RtdbRulesJson; evaluated: 'running' | 'draft'; text?: string; notes: string[] } | OperationResult {
  const notes: string[] = [];
  if (request.rules !== undefined) {
    const parsed = parseRuleset(request.rules);
    if ('problem' in parsed) return operationFailure(notRules(parsed.problem));
    return { ruleset: parsed.ruleset, evaluated: 'draft', text: request.rules, notes };
  }
  const running = getActiveRules(ctx.sandbox);
  if (running === null) return operationFailure(NO_RULES_LOADED);
  if (request.source === undefined) return { ruleset: running, evaluated: 'running', notes };
  const parsed = parseRuleset(request.source);
  if ('ruleset' in parsed && sameRules(parsed.ruleset, running)) {
    return { ruleset: running, evaluated: 'running', text: request.source, notes };
  }
  notes.push(
    'The supplied source is not the running ruleset, so the trace carries no file lines. Pass it as rules to evaluate it as a draft.',
  );
  return { ruleset: running, evaluated: 'running', notes };
}

/** Explain why one database request was allowed or denied, rule by rule. */
export function explainDatabaseDenial(
  ctx: SurfaceContext,
  request: DatabaseDenialRequest,
): OperationResult {
  const chosen = rulesetFor(ctx, request);
  if ('ok' in chosen) return chosen;

  const operation = ruleKindOf(request.operation);
  const auth = identityFor(ctx, request.uid);
  const result = simulateAgainst(ctx, chosen.ruleset, request, auth);
  const allowed = result.decision === 'ALLOW';
  const path = rooted(request.path);
  const trace: TraceEntry[] =
    chosen.text === undefined ? result.trace : locateRtdbTrace(chosen.text, result.trace);
  const deciding = decidingEntry(trace, result);

  const base = {
    decision: result.decision,
    operation: request.operation,
    path,
    matchedPath: result.matchedPath,
    matchedRule: result.matchedRule,
    bindings: deciding?.pathVariableBindings ?? {},
    trace,
    notes: chosen.notes,
  };
  const summary = `${request.operation} ${request.path} is ${allowed ? 'allowed' : 'denied'} for this identity.`;
  const identity = auth === null ? null : { uid: auth.uid, token: auth.claims };
  const wrap = (detail: Record<string, unknown>): OperationResult => ({
    ok: true,
    summary,
    data: { allowed, evaluated: chosen.evaluated, auth: identity, case: detail },
  });

  if (allowed) {
    return wrap({ ...base, ruleKind: deciding?.kind ?? operation, reason: result.reason });
  }

  const cause = causeOf(deciding, result);
  const detail: Record<string, unknown> = {
    ...base,
    ruleKind: deciding?.kind ?? operation,
    why: cause,
    reason: reasonOf(cause, deciding, operation, result, path, trace),
  };
  if (cause === 'runtime-error' && deciding?.message !== undefined) {
    detail.runtimeError = deciding.message;
  }
  if (deciding?.line !== undefined) detail.line = deciding.line;
  const fix = fixOf(cause, deciding, operation, result, path, auth !== null);
  if (fix !== null) detail.fix = fix;
  return wrap(detail);
}
