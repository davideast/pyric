/**
 * Execution host for discovered `firebase-functions/v2/pubsub` triggers:
 * subscribes to the Pub/Sub topic bus, fans out concurrently to matching
 * subscribers, orders messages sharing a non-empty `orderingKey` per trigger,
 * and drains cleanly on shutdown.
 */
import { serializeError } from '../child-protocol.js';
import type {
  PubSubDeliveryReceipt,
  PubSubPublishedEnvelope,
  PubSubTriggerDelivery,
} from './delivery.js';
import {
  defaultProjectIdFromEnv,
  discoverPubSubTriggers,
  matchesPubSubTopic,
  type DiscoveredPubSubTrigger,
} from './discovery.js';
import {
  executePubSubTrigger,
  type PubSubExecutionResult,
} from './event.js';

const DEFAULT_LOCATION = 'us-central1';

interface PubSubEventEnvelopeMetadata {
  id: string;
  time: string;
}

export interface PubSubTriggerExecutionOptions {
  exported: Record<string, unknown>;
  delivery: PubSubTriggerDelivery;
  projectId?: string;
  defaultLocation?: string;
  eventOptions?(
    envelope: PubSubPublishedEnvelope,
    sequence: number,
    trigger: DiscoveredPubSubTrigger,
  ): PubSubEventEnvelopeMetadata | Promise<PubSubEventEnvelopeMetadata>;
  onExecution?(
    result: PubSubExecutionResult,
    trigger: DiscoveredPubSubTrigger,
    envelope: PubSubPublishedEnvelope,
  ): void;
  onDeliveryError?(error: unknown, trigger: DiscoveredPubSubTrigger): void;
}

export interface PubSubTriggerExecutionHost {
  readonly triggerCount: number;
  readonly triggers: readonly DiscoveredPubSubTrigger[];
  readonly ready: Promise<void>;
  idle(): Promise<void>;
  close(): void;
}

function toIpcSafeResult(value: unknown): { present: true; value: unknown } | { present: false } {
  if (value === undefined) return { present: false };
  if (
    typeof value === 'bigint' ||
    typeof value === 'symbol' ||
    typeof value === 'function'
  ) {
    return { present: false };
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { present: false };
    return { present: true, value: JSON.parse(serialized) };
  } catch {
    // Non-JSON return values from event handlers are omitted across JSON IPC.
    return { present: false };
  }
}

function toDeliveryReceipt(
  trigger: DiscoveredPubSubTrigger,
  result: PubSubExecutionResult,
  startedAt: number,
  durationMs: number,
): PubSubDeliveryReceipt {
  if (result.status === 'fulfilled') {
    const receipt: PubSubDeliveryReceipt = {
      exportName: trigger.exportName,
      subscription: result.subscription,
      retry: trigger.retry,
      startedAt,
      durationMs,
      status: 'fulfilled',
    };
    const safeResult = toIpcSafeResult(result.result);
    if (safeResult.present) {
      receipt.result = safeResult.value;
    }
    return receipt;
  }
  return {
    exportName: trigger.exportName,
    subscription: result.subscription,
    retry: trigger.retry,
    startedAt,
    durationMs,
    status: 'rejected',
    error: serializeError(result.error),
  };
}

/** Subscribe discovered Pub/Sub triggers with non-blocking concurrent delivery. */
export function startPubSubTriggerExecution(
  options: PubSubTriggerExecutionOptions,
): PubSubTriggerExecutionHost {
  const effectiveProjectId = options.projectId ?? defaultProjectIdFromEnv();
  const defaultLocation = options.defaultLocation ?? DEFAULT_LOCATION;
  const triggers = discoverPubSubTriggers(options.exported, {
    projectId: effectiveProjectId,
  });

  let closed = false;
  let sequence = 0;
  let readySettled = false;
  const inFlight = new Set<Promise<void>>();
  const orderingChains = new Map<string, Promise<void>>();
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
      triggers,
      ready,
      idle: async () => undefined,
      close() {
        closed = true;
      },
    };
  }

  const runSingleTriggerDelivery = async (
    trigger: DiscoveredPubSubTrigger,
    envelope: PubSubPublishedEnvelope,
    deliverySequence: number,
  ): Promise<PubSubDeliveryReceipt | null> => {
    if (closed) return null;
    let id = `${envelope.message.messageId}-${deliverySequence}`;
    let time = envelope.message.publishTime;
    if (options.eventOptions !== undefined) {
      const resolvedMeta = await options.eventOptions(
        envelope,
        deliverySequence,
        trigger,
      );
      id = resolvedMeta.id;
      time = resolvedMeta.time;
    }
    const location = trigger.location ?? defaultLocation;
    const parsedTime = Date.parse(time);
    const startedAt = Number.isNaN(parsedTime) ? Date.now() : parsedTime;
    const startedMono = performance.now();
    const result = await executePubSubTrigger(trigger, envelope.message, {
      id,
      time,
      projectId: envelope.topic.projectId,
      topicId: envelope.topic.topicId,
      location,
    });
    const durationMs = Math.max(0, performance.now() - startedMono);
    options.onExecution?.(result, trigger, envelope);
    return toDeliveryReceipt(trigger, result, startedAt, durationMs);
  };

  const trackDelivery = (
    trigger: DiscoveredPubSubTrigger,
    envelope: PubSubPublishedEnvelope,
  ): Promise<PubSubDeliveryReceipt | null> => {
    const deliverySequence = ++sequence;
    const orderingKey = envelope.message.orderingKey;

    let receiptPromise: Promise<PubSubDeliveryReceipt | null>;
    if (orderingKey !== undefined && orderingKey.length > 0) {
      const chainKey = `${trigger.exportName}\0${orderingKey}`;
      const previous = orderingChains.get(chainKey) ?? Promise.resolve();
      receiptPromise = previous.then(() =>
        runSingleTriggerDelivery(trigger, envelope, deliverySequence),
      );
      const chainStep = receiptPromise.then(
        () => undefined,
        () => undefined,
      );
      orderingChains.set(chainKey, chainStep);
      void chainStep.finally(() => {
        if (orderingChains.get(chainKey) === chainStep) {
          orderingChains.delete(chainKey);
        }
      });
    } else {
      receiptPromise = runSingleTriggerDelivery(
        trigger,
        envelope,
        deliverySequence,
      );
    }

    const tracked = receiptPromise.then(
      () => undefined,
      () => undefined,
    );
    inFlight.add(tracked);
    void tracked.finally(() => {
      inFlight.delete(tracked);
    });
    return receiptPromise;
  };

  const stopSubscription = options.delivery.subscribe(
    async (envelope) => {
      if (closed) return [];
      const matchingTriggers = triggers.filter((trigger) =>
        matchesPubSubTopic(trigger, envelope.topic, effectiveProjectId),
      );
      if (matchingTriggers.length === 0) return [];

      const rawReceipts = await Promise.all(
        matchingTriggers.map((trigger) => trackDelivery(trigger, envelope)),
      );
      const receipts: PubSubDeliveryReceipt[] = [];
      for (const receipt of rawReceipts) {
        if (receipt !== null) {
          receipts.push(receipt);
        }
      }
      return receipts;
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
      }
      for (const trigger of triggers) {
        options.onDeliveryError?.(error, trigger);
      }
    },
  );

  return {
    triggerCount: triggers.length,
    triggers,
    ready,
    async idle(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      stopSubscription();
    },
  };
}
