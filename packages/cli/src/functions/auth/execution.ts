/**
 * Execution host for discovered Gen 1 Firebase Auth triggers (`user.create` and
 * `user.delete`): subscribes to Auth user lifecycle mutations, builds v1
 * `UserRecord` wire payloads and `EventContext`s, and serializes executions.
 */
import type {
  AuthLifecycleNotification,
  AuthLifecycleTriggerDelivery,
} from './delivery.js';
import {
  AUTH_USER_CREATED_EVENT_TYPE,
  AUTH_USER_DELETED_EVENT_TYPE,
  discoverAuthLifecycleTriggers,
  type AuthLifecycleEventType,
  type DiscoveredAuthLifecycleTrigger,
} from './discovery.js';
import {
  buildAuthLifecycleEventContext,
  buildAuthLifecycleUserWireData,
  executeAuthLifecycleTrigger,
  type AuthLifecycleExecutionResult,
} from './event.js';

export interface AuthLifecycleEventMetadata {
  eventId: string;
  timestamp: string;
}

export interface AuthLifecycleTriggerExecutionOptions {
  exported: Record<string, unknown>;
  delivery: AuthLifecycleTriggerDelivery;
  projectId: string;
  eventMetadata(
    notification: AuthLifecycleNotification,
    sequence: number,
    trigger: DiscoveredAuthLifecycleTrigger,
  ): AuthLifecycleEventMetadata | Promise<AuthLifecycleEventMetadata>;
  onExecution?(
    result: AuthLifecycleExecutionResult,
    trigger: DiscoveredAuthLifecycleTrigger,
    notification: AuthLifecycleNotification,
  ): void;
  onDeliveryError?(error: unknown, trigger: DiscoveredAuthLifecycleTrigger): void;
}

export interface AuthLifecycleTriggerExecutionHost {
  readonly triggerCount: number;
  readonly ready: Promise<void>;
  idle(): Promise<void>;
  close(): void;
}

function eventTypeForOp(op: AuthLifecycleNotification['op']): AuthLifecycleEventType {
  return op === 'user_create' ? AUTH_USER_CREATED_EVENT_TYPE : AUTH_USER_DELETED_EVENT_TYPE;
}

function discoverWithProjectFallback(
  exported: Record<string, unknown>,
  projectId: string,
): DiscoveredAuthLifecycleTrigger[] {
  const hadProjectEnv =
    typeof process.env.GCLOUD_PROJECT === 'string' && process.env.GCLOUD_PROJECT.length > 0;
  const priorProjectEnv = process.env.GCLOUD_PROJECT;
  if (!hadProjectEnv && projectId.length > 0) {
    process.env.GCLOUD_PROJECT = projectId;
  }
  try {
    return discoverAuthLifecycleTriggers(exported);
  } finally {
    if (!hadProjectEnv) {
      if (priorProjectEnv === undefined) {
        delete process.env.GCLOUD_PROJECT;
      } else {
        process.env.GCLOUD_PROJECT = priorProjectEnv;
      }
    }
  }
}

/** Subscribe discovered Gen 1 Auth lifecycle triggers and serialize their runs. */
export function startAuthLifecycleTriggerExecution(
  options: AuthLifecycleTriggerExecutionOptions,
): AuthLifecycleTriggerExecutionHost {
  const triggers = discoverWithProjectFallback(options.exported, options.projectId);
  let closed = false;
  let sequence = 0;
  let tail = Promise.resolve();
  let readySettled = false;
  const {
    promise: ready,
    resolve: markReady,
    reject: failReady,
  } = Promise.withResolvers<void>();

  if (triggers.length === 0) {
    readySettled = true;
    markReady();
    return {
      triggerCount: 0,
      ready,
      idle: () => tail,
      close() {
        closed = true;
      },
    };
  }

  const stopSubscription = options.delivery.subscribe(
    (notification) => {
      if (closed) return;
      const eventType = eventTypeForOp(notification.op);
      const wireData = buildAuthLifecycleUserWireData(notification.user);
      for (const trigger of triggers) {
        if (trigger.eventType !== eventType) continue;
        const nextSeq = ++sequence;
        tail = tail
          .then(async () => {
            if (closed) return;
            const meta = await options.eventMetadata(notification, nextSeq, trigger);
            if (closed) return;
            const context = buildAuthLifecycleEventContext({
              eventId: meta.eventId,
              eventType,
              projectId: options.projectId,
              timestamp: meta.timestamp,
            });
            const result = await executeAuthLifecycleTrigger(trigger, wireData, context, {
              projectId: options.projectId,
            });
            options.onExecution?.(result, trigger, notification);
          })
          .catch((error: unknown) => {
            options.onDeliveryError?.(error, trigger);
          });
      }
    },
    () => {
      if (!readySettled) {
        readySettled = true;
        markReady();
      }
    },
    (error) => {
      if (!readySettled) {
        readySettled = true;
        failReady(error);
        return;
      }
      for (const trigger of triggers) {
        options.onDeliveryError?.(error, trigger);
      }
    },
  );

  return {
    triggerCount: triggers.length,
    ready,
    idle: () => tail,
    close() {
      if (closed) return;
      closed = true;
      stopSubscription();
    },
  };
}
