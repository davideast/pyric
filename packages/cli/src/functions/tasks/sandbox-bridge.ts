/**
 * `WeakMap` bridge registration connecting `pyric-admin/functions`
 * `getFunctions(app).taskQueue(name)` on a `LocalSandbox` to an active
 * `functions/tasks` execution host or `FunctionsDevelopmentRuntime`.
 */
import type { DiscoveredTaskTrigger, TasksRetryConfig } from './discovery.js';

const SANDBOX_TASK_QUEUE_DISPATCHER = Symbol.for('pyric.functions.sandboxTaskQueueDispatcher');
const MAX_LOCAL_UNLIMITED_ATTEMPTS = 5;

export interface AdminBridgeEnqueueInput {
  queueName: string;
  projectId?: string;
  locationId?: string;
  extensionId?: string;
  data: unknown;
  id?: string;
  scheduleDelaySeconds?: number;
  scheduleTimeIso?: string;
  dispatchDeadlineSeconds?: number;
  headers?: Record<string, string>;
  uri?: string;
}

export interface AdminBridgeDeleteInput {
  queueName: string;
  projectId?: string;
  locationId?: string;
  extensionId?: string;
  id: string;
}

export interface AdminBridgeDispatcher {
  enqueue(request: AdminBridgeEnqueueInput): Promise<void>;
  delete(request: AdminBridgeDeleteInput): Promise<void>;
}

export function createCodedTaskError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

export function tasksRetryConfigToRecord(retryConfig: TasksRetryConfig): Record<string, number> {
  const record: Record<string, number> = {};
  if (retryConfig.maxAttempts !== undefined) {
    record.maxAttempts = retryConfig.maxAttempts;
  }
  if (retryConfig.maxRetrySeconds !== undefined) {
    record.maxRetrySeconds = retryConfig.maxRetrySeconds;
  }
  if (retryConfig.minBackoffSeconds !== undefined) {
    record.minBackoffSeconds = retryConfig.minBackoffSeconds;
  }
  if (retryConfig.maxBackoffSeconds !== undefined) {
    record.maxBackoffSeconds = retryConfig.maxBackoffSeconds;
  }
  if (retryConfig.maxDoublings !== undefined) {
    record.maxDoublings = retryConfig.maxDoublings;
  }
  return record;
}

export function computeMaxTotalTaskAttempts(trigger: DiscoveredTaskTrigger): number {
  const configured = trigger.retryConfig.maxAttempts;
  if (configured !== undefined) {
    if (configured < 0) return MAX_LOCAL_UNLIMITED_ATTEMPTS;
    if (configured === 0) return 1;
    return Math.max(1, configured);
  }
  if (trigger.retry === true) {
    return 3;
  }
  return 1;
}

function getSandboxDispatcherRegistry(): WeakMap<object, AdminBridgeDispatcher> {
  const globalRecord = globalThis as Record<symbol, unknown>;
  const existing = globalRecord[SANDBOX_TASK_QUEUE_DISPATCHER];
  if (existing instanceof WeakMap) {
    return existing as WeakMap<object, AdminBridgeDispatcher>;
  }
  const created = new WeakMap<object, AdminBridgeDispatcher>();
  globalRecord[SANDBOX_TASK_QUEUE_DISPATCHER] = created;
  return created;
}

/**
 * Attach `dispatcher` for `sandbox` in the global `WeakMap` without mutating
 * `sandbox`, returning an idempotent cleanup callback for `close()`.
 */
export function attachSandboxTaskQueueDispatcher(
  sandbox: object,
  dispatcher: AdminBridgeDispatcher,
): () => void {
  const registry = getSandboxDispatcherRegistry();
  registry.set(sandbox, dispatcher);
  return () => {
    if (registry.get(sandbox) === dispatcher) {
      registry.delete(sandbox);
    }
  };
}
