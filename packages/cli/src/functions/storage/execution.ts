/**
 * Execution host for discovered `firebase-functions/v2/storage` triggers:
 * subscribes to the Storage mutation stream, routes matching bucket events,
 * and serializes handler executions cleanly.
 */
import type { StorageMutationNotification, StorageTriggerDelivery } from './delivery.js';
import {
  FINALIZED_EVENT_TYPE,
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

interface ProjectedStorageDelivery {
  eventType: StorageEventType;
  bucket: string;
  object: StorageObjectSnapshot;
  at: number;
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

function projectStorageDeliveries(
  notification: StorageMutationNotification,
  trigger: DiscoveredStorageTrigger,
  hostDefaultBucket: string | undefined,
  configuredDefaultBucket: string | undefined,
): ProjectedStorageDelivery[] {
  if (notification.rollback === true) return [];
  const matchesBucket = matchesStorageTriggerBucket(trigger, {
    storeBucket: notification.storeBucket,
    bucketName: notification.bucketName,
    defaultBucket: configuredDefaultBucket ?? hostDefaultBucket,
  });
  if (!matchesBucket) return [];

  const bucket = resolveProjectedBucketName(
    trigger,
    notification,
    hostDefaultBucket,
    configuredDefaultBucket,
  );
  const deliveries: ProjectedStorageDelivery[] = [];

  if (notification.op === 'object_put' && notification.after !== undefined) {
    if (trigger.eventType === FINALIZED_EVENT_TYPE) {
      deliveries.push({
        eventType: FINALIZED_EVENT_TYPE,
        bucket,
        object: notification.after,
        at: notification.at,
      });
    }
  }

  return deliveries;
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
      for (const trigger of triggers) {
        const projectedList = projectStorageDeliveries(
          notification,
          trigger,
          hostDefaultBucket,
          options.defaultBucket,
        );
        for (const projected of projectedList) {
          const deliverySequence = ++sequence;
          tail = tail.then(async () => {
            if (closed) return;
            const baseOptions = await options.eventOptions(projected, deliverySequence, trigger);
            const result = await executeStorageTrigger(trigger, projected.object, {
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
