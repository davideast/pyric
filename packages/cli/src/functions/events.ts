/**
 * The Functions trigger runtime's emit sites on the sandbox event stream.
 *
 * A run is three things worth seeing: which trigger the runtime resolved out
 * of the project's source, the synthetic event a handler was then fired on,
 * and how that run finished. Each lands as one cross-service mutation event so
 * a caller reads Functions activity beside every other service's, and so
 * `functions.executions` has a history to fold rather than a private log to
 * keep.
 *
 * The runtime reaches a sandbox only where the in-process server holds one:
 * the bridge surface context. Emission is best effort, the storage precedent:
 * a throw from the emit path must never fail the run that caused it.
 */
import { getClock, type LocalSandbox, type ServiceEventOperation } from 'pyric/sandbox';
import { emitSandboxEvent, makeServiceMutationEvent } from 'pyric/sandbox/internal';

/** Every operation the Functions record declares. */
type FunctionsEventOperation = ServiceEventOperation<'functions'>;

/** What one finished run reports. */
export interface FunctionExecutionOutcome {
  trigger: string;
  ref: string;
  params: Record<string, string>;
  startedAt: number;
  durationMs: number;
  status: 'fulfilled' | 'rejected' | 'timeout';
  result?: unknown;
  error?: string;
}

function emit(
  sandbox: LocalSandbox,
  op: FunctionsEventOperation,
  path: string,
  detail: Record<string, unknown>,
): void {
  try {
    const event = makeServiceMutationEvent({
      at: getClock(sandbox).now(),
      service: 'functions',
      op,
      path,
      auth: null,
      detail,
    });
    emitSandboxEvent(sandbox, event, { service: 'functions' });
  } catch {
    // Observational: never let event emission break a trigger run.
  }
}

/** The runtime resolved one trigger out of the project's Functions source. */
export function emitTriggerDiscovered(
  sandbox: LocalSandbox,
  trigger: { exportName: string; reference: string; instance: string },
): void {
  emit(sandbox, 'trigger_discovered', trigger.reference, {
    trigger: trigger.exportName,
    instance: trigger.instance,
  });
}

/** A handler was fired on a synthetic event at `ref`. */
export function emitHandlerFired(
  sandbox: LocalSandbox,
  fired: { trigger: string; ref: string; params: Record<string, string> },
): void {
  emit(sandbox, 'handler_fired', fired.ref, {
    trigger: fired.trigger,
    params: fired.params,
  });
}

/** A run finished, with how long it took and what it produced. */
export function emitExecutionFinished(
  sandbox: LocalSandbox,
  outcome: FunctionExecutionOutcome,
): void {
  const detail: Record<string, unknown> = {
    trigger: outcome.trigger,
    params: outcome.params,
    startedAt: outcome.startedAt,
    durationMs: outcome.durationMs,
    status: outcome.status,
  };
  if (outcome.status === 'fulfilled') detail.result = outcome.result;
  if (outcome.status === 'rejected') detail.error = outcome.error;
  emit(sandbox, 'execution_finished', outcome.ref, detail);
}
