/**
 * Execution host for discovered `firebase-functions/v2/storage` triggers:
 * subscribes to the Storage mutation stream, routes matching bucket events,
 * and serializes handler executions cleanly.
 */
import type { StorageMutationNotification, StorageTriggerDelivery } from './delivery.js';
import {
  ARCHIVED_EVENT_TYPE,
  DELETED_EVENT_TYPE,
  FINALIZED_EVENT_TYPE,
  METADATA_UPDATED_EVENT_TYPE,
  discoverStorageTriggers,
  matchesStorageTriggerBucket,
  type DiscoveredStorageTrigger,
  type StorageEventType,
} from './discovery.js';
import {
  executeStorageTrigger,
  type StorageCloudEventOptions,
  type StorageExecutionResult,
  type StorageObjectSnapshot,
} from './event.js';

const MAX_ROLLED_BACK_COMMITS = 256;

interface ProjectedStorageDelivery {
  eventType: StorageEventType;
  bucket: string;
  storeBucket: string;
  object: StorageObjectSnapshot;
  at: number;
  commitGeneration?: string;
}

interface NotificationPhase {
  eventType: StorageEventType;
  object: StorageObjectSnapshot;
  commitGeneration?: string;
}

export interface StorageTriggerExecutionOptions {
  exported: Record<string, unknown>;
  delivery: StorageTriggerDelivery;
  defaultBucket?: string;
  eventOptions(
    projected: ProjectedStorageDelivery,
    sequence: number,
    trigger: DiscoveredStorageTrigger,
  ): Omit<StorageCloudEventOptions, 'eventType' | 'bucket'> | Promise<Omit<StorageCloudEventOptions, 'eventType' | 'bucket'>>;
  onExecution?(
    result: StorageExecutionResult,
    trigger: DiscoveredStorageTrigger,
    projected: ProjectedStorageDelivery,
  ): void;
  onDeliveryError?(error: unknown, trigger: DiscoveredStorageTrigger): void;
}

export interface StorageTriggerExecutionHost {
  readonly triggerCount: number;
  readonly ready: Promise<void>;
  idle(): Promise<void>;
  close(): void;
}

function resolveProjectedBucketName(
  trigger: DiscoveredStorageTrigger,
  notification: StorageMutationNotification,
  hostDefaultBucket: string | undefined,
  configuredDefaultBucket: string | undefined,
): string {
  if (notification.storeBucket !== 'pyric-default') {
    return trigger.bucket ?? notification.bucketName;
  }
  if (notification.bucketName !== '' && notification.bucketName !== 'pyric-default') {
    return notification.bucketName;
  }
  if (hostDefaultBucket !== undefined && hostDefaultBucket !== '' && hostDefaultBucket !== 'pyric-default') {
    return hostDefaultBucket;
  }
  if (trigger.bucket !== undefined && trigger.bucket !== '') {
    return trigger.bucket;
  }
  if (configuredDefaultBucket !== undefined && configuredDefaultBucket !== '') {
    return configuredDefaultBucket;
  }
  return notification.bucketName;
}

function withoutTimeDeleted(snapshot: StorageObjectSnapshot): StorageObjectSnapshot {
  if (snapshot.timeDeleted === undefined) return snapshot;
  const copy: StorageObjectSnapshot = { ...snapshot };
  delete copy.timeDeleted;
  return copy;
}

function withDeletedTimestamp(
  snapshot: StorageObjectSnapshot,
  at: number,
): StorageObjectSnapshot {
  if (typeof snapshot.timeDeleted === 'string' && snapshot.timeDeleted.length > 0) {
    return snapshot;
  }
  if (at <= 0) {
    return snapshot;
  }
  return {
    ...snapshot,
    timeDeleted: new Date(at).toISOString(),
  };
}

function rolledBackCommitKey(storeBucket: string, fullPath: string, generation: string): string {
  return `${storeBucket}/${fullPath}#${generation}`;
}

function rememberRolledBackCommit(rolledBack: Set<string>, key: string): void {
  if (rolledBack.has(key)) {
    rolledBack.delete(key);
  }
  rolledBack.add(key);
  while (rolledBack.size > MAX_ROLLED_BACK_COMMITS) {
    const oldest = rolledBack.values().next().value;
    if (oldest === undefined) break;
    rolledBack.delete(oldest);
  }
}

/**
 * Map a committed Storage sandbox mutation to ordered CloudEvent lifecycle phases.
 *
 * Local versioning semantics: in Google Cloud Storage production, `archived`
 * requires Object Versioning enabled on the bucket. In Pyric's local runtime,
 * overwriting an existing live object (`op === 'object_put'` with `before`
 * present) emits `archived` for the superseded `before` generation (without
 * `timeDeleted`) before `finalized` for the new `after` generation, while
 * `deleteObject` / `file.delete()` permanently deletes the live object and
 * emits `deleted` with `timeDeleted`. Mutations marked `rollback: true`
 * (from `storage.rollbackUpload` undoing a canceled upload) emit zero events.
 */
function projectNotificationPhases(
  notification: StorageMutationNotification,
): NotificationPhase[] {
  if (notification.rollback === true) return [];
  const phases: NotificationPhase[] = [];

  if (notification.op === 'object_put') {
    const commitGeneration = notification.after?.generation;
    if (notification.before !== undefined) {
      const archivedPhase: NotificationPhase = {
        eventType: ARCHIVED_EVENT_TYPE,
        object: withoutTimeDeleted(notification.before),
      };
      if (commitGeneration !== undefined) {
        archivedPhase.commitGeneration = commitGeneration;
      }
      phases.push(archivedPhase);
    }
    if (notification.after !== undefined) {
      phases.push({
        eventType: FINALIZED_EVENT_TYPE,
        object: notification.after,
        commitGeneration: notification.after.generation,
      });
    }
    return phases;
  }

  if (notification.op === 'metadata_update') {
    if (notification.after !== undefined) {
      phases.push({
        eventType: METADATA_UPDATED_EVENT_TYPE,
        object: notification.after,
      });
    }
    return phases;
  }

  if (notification.op === 'object_delete') {
    if (notification.before !== undefined) {
      phases.push({
        eventType: DELETED_EVENT_TYPE,
        object: withDeletedTimestamp(notification.before, notification.at),
      });
    }
  }

  return phases;
}

/** Subscribe discovered Storage triggers and serialize their handler runs. */
export function startStorageTriggerExecution(
  options: StorageTriggerExecutionOptions,
): StorageTriggerExecutionHost {
  const discoveryOptions: { defaultBucket?: string } = {};
  if (options.defaultBucket !== undefined) {
    discoveryOptions.defaultBucket = options.defaultBucket;
  }
  const triggers = discoverStorageTriggers(options.exported, discoveryOptions);
  let closed = false;
  let sequence = 0;
  let tail = Promise.resolve();
  let hostDefaultBucket: string | undefined;
  let readySettled = false;
  const rolledBackCommits = new Set<string>();
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
      if (notification.rollback === true) {
        if (notification.before !== undefined) {
          rememberRolledBackCommit(
            rolledBackCommits,
            rolledBackCommitKey(
              notification.storeBucket,
              notification.path,
              notification.before.generation,
            ),
          );
        }
        return;
      }

      const effectiveDefaultBucket = options.defaultBucket ?? hostDefaultBucket;
      const phases = projectNotificationPhases(notification);
      for (const phase of phases) {
        for (const trigger of triggers) {
          if (trigger.eventType !== phase.eventType) continue;
          const bucketCandidate: {
            storeBucket: string;
            bucketName: string;
            defaultBucket?: string;
          } = {
            storeBucket: notification.storeBucket,
            bucketName: notification.bucketName,
          };
          if (effectiveDefaultBucket !== undefined) {
            bucketCandidate.defaultBucket = effectiveDefaultBucket;
          }
          if (!matchesStorageTriggerBucket(trigger, bucketCandidate)) continue;

          const bucket = resolveProjectedBucketName(
            trigger,
            notification,
            hostDefaultBucket,
            options.defaultBucket,
          );
          const projected: ProjectedStorageDelivery = {
            eventType: phase.eventType,
            bucket,
            storeBucket: notification.storeBucket,
            object: phase.object,
            at: notification.at,
          };
          if (phase.commitGeneration !== undefined) {
            projected.commitGeneration = phase.commitGeneration;
          }

          const deliverySequence = ++sequence;
          tail = tail.then(async () => {
            if (closed) return;
            if (projected.commitGeneration !== undefined) {
              const commitKey = rolledBackCommitKey(
                projected.storeBucket,
                projected.object.fullPath,
                projected.commitGeneration,
              );
              if (rolledBackCommits.has(commitKey)) return;
            }
            const baseOptions = await options.eventOptions(projected, deliverySequence, trigger);
            let objectSnapshot = projected.object;
            if (
              projected.eventType === DELETED_EVENT_TYPE &&
              (objectSnapshot.timeDeleted === undefined || objectSnapshot.timeDeleted.length === 0)
            ) {
              objectSnapshot = {
                ...objectSnapshot,
                timeDeleted: baseOptions.time,
              };
            }
            const result = await executeStorageTrigger(trigger, objectSnapshot, {
              id: baseOptions.id,
              time: baseOptions.time,
              location: baseOptions.location,
              eventType: projected.eventType,
              bucket: projected.bucket,
            });
            options.onExecution?.(result, trigger, projected);
          });
        }
      }
    },
    (info) => {
      hostDefaultBucket = info.defaultBucket;
      if (!readySettled) {
        readySettled = true;
        markReady();
      }
    },
    (error) => {
      if (!readySettled) {
        readySettled = true;
        failReady(error);
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
