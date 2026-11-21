/**
 * Deterministic in-memory Pub/Sub topic bus and delivery adapter for
 * `firebase-functions/v2/pubsub` trigger execution.
 */
import type { SerializedFunctionsError } from '../child-protocol.js';
import {
  normalizePubSubTopic,
  type ResolvedPubSubTopic,
} from './discovery.js';
import {
  buildPubSubWireMessage,
  clonePubSubAttributes,
  normalizePubSubPublishOptions,
  type PubSubAttributes,
  type PubSubPublishAttributesOrOptions,
  type PubSubWireMessage,
} from './event.js';

export interface PubSubPublishedEnvelope {
  topic: ResolvedPubSubTopic;
  message: PubSubWireMessage;
}

export interface PubSubDeliveryReceipt {
  exportName: string;
  subscription: string;
  retry: boolean;
  startedAt: number;
  durationMs: number;
  status: 'fulfilled' | 'rejected';
  result?: unknown;
  error?: SerializedFunctionsError;
}

export interface PubSubPublishResult {
  messageId: string;
  publishTime: string;
  topic: string;
  topicResource: string;
  matchedCount: number;
  deliveries: PubSubDeliveryReceipt[];
}

export interface PubSubWirePublishRequest {
  topic: string;
  dataBase64: string;
  attributes?: PubSubAttributes;
  orderingKey?: string;
  messageId?: string;
  publishTime?: string;
}

export type PubSubDeliveryListener = (
  envelope: PubSubPublishedEnvelope,
) => PubSubDeliveryReceipt[] | Promise<PubSubDeliveryReceipt[]>;

export interface PubSubTriggerDelivery {
  subscribe(
    listener: PubSubDeliveryListener,
    onReady?: () => void,
    onError?: (error: unknown) => void,
  ): () => void;
}

export interface InMemoryPubSubTopicBusOptions {
  projectId?: string;
  now?: () => number | Promise<number>;
}

function cloneEnvelope(envelope: PubSubPublishedEnvelope): PubSubPublishedEnvelope {
  const topicCopy: ResolvedPubSubTopic = {
    projectId: envelope.topic.projectId,
    topicId: envelope.topic.topicId,
    resourceName: envelope.topic.resourceName,
  };
  if (envelope.topic.explicitProject !== undefined) {
    topicCopy.explicitProject = envelope.topic.explicitProject;
  }

  const messageCopy: PubSubWireMessage = {
    messageId: envelope.message.messageId,
    publishTime: envelope.message.publishTime,
    data: envelope.message.data,
    attributes: clonePubSubAttributes(envelope.message.attributes),
  };
  if (envelope.message.orderingKey !== undefined) {
    messageCopy.orderingKey = envelope.message.orderingKey;
  }

  return {
    topic: topicCopy,
    message: messageCopy,
  };
}

/**
 * Deterministic in-memory Pub/Sub topic bus supporting concurrent publishes,
 * multi-subscriber fan-out, and clean teardown.
 */
export class InMemoryPubSubTopicBus implements PubSubTriggerDelivery {
  readonly #listeners = new Set<PubSubDeliveryListener>();
  readonly #projectId: string;
  readonly #now: () => number | Promise<number>;
  #sequence = 0;
  #closed = false;

  constructor(options: InMemoryPubSubTopicBusOptions = {}) {
    this.#projectId = options.projectId ?? 'demo-project';
    this.#now = options.now ?? Date.now;
  }

  subscribe(
    listener: PubSubDeliveryListener,
    onReady?: () => void,
  ): () => void {
    if (!this.#closed) {
      this.#listeners.add(listener);
    }
    onReady?.();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
  }

  async publish(
    rawTopic: string,
    payload?: unknown,
    attributesOrOptions?: PubSubPublishAttributesOrOptions,
  ): Promise<PubSubPublishResult> {
    if (this.#closed) {
      throw new Error('Pub/Sub topic bus is closed.');
    }
    const topic = normalizePubSubTopic(rawTopic, this.#projectId);
    const normalizedOptions = normalizePubSubPublishOptions(attributesOrOptions);
    const nextSequence = ++this.#sequence;
    const messageId = normalizedOptions.messageId ?? `pubsub-msg-${nextSequence}`;

    let publishTime = normalizedOptions.publishTime;
    if (publishTime === undefined) {
      const nowMs = await this.#now();
      publishTime = new Date(nowMs).toISOString();
    }

    const wireOptions: {
      messageId: string;
      publishTime: string;
      attributes?: PubSubAttributes;
      orderingKey?: string;
      dataBase64?: string;
    } = {
      messageId,
      publishTime,
    };
    if (normalizedOptions.attributes !== undefined) {
      wireOptions.attributes = normalizedOptions.attributes;
    }
    if (normalizedOptions.orderingKey !== undefined) {
      wireOptions.orderingKey = normalizedOptions.orderingKey;
    }
    if (normalizedOptions.dataBase64 !== undefined) {
      wireOptions.dataBase64 = normalizedOptions.dataBase64;
    }

    const message = buildPubSubWireMessage(payload, wireOptions);
    return this.#dispatchEnvelope({ topic, message });
  }

  async publishWire(request: PubSubWirePublishRequest): Promise<PubSubPublishResult> {
    const options: {
      dataBase64: string;
      attributes?: PubSubAttributes;
      orderingKey?: string;
      messageId?: string;
      publishTime?: string;
    } = {
      dataBase64: request.dataBase64,
    };
    if (request.attributes !== undefined) {
      options.attributes = request.attributes;
    }
    if (request.orderingKey !== undefined) {
      options.orderingKey = request.orderingKey;
    }
    if (request.messageId !== undefined) {
      options.messageId = request.messageId;
    }
    if (request.publishTime !== undefined) {
      options.publishTime = request.publishTime;
    }
    return this.publish(request.topic, undefined, options);
  }

  async #dispatchEnvelope(
    envelope: PubSubPublishedEnvelope,
  ): Promise<PubSubPublishResult> {
    const activeListeners = [...this.#listeners];
    const receiptGroups = await Promise.all(
      activeListeners.map((listener) => listener(cloneEnvelope(envelope))),
    );
    const deliveries = receiptGroups.flat();
    return {
      messageId: envelope.message.messageId,
      publishTime: envelope.message.publishTime,
      topic: envelope.topic.topicId,
      topicResource: envelope.topic.resourceName,
      matchedCount: deliveries.length,
      deliveries,
    };
  }
}
