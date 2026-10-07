import type { AuthState, RtdbDenialContext, Sandbox, SandboxOperationEvent } from 'pyric/sandbox';
import type { ListenerOwner } from '../../sandbox/types/events.js';
import { emitSandboxEvent, getClock, makeSandboxCommitEvent, makeSandboxListenerEvent, makeSandboxOperationEvent, makeServiceMutationEvent } from 'pyric/sandbox/internal';
import { joinPath, pathSegments } from './data-tree.js';
import type { ChildListener, ValueListener } from './listener-types.js';
import type { RuleCheck, RuleEvaluationDetails } from './rules-eval.js';

export function denyResultFor(check: RuleCheck): 'deny' | 'unsupported' {
  if (check === 'unsupported') {
    return 'unsupported';
  }
  return 'deny';
}

/**
 * The `rules` block an RTDB operation or listener event carries: the deciding
 * rule, the bindings, the reason, and the rule-by-rule trace.
 */
export function rtdbRulesDetail(evaluation: RuleEvaluationDetails): NonNullable<SandboxOperationEvent['rules']> {
  const rules: NonNullable<SandboxOperationEvent['rules']> = {
    engine: 'rtdb',
    matchedPath: evaluation.matchedPath,
    matchedRule: evaluation.matchedRule,
    pathVariableBindings: evaluation.pathVariableBindings,
    reason: evaluation.reason,
    errorCode: evaluation.errorCode,
  };
  if (evaluation.trace !== undefined) rules.rtdbTrace = evaluation.trace;
  return rules;
}

/**
 * The `denialContext` a denied RTDB operation's error carries: the same rule
 * details as the operation event's `rules` block, plus the auth the rules saw
 * and the request. `data` is the proposed value the write rules evaluated as
 * `newData`; it is omitted for reads. Keys whose value is undefined are left
 * out, so the context is the same before and after a JSON round trip.
 */
export function rtdbDenialContext(
  evaluation: RuleEvaluationDetails,
  auth: AuthState,
  method: RtdbDenialContext['request']['method'],
  path: string,
  data?: unknown,
): RtdbDenialContext {
  const request: RtdbDenialContext['request'] = { method, path: canonicalPath(path) };
  if (data !== undefined) request.data = structuredClone(data);
  const rules = Object.fromEntries(
    Object.entries(rtdbRulesDetail(evaluation)).filter(([, value]) => value !== undefined),
  ) as Omit<RtdbDenialContext, 'auth' | 'reasons' | 'request'>;
  return {
    ...rules,
    engine: 'rtdb',
    auth: auth === null ? null : structuredClone(auth),
    reasons: [...evaluation.reasons],
    request,
  };
}

export function canonicalPath(path: string): string {
  return joinPath(pathSegments(path));
}

export class OperationEvents {
  private nextId = 0;

  constructor(private readonly sandbox?: Sandbox) {}

  nextListenerId(): string {
    this.nextId += 1;
    return `rtdb-listener-${this.nextId.toString(36)}`;
  }

  nextGroupId(prefix: string): string {
    this.nextId += 1;
    return `rtdb-${prefix}-${this.nextId.toString(36)}`;
  }

  mutation(
    auth: AuthState,
    op: 'set' | 'update' | 'remove' | 'transaction' | 'setPriority',
    path: string,
    fields: { before?: unknown; after?: unknown; detail?: Record<string, unknown> } = {},
  ): void {
    if (!this.sandbox) return;
    try {
      emitSandboxEvent(this.sandbox, makeServiceMutationEvent({
        at: getClock(this.sandbox).now(),
        service: 'rtdb', op, path, auth,
        before: fields.before, after: fields.after, detail: fields.detail,
      }), { service: 'rtdb' });
    } catch { /* telemetry is observational */ }
  }

  operation(
    auth: AuthState,
    method: string,
    path: string,
    result: 'allow' | 'deny' | 'unsupported' | 'error' | 'not-applicable',
    evaluation: RuleEvaluationDetails | undefined,
    fields: {
      at?: number;
      durationMs?: number;
      origin?: 'user' | 'listener' | 'transaction' | 'batch' | 'admin' | 'system';
      request?: { data?: unknown; resourceData?: unknown; query?: unknown };
      resourceBefore?: { data: unknown; exists: boolean };
      resourceAfter?: { data: unknown; exists: boolean };
      groupId?: string;
      groupKind?: 'batch' | 'transaction';
      triggeredBy?: { method: string; path?: string };
      detail?: Record<string, unknown>;
    } = {},
  ): void {
    if (!this.sandbox) return;
    try {
      let rulesObj: SandboxOperationEvent['rules'] | undefined = undefined;
      if (evaluation) {
        rulesObj = rtdbRulesDetail(evaluation);
      }
      let originVal: 'user' | 'listener' | 'transaction' | 'batch' | 'admin' | 'system' = 'user';
      if (fields.origin) {
        originVal = fields.origin;
      }
      // A caller that already resolved the operation's instant passes it, so the
      // event and the write it describes agree exactly. A caller that did not
      // reads the same clock here rather than falling back to the wall clock.
      let at = fields.at;
      if (at === undefined) {
        at = getClock(this.sandbox).now();
      }
      emitSandboxEvent(this.sandbox, makeSandboxOperationEvent({
        service: 'rtdb', method, path: canonicalPath(path), auth, result,
        origin: originVal, durationMs: fields.durationMs,
        reasons: evaluation?.reasons,
        rules: rulesObj,
        request: fields.request, resourceBefore: fields.resourceBefore,
        resourceAfter: fields.resourceAfter, groupId: fields.groupId,
        groupKind: fields.groupKind, triggeredBy: fields.triggeredBy,
        detail: fields.detail, at,
      }), { service: 'rtdb' });
    } catch { /* telemetry is observational */ }
  }

  commit(
    auth: AuthState,
    method: string,
    path: string,
    fields: {
      data?: unknown;
      priorState?: unknown;
      nextState?: unknown;
      groupId?: string;
      groupKind?: 'batch' | 'transaction';
      replay?: { requestTime?: number; autoId?: string; sentinels?: Array<{ field: string; kind: string }> };
      detail?: Record<string, unknown>;
    } = {},
  ): void {
    if (!this.sandbox) return;
    try {
      emitSandboxEvent(this.sandbox, makeSandboxCommitEvent({
        at: getClock(this.sandbox).now(),
        service: 'rtdb', method, path: canonicalPath(path), auth,
        data: fields.data, priorState: fields.priorState, nextState: fields.nextState,
        groupId: fields.groupId, groupKind: fields.groupKind,
        replay: fields.replay, detail: fields.detail,
      }), { service: 'rtdb' });
    } catch { /* telemetry is observational */ }
  }

  listener(
    phase: 'attach' | 'detach' | 'delivery' | 'suppressed' | 'errored',
    listener: Pick<ValueListener | ChildListener, 'id' | 'path'>,
    auth: AuthState,
    fields: {
      event?: ChildListener['event'] | 'value';
      /** The query the ref carried, for a listener attached to a query.
       *  Diagnostic only: no verdict or delivery reads it. */
      query?: unknown;
      result?: 'allow' | 'deny' | 'unsupported' | 'error';
      size?: number;
      sample?: unknown;
      reason?: string;
      error?: { code?: string; message: string; reasons?: string[] };
      triggeredBy?: { method: string; path?: string };
      detail?: Record<string, unknown>;
      reasons?: string[];
      rules?: SandboxOperationEvent['rules'];
      owners?: ListenerOwner[];
    } = {},
  ): void {
    if (!this.sandbox) return;
    try {
      let kindVal: string = 'value';
      if (fields.event) {
        kindVal = fields.event;
      }
      emitSandboxEvent(this.sandbox, makeSandboxListenerEvent({
        at: getClock(this.sandbox).now(),
        service: 'rtdb', phase, listenerId: listener.id,
        target: {
          kind: kindVal,
          path: canonicalPath(listener.path),
          ...(fields.query === undefined ? {} : { query: fields.query }),
        },
        auth, result: fields.result, size: fields.size, sample: fields.sample,
        reason: fields.reason, error: fields.error, triggeredBy: fields.triggeredBy,
        detail: fields.detail, reasons: fields.reasons, rules: fields.rules,
        owners: fields.owners,
      }), { service: 'rtdb' });
    } catch { /* telemetry is observational */ }
  }
}
