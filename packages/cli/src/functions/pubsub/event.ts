/**
 * CloudEvent v1.0 and `MessagePublishedData` encoder for `firebase-functions/v2/pubsub`
 * (`7.2.5`), matching Eventarc Pub/Sub wire payloads so `lib/v2/providers/pubsub.js`
 * instantiates its real `Message` class, `json` getter, and v1-compat properties.
 */
import {
  MESSAGE_PUBLISHED_EVENT_TYPE,
  type DiscoveredPubSubTrigger,
} from './discovery.js';

export type PubSubAttributes = Record<string, string>;

export interface PubSubPublishOptions {
  attributes?: PubSubAttributes;
  orderingKey?: string;
  messageId?: string;
  publishTime?: string;
  dataBase64?: string;
}

export type PubSubPublishAttributesOrOptions =
  | PubSubAttributes
  | PubSubPublishOptions;

export interface PubSubWireMessage {
  messageId: string;
  publishTime: string;
  data: string;
  attributes: PubSubAttributes;
  orderingKey?: string;
}

export interface PubSubCloudEventOptions {
  id: string;
  time: string;
  projectId: string;
  topicId: string;
  location: string;
  exportName: string;
  subscription?: string;
}

export type PubSubExecutionResult =
  | {
      status: 'fulfilled';
      event: Record<string, unknown>;
      subscription: string;
      result: unknown;
    }
  | {
      status: 'rejected';
      event: Record<string, unknown>;
      subscription: string;
      error: unknown;
    };

const PUBLISH_OPTION_KEYS: ReadonlySet<string> = new Set([
  'attributes',
  'orderingKey',
  'messageId',
  'publishTime',
  'dataBase64',
]);

function defineOwnStringKey(
  target: Record<string, string>,
  key: string,
  value: string,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Validate and clone a Pub/Sub attributes map without prototype pollution. */
export function clonePubSubAttributes(
  rawAttributes: unknown,
): PubSubAttributes {
  if (rawAttributes === undefined) return {};
  if (
    typeof rawAttributes !== 'object' ||
    rawAttributes === null ||
    Array.isArray(rawAttributes)
  ) {
    throw new TypeError('Pub/Sub attributes must be a plain string record.');
  }
  const cloned: PubSubAttributes = {};
  for (const [key, value] of Object.entries(
    rawAttributes as Record<string, unknown>,
  )) {
    if (typeof value !== 'string') {
      throw new TypeError(
        `Pub/Sub attribute '${key}' must be a string, received ${typeof value}.`,
      );
    }
    defineOwnStringKey(cloned, key, value);
  }
  return cloned;
}

function isPublishOptionsEnvelope(candidate: Record<string, unknown>): boolean {
  if (Object.prototype.hasOwnProperty.call(candidate, 'attributes')) {
    const rawAttr = candidate.attributes;
    if (rawAttr === undefined) return true;
    if (typeof rawAttr === 'object' && rawAttr !== null && !Array.isArray(rawAttr)) {
      return true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(candidate, 'dataBase64')) {
    return true;
  }
  const keys = Object.keys(candidate);
  if (keys.length === 0) return false;
  return keys.every((key) => PUBLISH_OPTION_KEYS.has(key));
}

/**
 * Normalize the optional third argument of `publishPubSub(topic, payload, attributesOrOptions?)`
 * into a validated `PubSubPublishOptions` object.
 */
export function normalizePubSubPublishOptions(
  attributesOrOptions?: PubSubPublishAttributesOrOptions,
): PubSubPublishOptions {
  if (attributesOrOptions === undefined) return {};
  if (
    typeof attributesOrOptions !== 'object' ||
    attributesOrOptions === null ||
    Array.isArray(attributesOrOptions)
  ) {
    throw new TypeError(
      'Pub/Sub publish attributes or options must be a plain object.',
    );
  }

  const record = attributesOrOptions as Record<string, unknown>;
  if (!isPublishOptionsEnvelope(record)) {
    return {
      attributes: clonePubSubAttributes(record),
    };
  }

  const normalized: PubSubPublishOptions = {};
  if (record.attributes !== undefined) {
    normalized.attributes = clonePubSubAttributes(record.attributes);
  }
  if (record.orderingKey !== undefined) {
    if (typeof record.orderingKey !== 'string') {
      throw new TypeError('Pub/Sub orderingKey must be a string.');
    }
    normalized.orderingKey = record.orderingKey;
  }
  if (record.messageId !== undefined) {
    if (typeof record.messageId !== 'string' || record.messageId.length === 0) {
      throw new TypeError('Pub/Sub messageId must be a non-empty string.');
    }
    normalized.messageId = record.messageId;
  }
  if (record.publishTime !== undefined) {
    if (
      typeof record.publishTime !== 'string' ||
      record.publishTime.length === 0 ||
      Number.isNaN(Date.parse(record.publishTime))
    ) {
      throw new RangeError(
        'Pub/Sub publishTime must be a valid ISO-8601 timestamp string.',
      );
    }
    normalized.publishTime = new Date(Date.parse(record.publishTime)).toISOString();
  }
  if (record.dataBase64 !== undefined) {
    if (typeof record.dataBase64 !== 'string') {
      throw new TypeError('Pub/Sub dataBase64 must be a base64 string.');
    }
    normalized.dataBase64 = record.dataBase64;
  }
  return normalized;
}

/**
 * Encode a Pub/Sub payload to RFC 4648 base64:
 * - `undefined`: empty payload (`""`)
 * - `Uint8Array` / `Buffer` / `ArrayBuffer`: raw binary bytes
 * - Any JSON-serializable value (`object`, `array`, `string`, `number`, `boolean`, `null`):
 *   UTF-8 JSON text encoded as base64 so `event.data.message.json` round-trips cleanly.
 */
export function encodePubSubPayloadToBase64(
  payload: unknown,
  dataBase64Override?: string,
): string {
  if (dataBase64Override !== undefined) {
    if (typeof dataBase64Override !== 'string') {
      throw new TypeError('Pub/Sub dataBase64 must be a string.');
    }
    return dataBase64Override;
  }
  if (payload === undefined) {
    return '';
  }
  if (payload instanceof Uint8Array) {
    if (payload.byteLength === 0) return '';
    return Buffer.from(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    ).toString('base64');
  }
  if (payload instanceof ArrayBuffer) {
    if (payload.byteLength === 0) return '';
    return Buffer.from(payload).toString('base64');
  }
  if (
    typeof payload === 'bigint' ||
    typeof payload === 'symbol' ||
    typeof payload === 'function'
  ) {
    throw new TypeError(
      `Pub/Sub payload of type ${typeof payload} is not JSON-serializable.`,
    );
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Pub/Sub payload is not JSON-serializable: ${detail}`);
  }
  if (serialized === undefined) {
    throw new TypeError('Pub/Sub payload is not JSON-serializable.');
  }
  return Buffer.from(serialized, 'utf8').toString('base64');
}

/** Build the wire `message` object carried inside `MessagePublishedData`. */
export function buildPubSubWireMessage(
  payload: unknown,
  options: {
    messageId: string;
    publishTime: string;
    attributes?: PubSubAttributes;
    orderingKey?: string;
    dataBase64?: string;
  },
): PubSubWireMessage {
  const data = encodePubSubPayloadToBase64(payload, options.dataBase64);
  const attributes = clonePubSubAttributes(options.attributes);
  const wire: PubSubWireMessage = {
    messageId: options.messageId,
    publishTime: options.publishTime,
    data,
    attributes,
  };
  if (options.orderingKey !== undefined && options.orderingKey.length > 0) {
    wire.orderingKey = options.orderingKey;
  }
  return wire;
}

/** Build the synthetic Eventarc subscription resource path for one subscriber. */
export function buildPubSubSubscriptionName(
  projectId: string,
  location: string,
  exportName: string,
  topicId: string,
): string {
  return `projects/${projectId}/subscriptions/eventarc-${location}-${exportName}-${topicId}`;
}

/**
 * Construct a fresh CloudEvent v1.0 envelope per subscriber delivery.
 *
 * `firebase-functions/v2/pubsub` mutates `event.data.message = new Message(...)`
 * and patches v1-compat getters directly on `event`, so each subscriber receives
 * an isolated envelope and cloned `message` object.
 */
export function buildPubSubCloudEvent(
  message: PubSubWireMessage,
  options: PubSubCloudEventOptions,
): Record<string, unknown> {
  const subscription =
    options.subscription ??
    buildPubSubSubscriptionName(
      options.projectId,
      options.location,
      options.exportName,
      options.topicId,
    );

  const wireMessageCopy: Record<string, unknown> = {
    messageId: message.messageId,
    publishTime: message.publishTime,
    data: message.data,
    attributes: clonePubSubAttributes(message.attributes),
  };
  if (message.orderingKey !== undefined && message.orderingKey.length > 0) {
    wireMessageCopy.orderingKey = message.orderingKey;
  }

  return {
    specversion: '1.0',
    id: options.id,
    source: `//pubsub.googleapis.com/projects/${options.projectId}/topics/${options.topicId}`,
    type: MESSAGE_PUBLISHED_EVENT_TYPE,
    time: options.time,
    data: {
      subscription,
      message: wireMessageCopy,
    },
  };
}

/** Invoke the real `firebase-functions/v2/pubsub` wrapper with a fresh CloudEvent. */
export async function executePubSubTrigger(
  trigger: DiscoveredPubSubTrigger,
  message: PubSubWireMessage,
  options: Omit<PubSubCloudEventOptions, 'exportName'>,
): Promise<PubSubExecutionResult> {
  const subscription =
    options.subscription ??
    buildPubSubSubscriptionName(
      options.projectId,
      options.location,
      trigger.exportName,
      options.topicId,
    );
  const event = buildPubSubCloudEvent(message, {
    id: options.id,
    time: options.time,
    projectId: options.projectId,
    topicId: options.topicId,
    location: options.location,
    exportName: trigger.exportName,
    subscription,
  });

  try {
    const result = await trigger.callable(event);
    return { status: 'fulfilled', event, subscription, result };
  } catch (error) {
    return { status: 'rejected', event, subscription, error };
  }
}
