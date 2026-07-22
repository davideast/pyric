import type { AuthState, Sandbox } from 'pyric/sandbox';
import {
  emitSandboxEvent,
  makeSandboxCommitEvent,
  makeSandboxListenerEvent,
  makeSandboxOperationEvent,
  makeServiceMutationEvent,
} from 'pyric/sandbox/internal';
import { joinPath, pathSegments } from './data-tree.js';
import type { ChildListener, ValueListener } from './listener-types.js';
import type { RuleCheck, RuleEvaluationDetails } from './rules-eval.js';

export function denyResultFor(check: RuleCheck): 'deny' | 'unsupported' {
  return check === 'unsupported' ? 'unsupported' : 'deny';
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
    op: 'set' | 'update' | 'remove' | 'transaction',
    path: string,
    fields: { before?: unknown; after?: unknown; detail?: Record<string, unknown> } = {},
  ): void {
    if (!this.sandbox) return;
    try {
      emitSandboxEvent(this.sandbox, makeServiceMutationEvent({
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
      emitSandboxEvent(this.sandbox, makeSandboxOperationEvent({
        service: 'rtdb', method, path: canonicalPath(path), auth, result,
        origin: fields.origin ?? 'user', durationMs: fields.durationMs,
        reasons: evaluation?.reasons,
        rules: evaluation ? {
          engine: 'rtdb', matchedPath: evaluation.matchedPath,
          matchedRule: evaluation.matchedRule,
          pathVariableBindings: evaluation.pathVariableBindings,
          reason: evaluation.reason, errorCode: evaluation.errorCode,
        } : undefined,
        request: fields.request, resourceBefore: fields.resourceBefore,
        resourceAfter: fields.resourceAfter, groupId: fields.groupId,
        groupKind: fields.groupKind, triggeredBy: fields.triggeredBy,
        detail: fields.detail, at: fields.at,
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
      result?: 'allow' | 'deny' | 'unsupported' | 'error';
      size?: number;
      sample?: unknown;
      reason?: string;
      error?: { code?: string; message: string; reasons?: string[] };
      triggeredBy?: { method: string; path?: string };
      detail?: Record<string, unknown>;
    } = {},
  ): void {
    if (!this.sandbox) return;
    try {
      emitSandboxEvent(this.sandbox, makeSandboxListenerEvent({
        service: 'rtdb', phase, listenerId: listener.id,
        target: { kind: fields.event ?? 'value', path: canonicalPath(listener.path) },
        auth, result: fields.result, size: fields.size, sample: fields.sample,
        reason: fields.reason, error: fields.error, triggeredBy: fields.triggeredBy,
        detail: fields.detail,
      }), { service: 'rtdb' });
    } catch { /* telemetry is observational */ }
  }
}
