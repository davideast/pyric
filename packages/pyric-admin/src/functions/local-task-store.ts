/**
 * Standalone in-memory TaskQueue store and sandbox/process dispatcher routing
 * for `pyric-admin/functions`.
 */
import { randomUUID } from 'node:crypto';
import { getClock, isRemoteSandbox, type LocalSandbox, type Sandbox } from 'pyric/sandbox';
import { explicitProjectId } from '../app/project-id.js';
import type { PyricAdminApp } from '../app/index.js';
import { FirebaseFunctionsError } from './error.js';
import {
  LOCAL_TASK_QUEUE_STORE,
  PROCESS_TASK_QUEUE_DISPATCHER,
  SANDBOX_TASK_QUEUE_DISPATCHER,
  type AdminTaskQueueDispatcher,
  type NormalizedAdminTaskDelete,
  type NormalizedAdminTaskEnqueue,
} from './types.js';

export interface StoredLocalTask {
  id: string;
  queueName: string;
  locationId: string;
  projectId: string;
  data: unknown;
  scheduledTime: string;
  dispatchDeadlineSeconds: number;
  headers: Record<string, string>;
  uri?: string;
}

interface QueueBucket {
  seenIds: Set<string>;
  pendingById: Map<string, StoredLocalTask>;
}

interface GlobalTaskQueueRegistry {
  [SANDBOX_TASK_QUEUE_DISPATCHER]?: WeakMap<object, AdminTaskQueueDispatcher>;
  [PROCESS_TASK_QUEUE_DISPATCHER]?: AdminTaskQueueDispatcher;
  [LOCAL_TASK_QUEUE_STORE]?: WeakMap<object, LocalAdminTaskStore>;
}

function serializeTaskDataWire(rawData: unknown): unknown {
  const normalizedInput = rawData === undefined ? null : rawData;
  try {
    const serialized = JSON.stringify({ data: normalizedInput });
    const parsed = JSON.parse(serialized) as { data?: unknown };
    return parsed.data === undefined ? null : parsed.data;
  } catch (err: unknown) {
    if (err instanceof TypeError) {
      throw new FirebaseFunctionsError(
        'invalid-argument',
        `Task payload must be JSON-serializable: ${err.message}`,
      );
    }
    throw err;
  }
}

class LocalAdminTaskStore implements AdminTaskQueueDispatcher {
  readonly #queues = new Map<string, QueueBucket>();
  readonly #now: () => number;
  readonly #defaultProjectId: string;

  constructor(options: { now: () => number; defaultProjectId?: string }) {
    this.#now = options.now;
    this.#defaultProjectId = options.defaultProjectId ?? 'demo-project';
  }

  #bucketFor(locationId: string, queueName: string): QueueBucket {
    const key = `${locationId}/${queueName}`;
    let existing = this.#queues.get(key);
    if (existing === undefined) {
      existing = {
        seenIds: new Set<string>(),
        pendingById: new Map<string, StoredLocalTask>(),
      };
      this.#queues.set(key, existing);
    }
    return existing;
  }

  async enqueue(request: NormalizedAdminTaskEnqueue): Promise<void> {
    const locationId = request.locationId ?? 'us-central1';
    const projectId = request.projectId ?? this.#defaultProjectId;
    const bucket = this.#bucketFor(locationId, request.queueName);

    const taskId = request.id ?? randomUUID().replace(/-/g, '');
    if (request.id !== undefined && bucket.seenIds.has(taskId)) {
      throw new FirebaseFunctionsError(
        'task-already-exists',
        `A task with ID ${taskId} already exists`,
      );
    }
    const wireData = serializeTaskDataWire(request.data);
    bucket.seenIds.add(taskId);

    const nowMs = this.#now();
    let scheduledTime = new Date(nowMs).toISOString();
    if (request.scheduleTimeIso !== undefined) {
      scheduledTime = request.scheduleTimeIso;
    } else if (request.scheduleDelaySeconds !== undefined) {
      scheduledTime = new Date(nowMs + request.scheduleDelaySeconds * 1000).toISOString();
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (request.headers !== undefined) {
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = value;
      }
    }

    const stored: StoredLocalTask = {
      id: taskId,
      queueName: request.queueName,
      locationId,
      projectId,
      data: wireData,
      scheduledTime,
      dispatchDeadlineSeconds: request.dispatchDeadlineSeconds ?? 600,
      headers,
    };
    if (request.uri !== undefined) {
      stored.uri = request.uri;
    }
    bucket.pendingById.set(taskId, stored);
  }

  async delete(request: NormalizedAdminTaskDelete): Promise<void> {
    const locationId = request.locationId ?? 'us-central1';
    const bucket = this.#bucketFor(locationId, request.queueName);
    bucket.pendingById.delete(request.id);
  }

  listPending(queueName: string, locationId = 'us-central1'): StoredLocalTask[] {
    const bucket = this.#queues.get(`${locationId}/${queueName}`);
    if (bucket === undefined) return [];
    return Array.from(bucket.pendingById.values()).map(
      (task) => JSON.parse(JSON.stringify(task)) as StoredLocalTask,
    );
  }
}

function readSandboxClockNow(sandbox: Sandbox): number {
  if (isRemoteSandbox(sandbox)) {
    return Date.now();
  }
  try {
    return getClock(sandbox as LocalSandbox).now();
  } catch (err: unknown) {
    if (err instanceof Error) {
      return Date.now();
    }
    throw err;
  }
}

function getLocalStoreRegistry(): WeakMap<object, LocalAdminTaskStore> {
  const globalRecord = globalThis as GlobalTaskQueueRegistry;
  if (globalRecord[LOCAL_TASK_QUEUE_STORE] === undefined) {
    globalRecord[LOCAL_TASK_QUEUE_STORE] = new WeakMap<object, LocalAdminTaskStore>();
  }
  return globalRecord[LOCAL_TASK_QUEUE_STORE];
}

/** Read pending standalone tasks stored for `sandbox` in `locationId`/`queueName`. */
export function listStandaloneLocalTasks(
  sandbox: object,
  queueName: string,
  locationId = 'us-central1',
): StoredLocalTask[] {
  const store = getLocalStoreRegistry().get(sandbox);
  if (store === undefined) return [];
  return store.listPending(queueName, locationId);
}

/** Resolve the active task-queue dispatcher for `app`, falling back to the per-sandbox store. */
export function resolveTaskQueueDispatcher(app: PyricAdminApp): AdminTaskQueueDispatcher {
  const globalRecord = globalThis as GlobalTaskQueueRegistry;
  const sandboxKey = app.sandbox as unknown as object;

  const dispatcherMap = globalRecord[SANDBOX_TASK_QUEUE_DISPATCHER];
  if (dispatcherMap instanceof WeakMap) {
    const mappedDispatcher = dispatcherMap.get(sandboxKey);
    if (mappedDispatcher !== undefined) {
      return mappedDispatcher;
    }
  }

  const sandboxRecord = app.sandbox as unknown as Record<symbol, unknown>;
  const directSandboxDispatcher = sandboxRecord[SANDBOX_TASK_QUEUE_DISPATCHER] as
    | AdminTaskQueueDispatcher
    | undefined;
  if (directSandboxDispatcher !== undefined) {
    return directSandboxDispatcher;
  }

  const processDispatcher = globalRecord[PROCESS_TASK_QUEUE_DISPATCHER];
  if (isRemoteSandbox(app.sandbox) && processDispatcher !== undefined) {
    return processDispatcher;
  }

  const storeMap = getLocalStoreRegistry();
  let localStore = storeMap.get(sandboxKey);
  if (localStore === undefined) {
    const defaultProjectId =
      explicitProjectId(app) ??
      process.env.GCLOUD_PROJECT ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      'demo-project';
    localStore = new LocalAdminTaskStore({
      now: () => readSandboxClockNow(app.sandbox),
      defaultProjectId,
    });
    storeMap.set(sandboxKey, localStore);
  }
  return localStore;
}
