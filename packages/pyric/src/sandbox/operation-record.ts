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

export interface OperationRecord {
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
    if (event.result === 'deny') {
      return { kind: 'evaluated', verdict: 'deny' };
    }
    if (event.error?.code === 'PERMISSION_DENIED') {
      return { kind: 'evaluated', verdict: 'deny' };
    }
    if (event.rules) {
      return { kind: 'evaluated', verdict: 'deny' };
    }
    return { kind: 'not-evaluated', reason: 'runtime-error' };
  }
  if (event.result === 'deny') {
    return { kind: 'evaluated', verdict: 'deny' };
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

function immutableRecord(value: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    clone[key] = immutableValue(entry);
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

/** Project either traffic event family into the canonical record. */
export function toOperationRecord(event: SandboxEvent): OperationRecord | null {
  if (!isOperationEvent(event)) return null;
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
  return Object.freeze({
    id: event.id,
    at: event.at,
    eventKind: event.kind,
    service: serviceVal,
    method: methodVal,
    ...(pathVal === undefined ? {} : { path: pathVal }),
    auth: immutableAuthState(event.auth),
    result: event.result,
    context: operationContextFor(event),
    rules: Object.freeze({ ...rulesDispositionFor(event) }),
  });
}
