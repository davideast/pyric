import { observationPayload } from './internal/observation-payload.js';
/**
 * Canonical operation records.
 *
 * Firestore still emits its legacy `request` shape while RTDB and Storage emit
 * `operation`. This module is the one deep normalization seam above those
 * adapters: activity consumers receive the same provenance and Rules model
 * without knowing which service emitted the event or which legacy marker it
 * used for an admin bypass.
 */
import type { AuthState } from './types/auth-state.js';
import type { ObservedProduction } from './types/observed-call.js';
import type {
  AuthLens,
  EventActor,
  EventProvenance,
  EventService,
  OperationContext,
  RequestEvent,
  RulesDisposition,
  SandboxEvent,
  SandboxListenerEvent,
  SandboxOperationEvent,
} from './types/events.js';

/** The deciding rule for a denial, carrying only the location and text fields available. */
export interface OperationDenialRule {
  readonly path?: string;
  readonly citation?: string;
  readonly line?: number;
  readonly column?: number;
  readonly expression?: string;
}

/** Diagnostic explanation of a rules-evaluated or fail-closed denial. */
export interface OperationDenial {
  readonly reasons: readonly string[];
  readonly rule?: OperationDenialRule;
  readonly evidenceExpired?: true;
}

export interface OperationRecord {
  readonly observation?: import('./types/request-observation.js').RequestObservation;
  readonly id: string;
  readonly at: number;
  readonly eventKind: 'request' | 'operation' | 'listener';
  readonly service: EventService;
  readonly method: string;
  readonly path?: string;
  readonly auth: AuthState;
  readonly result?: RequestEvent['result'] | SandboxOperationEvent['result'] | SandboxListenerEvent['result'];
  readonly context: OperationContext;
  readonly rules: RulesDisposition;
  readonly denial?: OperationDenial;
  readonly queryProof?: RequestEvent['queryProof'];
  /** What production answered, for a call production served and pyric observed. */
  readonly production?: ObservedProduction;
}

type OperationEvent = (RequestEvent | SandboxOperationEvent | SandboxListenerEvent) & EventProvenance;

export function isOperationEvent(event: SandboxEvent): event is OperationEvent {
  if (event.kind === 'request' || event.kind === 'operation') {
    return true;
  }
  if (event.kind === 'listener') {
    if (event.phase === 'errored') {
      return true;
    }
  }
  return false;
}

/** Build an immutable context. Cloning + freezing here means callers can bind
 * one context to a handle without a later mutation changing in-flight async
 * operations. */
export function immutableOperationContext(context: OperationContext): OperationContext {
  const source = Object.freeze({ ...context.source }) as EventActor;
  const authLens = Object.freeze({ ...context.authLens }) as AuthLens;
  return Object.freeze({
    source,
    authLens,
    ...(context.planId === undefined ? {} : { planId: context.planId }),
  });
}

/** Compatibility projection used by service adapters that still accept the
 * flat EventProvenance shape. */
export function provenanceForOperationContext(context: OperationContext): EventProvenance {
  const bound = immutableOperationContext(context);
  return {
    actor: bound.source,
    authLens: bound.authLens,
    operationContext: bound,
    ...(bound.planId === undefined ? {} : { planId: bound.planId }),
  };
}

function knownSource(provenance: EventProvenance | undefined): EventActor | undefined {
  const contextSource = provenance?.operationContext?.source;
  if (contextSource && contextSource.kind !== 'unattributed') return contextSource;
  if (provenance?.actor && provenance.actor.kind !== 'unattributed') return provenance.actor;
  return undefined;
}

/** Resolve the canonical context from two semantically distinct inputs.
 * `issued` owns source/plan identity; `executed` owns the auth lens that really
 * reached the service. Unknown issue-time source falls back to the execution
 * handle, but a prebuilt handle can never overwrite a known issuer. */
export function resolveOperationContext(
  issued: EventProvenance | undefined,
  executed: EventProvenance | undefined,
): OperationContext {
  const issuedFallback = issued?.operationContext?.source ?? issued?.actor;
  const executedFallback = executed?.operationContext?.source ?? executed?.actor;
  return immutableOperationContext({
    source:
      knownSource(issued)
      ?? knownSource(executed)
      ?? issuedFallback
      ?? executedFallback
      ?? { kind: 'unattributed' },
    authLens:
      executed?.operationContext?.authLens
      ?? executed?.authLens
      ?? issued?.operationContext?.authLens
      ?? issued?.authLens
      ?? { mode: 'app-session' },
    ...((issued?.operationContext?.planId
      ?? issued?.planId
      ?? executed?.operationContext?.planId
      ?? executed?.planId) === undefined
      ? {}
      : {
          planId:
            issued?.operationContext?.planId
            ?? issued?.planId
            ?? executed?.operationContext?.planId
            ?? executed?.planId,
        }),
  });
}

/** The canonical context on a recorded event. Old/pre-context events are
 * explicitly unattributed rather than silently asserted to be app traffic. */
export function operationContextFor(
  event: Pick<EventProvenance, 'operationContext' | 'actor' | 'authLens' | 'planId'>,
): OperationContext {
  return resolveOperationContext(undefined, event);
}

function isPermissionDeniedError(event: OperationEvent): boolean {
  if (event.result === 'deny') {
    return true;
  }
  if (!('error' in event) || !event.error || typeof event.error !== 'object') {
    return false;
  }
  const code = (event.error as { code?: unknown }).code;
  if (typeof code !== 'string') {
    return false;
  }
  const normalized = code.toLowerCase();
  if (normalized === 'permission_denied' || normalized === 'permission-denied' || normalized === 'auth/permission-denied') {
    return true;
  }
  return false;
}

/** Normalize the legacy per-service markers exactly once, at the sandbox
 * stream seam. Consumers must not inspect `detail.admin`, `origin`, or the
 * presence of a trace themselves. */
export function rulesDispositionFor(event: OperationEvent): RulesDisposition {
  if ('rulesDisposition' in event && event.rulesDisposition) {
    return event.rulesDisposition;
  }
  if (event.kind === 'operation' && event.origin === 'admin') {
    return { kind: 'bypassed', reason: 'admin' };
  }
  if (event.detail?.admin === true) {
    return { kind: 'bypassed', reason: 'admin' };
  }
  if (
    event.kind === 'request' &&
    event.rulesEvidence === undefined &&
    event.evaluatedRule === undefined &&
    Array.isArray(event.reasons) &&
    event.reasons.some(
      (reason) =>
        typeof reason === 'string' &&
        (reason.startsWith('Write preparation error:') ||
          reason.startsWith('FieldValue resolve error:') ||
          reason.startsWith('Simulation error:')),
    )
  ) {
    return { kind: 'not-evaluated', reason: 'runtime-error' };
  }
  if (isPermissionDeniedError(event)) {
    return { kind: 'evaluated', verdict: 'deny' };
  }

  if (event.result === 'unsupported') {
    return { kind: 'not-evaluated', reason: 'unsupported' };
  }
  if (event.kind === 'operation' && event.result === 'error') {
    return { kind: 'not-evaluated', reason: 'runtime-error' };
  }
  if (event.kind === 'operation' && event.result === 'not-applicable') {
    return { kind: 'not-evaluated', reason: 'not-a-rules-operation' };
  }
  if (event.kind === 'listener') {
    if (event.rules) {
      return { kind: 'evaluated', verdict: 'deny' };
    }
    return { kind: 'not-evaluated', reason: 'runtime-error' };
  }
  if (event.kind === 'request') {
    return { kind: 'evaluated', verdict: 'allow' };
  }
  if ('rules' in event && event.rules) {
    return { kind: 'evaluated', verdict: 'allow' };
  }
  return { kind: 'not-evaluated', reason: 'no-rules' };
}

function immutableAuthState(auth: AuthState): AuthState {
  if (auth === null) return null;
  let tokenVal: Record<string, unknown> | undefined = undefined;
  if (auth.token !== undefined) {
    tokenVal = immutableRecord(auth.token);
  }
  return Object.freeze({
    uid: auth.uid,
    ...(tokenVal === undefined ? {} : { token: tokenVal }),
  });
}

function defineOwnField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function immutableRecord(value: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    defineOwnField(clone, key, immutableValue(entry));
  }
  return Object.freeze(clone);
}

function immutableValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableValue));
  if (value && typeof value === 'object') {
    return immutableRecord(value as Record<string, unknown>);
  }
  return value;
}

/** Auth changes have no rules seam; normalize their recorded outcome alongside data operations. */
export function trafficOperationEvent(event: SandboxEvent): OperationEvent | null {
  if (isOperationEvent(event)) return event;
  const isAuthChange = event.kind === 'service_mutation' && event.service === 'auth';
  if (!isAuthChange) return null;
  const safe = (value: unknown): unknown => {
    const preview = observationPayload(value);
    if (!preview || preview.truncated) return undefined;
    return immutableValue(JSON.parse(preview.text));
  };
  return {
    kind: 'operation', id: event.id, at: event.at, service: 'auth', method: event.op,
    path: event.path, auth: event.auth, origin: 'user', result: 'not-applicable',
    rulesDisposition: { kind: 'not-evaluated', reason: 'not-a-rules-operation' },
    operationContext: operationContextFor(event),
    detail: { transition: event.op, evidence: safe(event.detail) },
    resourceBefore: event.before === undefined ? undefined : { data: safe(event.before), exists: true },
    resourceAfter: event.after === undefined ? undefined : { data: safe(event.after), exists: true },
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return value;
}

function nonEmptyStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const entry of values) {
    if (nonEmptyString(entry) !== undefined) {
      out.push(entry as string);
    }
  }
  return out;
}

function selectEvidenceRule(
  event: RequestEvent,
): NonNullable<RequestEvent['rulesEvidence']>['rules'][number] | undefined {
  const rules = event.rulesEvidence?.rules;
  if (!rules || rules.length === 0) return undefined;
  const isDenying = (entry: NonNullable<RequestEvent['rulesEvidence']>['rules'][number]): boolean =>
    entry.verdict === 'DENY' || entry.verdict === 'ERROR';
  const evaluated = event.evaluatedRule;
  if (evaluated !== undefined) {
    const byLine = rules.find(
      (entry) => isDenying(entry) && evaluated.line !== undefined && entry.line === evaluated.line,
    );
    if (byLine !== undefined) return byLine;
    const byExpr = rules.find(
      (entry) =>
        isDenying(entry) && evaluated.expression !== undefined && entry.expression === evaluated.expression,
    );
    if (byExpr !== undefined) return byExpr;
  }
  const firstDenying = rules.find(isDenying);
  if (firstDenying !== undefined) return firstDenying;
  return rules[rules.length - 1];
}

function extractRequestDenialRule(event: RequestEvent): OperationDenialRule | undefined {
  const rule: { -readonly [K in keyof OperationDenialRule]: OperationDenialRule[K] } = {};
  const evaluated = event.evaluatedRule;
  if (evaluated !== undefined) {
    const citation = nonEmptyString(evaluated.citation);
    if (citation !== undefined) rule.citation = citation;
    if (typeof evaluated.line === 'number') rule.line = evaluated.line;
    if (typeof evaluated.column === 'number') rule.column = evaluated.column;
    else if (typeof evaluated.col === 'number') rule.column = evaluated.col;
    const expression = nonEmptyString(evaluated.expression);
    if (expression !== undefined) rule.expression = expression;
  }
  const evidenceRule = selectEvidenceRule(event);
  if (evidenceRule !== undefined) {
    const path = nonEmptyString(evidenceRule.path);
    if (rule.path === undefined && path !== undefined) rule.path = path;
    if (rule.line === undefined && typeof evidenceRule.line === 'number') rule.line = evidenceRule.line;
    const expression = nonEmptyString(evidenceRule.expression);
    if (rule.expression === undefined && expression !== undefined) rule.expression = expression;
  }
  if (Object.keys(rule).length === 0) {
    const firstQueryFailure = event.rulesEvidence?.queryProof?.failures?.[0];
    if (firstQueryFailure !== undefined) {
      const expression = nonEmptyString(firstQueryFailure.expression);
      if (expression !== undefined) rule.expression = expression;
      if (typeof firstQueryFailure.line === 'number') rule.line = firstQueryFailure.line;
    }
  }
  if (Object.keys(rule).length === 0) return undefined;
  return Object.freeze(rule);
}

function extractDenialRule(event: SandboxEvent): OperationDenialRule | undefined {
  if (event.kind === 'request') {
    return extractRequestDenialRule(event);
  }
  if (event.kind === 'operation' || event.kind === 'listener') {
    const rules = event.rules;
    if (!rules) return undefined;
    const rule: { path?: string; expression?: string } = {};
    const matchedPath = nonEmptyString(rules.matchedPath);
    if (matchedPath !== undefined) rule.path = matchedPath;
    const matchedRule = nonEmptyString(rules.matchedRule);
    if (matchedRule !== undefined) rule.expression = matchedRule;
    if (Object.keys(rule).length === 0) return undefined;
    return Object.freeze(rule);
  }
  return undefined;
}

function extractDenialReasons(event: SandboxEvent): string[] {
  if ('reasons' in event) {
    const direct = nonEmptyStrings(event.reasons);
    if (direct.length > 0) return direct;
  }
  if ('error' in event && event.error !== undefined && typeof event.error === 'object') {
    const errorObj = event.error as { reasons?: unknown; message?: unknown };
    const fromErrorReasons = nonEmptyStrings(errorObj.reasons);
    if (fromErrorReasons.length > 0) return fromErrorReasons;
  }
  if ('rules' in event && event.rules !== undefined) {
    const ruleReason = nonEmptyString(event.rules.reason);
    if (ruleReason !== undefined) return [ruleReason];
  }
  if ('error' in event && event.error !== undefined && typeof event.error === 'object') {
    const message = nonEmptyString((event.error as { message?: unknown }).message);
    if (message !== undefined) return [message];
  }
  return [];
}

function denialFor(
  event: SandboxEvent,
  rules: RulesDisposition,
  result: OperationRecord['result'],
): OperationDenial | undefined {
  const isEvaluatedDeny = rules.kind === 'evaluated' && rules.verdict === 'deny';
  const isNoRulesDeny = result === 'deny' && rules.kind === 'not-evaluated' && rules.reason === 'no-rules';
  if (!isEvaluatedDeny && !isNoRulesDeny) return undefined;

  const evidenceExpired = event.kind === 'request' && event.rulesEvidenceExpired === true;
  let reasons = extractDenialReasons(event);
  if (reasons.length === 0) {
    if (evidenceExpired) {
      reasons = ['Firestore rules evidence expired.'];
    } else if (isNoRulesDeny) {
      reasons = ['No security rules configured; default deny.'];
    } else {
      reasons = ['Denied by security rules.'];
    }
  }
  const rule = extractDenialRule(event);
  const denial: {
    reasons: readonly string[];
    rule?: OperationDenialRule;
    evidenceExpired?: true;
  } = {
    reasons: Object.freeze([...reasons]),
  };
  if (rule !== undefined) denial.rule = rule;
  if (evidenceExpired) denial.evidenceExpired = true;
  return Object.freeze(denial);
}

/** Project either traffic event family into the canonical record. */
export function toOperationRecord(input: SandboxEvent): OperationRecord | null {
  const event = trafficOperationEvent(input);
  if (!event) return null;
  let methodVal = 'listen';
  let pathVal: string | undefined = undefined;
  if (event.kind === 'request' || event.kind === 'operation') {
    methodVal = event.method;
    if (event.path !== undefined) {
      pathVal = event.path;
    }
  } else if (event.kind === 'listener') {
    methodVal = 'listen';
    if (event.target.path !== undefined) {
      pathVal = event.target.path;
    }
  }
  let serviceVal: EventService = 'firestore';
  if (event.service !== undefined) {
    serviceVal = event.service;
  }
  let queryProof: RequestEvent['queryProof'];
  if ('queryProof' in event && event.queryProof) {
    queryProof = immutableValue(event.queryProof) as RequestEvent['queryProof'];
  }
  const rules = Object.freeze({ ...rulesDispositionFor(event) });
  const denial = denialFor(event, rules, event.result);
  let idVal = event.id;
  let atVal = event.at;
  if (event.kind === 'operation' && event.observation !== undefined) {
    idVal = event.observation.id;
    atVal = event.observation.startedAt;
  }
  const record: {
    -readonly [Key in keyof OperationRecord]: OperationRecord[Key];
  } = {
    id: idVal,
    at: atVal,
    eventKind: event.kind,
    service: serviceVal,
    method: methodVal,
    auth: immutableAuthState(event.auth),
    result: event.result,
    context: operationContextFor(event),
    rules,
    queryProof,
  };
  if (event.kind === 'operation' && event.observation !== undefined) {
    record.observation = event.observation;
  }
  if (pathVal !== undefined) record.path = pathVal;
  if (denial !== undefined) record.denial = denial;
  const production = productionOf(event);
  if (production !== undefined) record.production = production;
  return Object.freeze(record);
}

/** A frozen copy of production's answer, when the event carries one. */
function productionOf(event: OperationEvent): ObservedProduction | undefined {
  const production = event.kind === 'operation' ? event.production : undefined;
  if (production === undefined) return undefined;
  return immutableRecord(production as unknown as Record<string, unknown>) as unknown as ObservedProduction;
}

/** The five phases a listener passes through, whatever variant carried it. */
export type ListenerPhase = 'attach' | 'detach' | 'delivery' | 'suppressed' | 'errored';

/** Which phase an event reports, or `null` when it is not listener lifecycle. */
function listenerPhaseOf(event: SandboxEvent): ListenerPhase | null {
  if (event.kind === 'listener') return event.phase;
  if (event.kind === 'listener_attach') return 'attach';
  if (event.kind === 'listener_detach') return 'detach';
  if (event.kind === 'listener_errored') return 'errored';
  if (event.kind === 'snapshot_delivery') return 'delivery';
  if (event.kind === 'snapshot_suppressed') return 'suppressed';
  return null;
}

/** Only an errored listener met Security Rules; the other phases never did. */
function listenerRulesDisposition(event: SandboxEvent, phase: ListenerPhase): RulesDisposition {
  if (phase !== 'errored') return { kind: 'not-evaluated', reason: 'not-a-rules-operation' };
  return rulesDispositionFor(event as OperationEvent);
}

/** The listener-shaped fields every lifecycle variant carries. */
interface ListenerShape {
  target: { kind: string; path?: string; collection?: string };
  auth: AuthState;
}

/**
 * Project one listener lifecycle event into the canonical record, with the
 * phase as the record's `method`.
 *
 * Firestore reports lifecycle through its own `listener_attach` /
 * `listener_detach` / `listener_errored` / `snapshot_delivery` /
 * `snapshot_suppressed` variants; every other service reports it through the
 * canonical `listener` variant. Both arrive here as the same five phases, so a
 * caller paging listener activity never has to know which service produced it.
 *
 * Returns `null` for anything that is not listener lifecycle.
 */
export function toListenerRecord(event: SandboxEvent): OperationRecord | null {
  const phase = listenerPhaseOf(event);
  if (phase === null) return null;
  const listener = event as unknown as ListenerShape;

  let serviceVal: EventService = 'firestore';
  if (event.service !== undefined) {
    serviceVal = event.service;
  }

  let resultVal: OperationRecord['result'] = undefined;
  if (event.kind === 'listener' && event.result !== undefined) {
    resultVal = event.result;
  } else if (phase === 'errored') {
    resultVal = 'deny';
  }

  const rules = Object.freeze(listenerRulesDisposition(event, phase));
  const denial = denialFor(event, rules, resultVal);

  const record: {
    -readonly [Key in keyof OperationRecord]: OperationRecord[Key];
  } = {
    id: event.id,
    at: event.at,
    eventKind: 'listener',
    service: serviceVal,
    method: phase,
    auth: immutableAuthState(listener.auth),
    result: resultVal,
    context: operationContextFor(event),
    rules,
  };
  let targetPath: string | undefined = undefined;
  if (typeof listener.target.path === 'string') {
    targetPath = listener.target.path;
  } else if (typeof listener.target.collection === 'string') {
    targetPath = listener.target.collection;
  }
  if (targetPath !== undefined) record.path = targetPath;
  if (denial !== undefined) record.denial = denial;
  return Object.freeze(record);
}
