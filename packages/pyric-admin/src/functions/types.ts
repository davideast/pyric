/**
 * Public `firebase-admin/functions` task-queue types and internal sandbox
 * dispatch bridge contracts for `pyric-admin/functions`.
 */

/** Task options with relative delayed delivery. */
export interface DelayDelivery {
  scheduleDelaySeconds?: number;
  scheduleTime?: never;
}

/** Task options with absolute `Date` delivery. */
export interface AbsoluteDelivery {
  scheduleTime?: Date;
  scheduleDelaySeconds?: never;
}

/** Union of relative and absolute task delivery schedules. */
export type DeliverySchedule = DelayDelivery | AbsoluteDelivery;

/** Experimental `firebase-admin/functions` task options. */
export interface TaskOptionsExperimental {
  uri?: string;
}

/** Options accepted by `TaskQueue.enqueue(data, opts?)`. */
export type TaskOptions = DeliverySchedule &
  TaskOptionsExperimental & {
    dispatchDeadlineSeconds?: number;
    id?: string;
    headers?: Record<string, string>;
  };

/** Normalized task request handed from `pyric-admin/functions` to a queue backend. */
export interface NormalizedAdminTaskEnqueue {
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

export interface NormalizedAdminTaskDelete {
  queueName: string;
  projectId?: string;
  locationId?: string;
  extensionId?: string;
  id: string;
}

/** Pluggable dispatcher installed by `functions/tasks` execution or child runtime. */
export interface AdminTaskQueueDispatcher {
  enqueue(request: NormalizedAdminTaskEnqueue): Promise<void>;
  delete(request: NormalizedAdminTaskDelete): Promise<void>;
}

/**
 * Symbol key on `globalThis` holding a `WeakMap<object, AdminTaskQueueDispatcher>`
 * keyed by `LocalSandbox` (or directly set on a mock sandbox object).
 */
export const SANDBOX_TASK_QUEUE_DISPATCHER = Symbol.for(
  'pyric.functions.sandboxTaskQueueDispatcher',
);

/** Symbol key on `globalThis` pointing to a process-wide child/dev `AdminTaskQueueDispatcher`. */
export const PROCESS_TASK_QUEUE_DISPATCHER = Symbol.for(
  'pyric.functions.processTaskQueueDispatcher',
);

/**
 * Symbol key on `globalThis` holding a `WeakMap<object, LocalAdminTaskStore>`
 * for standalone in-memory `LocalSandbox` task queue state without mutating `sandbox`.
 */
export const LOCAL_TASK_QUEUE_STORE = Symbol.for('pyric.functions.localTaskQueueStore');
