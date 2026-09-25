import type { Sandbox } from 'pyric/sandbox';
import { SandboxClock } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { DataTree, joinPath, pathSegments } from './data-tree.js';
import type { ChildListener, ValueListener } from './listener-types.js';
import { MutationHistory } from './mutation-history.js';
import { denyResultFor, OperationEvents } from './operation-events.js';
import { PriorityState } from './priority-state.js';
import { RulesEvaluator } from './rules-eval.js';

function deniedListenerError(path: string): Error {
  const error = new Error(
    `permission_denied at ${joinPath(pathSegments(path))}: Client doesn't have permission to access the desired data.`,
  ) as Error & { code: string };
  error.code = 'PERMISSION_DENIED';
  return error;
}

export class BackendState {
  readonly tree = new DataTree();
  readonly rules: RulesEvaluator;
  activeRules: { rules: Record<string, unknown> } | null = null;
  readonly valueListeners = new Set<ValueListener>();
  readonly childListeners = new Set<ChildListener>();
  readonly priorities = new PriorityState();
  readonly mutations = new MutationHistory();
  readonly events: OperationEvents;
  readonly writeSubscribers = new Set<() => void>();
  resetGeneration = 0;
  /**
   * The sandbox's clock. Every server-set time this backend produces reads it:
   * `ServerValue.TIMESTAMP`, the rules engine's `now`, push-id keys, and the
   * operation-event stamps. A backend with no sandbox keeps its own wall clock.
   */
  readonly clock: SandboxClock;

  constructor(sandbox?: Sandbox) {
    this.events = new OperationEvents(sandbox);
    this.clock = sandbox ? getClock(sandbox) : new SandboxClock();
    this.rules = new RulesEvaluator(this.clock, (path, spec, ctx) => {
      this.events.operation(ctx.auth, ctx.indexMethod ?? 'get', path, 'error', undefined, {
        request: { query: spec }, detail: { failure: 'missing-index' },
      });
    });
  }

  cancelDeniedListeners(): void {
    const mockData = this.tree.snapshot() as Record<string, unknown>;
    const denied: Array<ValueListener | ChildListener> = [];
    for (const listener of [...this.valueListeners]) {
      if (listener.admin) continue;
      const evaluation = this.rules.evaluate('read', listener.path, {
        auth: listener.auth,
        mockData,
        querySpec: listener.query,
      });
      if (evaluation.check === 'allow') continue;
      this.valueListeners.delete(listener);
      this.events.operation(listener.auth, 'listen', listener.path, denyResultFor(evaluation.check), evaluation, {
        origin: 'listener',
      });
      this.events.listener('errored', listener, listener.auth, {
        event: 'value',
        result: 'deny',
        error: { code: 'PERMISSION_DENIED', message: 'PERMISSION_DENIED: Permission denied', reasons: evaluation.reasons },
        reasons: evaluation.reasons,
        rules: {
          engine: 'rtdb' as const,
          matchedPath: evaluation.matchedPath,
          matchedRule: evaluation.matchedRule,
          pathVariableBindings: evaluation.pathVariableBindings,
          reason: evaluation.reason,
          errorCode: evaluation.errorCode,
        },
      });
      denied.push(listener);
    }
    for (const listener of [...this.childListeners]) {
      const evaluation = this.rules.evaluate('read', listener.path, {
        auth: listener.auth,
        mockData,
        querySpec: listener.spec,
      });
      if (evaluation.check === 'allow') continue;
      this.childListeners.delete(listener);
      this.events.operation(listener.auth, 'listen', listener.path, denyResultFor(evaluation.check), evaluation, {
        origin: 'listener',
        detail: { event: listener.event },
      });
      this.events.listener('errored', listener, listener.auth, {
        event: listener.event,
        result: 'deny',
        error: { code: 'PERMISSION_DENIED', message: 'PERMISSION_DENIED: Permission denied', reasons: evaluation.reasons },
        reasons: evaluation.reasons,
        rules: {
          engine: 'rtdb' as const,
          matchedPath: evaluation.matchedPath,
          matchedRule: evaluation.matchedRule,
          pathVariableBindings: evaluation.pathVariableBindings,
          reason: evaluation.reason,
          errorCode: evaluation.errorCode,
        },
      });
      denied.push(listener);
    }
    for (const listener of denied) {
      try {
        if (listener.onCanceled) {
          listener.onCanceled();
        }
      } catch { /* isolated teardown */ }
      try {
        if (listener.cancelCallback) {
          listener.cancelCallback(deniedListenerError(listener.path));
        }
      } catch { /* isolated callback */ }
    }
  }

  notifyWrite(): void {
    for (const subscriber of this.writeSubscribers) {
      try { subscriber(); } catch { /* persistence scheduling is observational */ }
    }
  }
}
