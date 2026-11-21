import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  MESSAGE_PUBLISHED_EVENT_TYPE,
  discoverPubSubTriggers,
} from '../../src/functions/pubsub/discovery.js';
import {
  buildPubSubCloudEvent,
  buildPubSubSubscriptionName,
  buildPubSubWireMessage,
  clonePubSubAttributes,
  encodePubSubPayloadToBase64,
  executePubSubTrigger,
  normalizePubSubPublishOptions,
} from '../../src/functions/pubsub/event.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const pubsubFunctions = requireFromConformance(
  'firebase-functions/v2/pubsub',
) as typeof import('firebase-functions/v2/pubsub');
const coreFunctions = requireFromConformance(
  'firebase-functions/v2/core',
) as typeof import('firebase-functions/v2/core');

describe('Pub/Sub CloudEvent v1.0 and MessagePublishedData encoder', () => {
  test('encodes JSON values, Buffer/Uint8Array/ArrayBuffer binary payloads, and empty payloads', () => {
    expect(encodePubSubPayloadToBase64(undefined)).toBe('');
    expect(encodePubSubPayloadToBase64(Buffer.alloc(0))).toBe('');
    expect(encodePubSubPayloadToBase64(new Uint8Array(0))).toBe('');
    expect(encodePubSubPayloadToBase64(new ArrayBuffer(0))).toBe('');

    const jsonObj = { orderId: 'ord-9', items: [1, 2], paid: true, note: null };
    const encodedJson = encodePubSubPayloadToBase64(jsonObj);
    expect(JSON.parse(Buffer.from(encodedJson, 'base64').toString('utf8'))).toEqual(jsonObj);

    expect(
      JSON.parse(Buffer.from(encodePubSubPayloadToBase64(null), 'base64').toString('utf8')),
    ).toBeNull();
    expect(
      JSON.parse(Buffer.from(encodePubSubPayloadToBase64('hello'), 'base64').toString('utf8')),
    ).toBe('hello');
    expect(
      JSON.parse(Buffer.from(encodePubSubPayloadToBase64(42), 'base64').toString('utf8')),
    ).toBe(42);

    const rawBytes = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0xfe]);
    const slicedView = rawBytes.subarray(1, 4);
    expect(Buffer.from(encodePubSubPayloadToBase64(slicedView), 'base64')).toEqual(
      Buffer.from([0xff, 0x10, 0x80]),
    );

    const arrayBuf = Uint8Array.from([9, 8, 7]).buffer;
    expect(Buffer.from(encodePubSubPayloadToBase64(arrayBuf), 'base64')).toEqual(
      Buffer.from([9, 8, 7]),
    );

    expect(() => encodePubSubPayloadToBase64(12n)).toThrow(TypeError);
    expect(() => encodePubSubPayloadToBase64(Symbol('bad'))).toThrow(TypeError);
    expect(() => encodePubSubPayloadToBase64(() => 'fn')).toThrow(TypeError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => encodePubSubPayloadToBase64(circular)).toThrow(TypeError);
  });

  test('normalizes direct attribute maps vs publish options and guards attribute types and __proto__', () => {
    expect(normalizePubSubPublishOptions(undefined)).toEqual({});
    expect(normalizePubSubPublishOptions({ source: 'checkout', region: 'us' })).toEqual({
      attributes: { source: 'checkout', region: 'us' },
    });

    const withProto = JSON.parse('{"__proto__":"literal-proto","env":"staging"}') as Record<
      string,
      string
    >;
    const cloned = clonePubSubAttributes(withProto);
    expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(cloned, '__proto__')).toBe(true);
    expect(cloned.env).toBe('staging');

    expect(
      normalizePubSubPublishOptions({
        attributes: { tier: 'gold' },
        orderingKey: 'customer-7',
        messageId: 'msg-custom-7',
        publishTime: '2026-11-21T15:00:00.000Z',
      }),
    ).toEqual({
      attributes: { tier: 'gold' },
      orderingKey: 'customer-7',
      messageId: 'msg-custom-7',
      publishTime: '2026-11-21T15:00:00.000Z',
    });

    expect(() =>
      clonePubSubAttributes({ bad: 123 } as unknown as Record<string, string>),
    ).toThrow(TypeError);
    expect(() =>
      normalizePubSubPublishOptions({ publishTime: 'not-a-timestamp' }),
    ).toThrow(RangeError);
    expect(() => normalizePubSubPublishOptions({ messageId: '' })).toThrow(TypeError);
  });

  test('round-trips JSON payloads, custom attributes, orderingKey, onInit, and v1-compat through firebase-functions@7.2.5 Message', async () => {
    const { Message, onMessagePublished } = pubsubFunctions;
    const { onInit } = coreFunctions;

    let initRan = false;
    onInit(() => {
      initRan = true;
    });

    let captured: Record<string, unknown> | undefined;
    const handler = onMessagePublished(
      { topic: 'orders', region: 'europe-west1' },
      async (event) => {
        const compat = event as unknown as {
          message?: { json: unknown; attributes: Record<string, string>; orderingKey?: string };
          context?: {
            eventId: string;
            timestamp: string;
            eventType: string;
            resource: { service: string; name: string };
          };
        };
        captured = {
          initRan,
          specversion: event.specversion,
          id: event.id,
          source: event.source,
          type: event.type,
          time: event.time,
          subscription: event.data.subscription,
          isMessageInstance: event.data.message instanceof Message,
          messageId: event.data.message.messageId,
          publishTime: event.data.message.publishTime,
          orderingKey: event.data.message.orderingKey,
          attributes: event.data.message.attributes,
          parsedJson: event.data.message.json,
          messageToJson: event.data.message.toJSON(),
          compatJson: compat.message?.json,
          compatEventId: compat.context?.eventId,
          compatEventType: compat.context?.eventType,
          compatResource: compat.context?.resource,
        };
        return 'order-processed';
      },
    );

    const [trigger] = discoverPubSubTriggers(
      { processOrder: handler },
      { projectId: 'demo-project' },
    );
    if (trigger === undefined) {
      throw new Error('expected processOrder trigger');
    }

    const wireMessage = buildPubSubWireMessage(
      { orderId: 'o-101', totalCents: 2599, tags: ['express'] },
      {
        messageId: 'msg-101',
        publishTime: '2026-11-21T15:10:00.000Z',
        attributes: { origin: 'web-checkout', priority: 'high' },
        orderingKey: 'acct-42',
      },
    );
    expect('json' in wireMessage).toBe(false);

    const outcome = await executePubSubTrigger(trigger, wireMessage, {
      id: 'ce-101',
      time: '2026-11-21T15:10:00.000Z',
      projectId: 'demo-project',
      topicId: 'orders',
      location: 'europe-west1',
    });

    expect(outcome.status).toBe('fulfilled');
    if (outcome.status === 'fulfilled') {
      expect(outcome.result).toBe('order-processed');
    }
    expect(outcome.subscription).toBe(
      buildPubSubSubscriptionName('demo-project', 'europe-west1', 'processOrder', 'orders'),
    );
    expect(captured).toEqual({
      initRan: true,
      specversion: '1.0',
      id: 'ce-101',
      source: '//pubsub.googleapis.com/projects/demo-project/topics/orders',
      type: MESSAGE_PUBLISHED_EVENT_TYPE,
      time: '2026-11-21T15:10:00.000Z',
      subscription:
        'projects/demo-project/subscriptions/eventarc-europe-west1-processOrder-orders',
      isMessageInstance: true,
      messageId: 'msg-101',
      publishTime: '2026-11-21T15:10:00.000Z',
      orderingKey: 'acct-42',
      attributes: { origin: 'web-checkout', priority: 'high' },
      parsedJson: { orderId: 'o-101', totalCents: 2599, tags: ['express'] },
      messageToJson: {
        messageId: 'msg-101',
        data: wireMessage.data,
        publishTime: '2026-11-21T15:10:00.000Z',
        attributes: { origin: 'web-checkout', priority: 'high' },
        orderingKey: 'acct-42',
      },
      compatJson: { orderId: 'o-101', totalCents: 2599, tags: ['express'] },
      compatEventId: 'msg-101',
      compatEventType: 'google.pubsub.topic.publish',
      compatResource: {
        service: 'pubsub.googleapis.com',
        name: 'projects/demo-project/topics/orders',
      },
    });
  });

  test('preserves binary Buffer/Uint8Array bytes, empty payloads, and real Message.json parse error parity', async () => {
    const { onMessagePublished } = pubsubFunctions;
    let decodedBinary: Buffer | undefined;
    let emptyDataValue: string | undefined;

    const binaryHandler = onMessagePublished('binary-stream', (event) => {
      decodedBinary = Buffer.from(event.data.message.data, 'base64');
    });
    const emptyHandler = onMessagePublished('empty-ping', (event) => {
      emptyDataValue = event.data.message.data;
    });
    const jsonReaderHandler = onMessagePublished('strict-json', (event) => {
      return event.data.message.json;
    });

    const triggers = discoverPubSubTriggers(
      { binaryHandler, emptyHandler, jsonReaderHandler },
      { projectId: 'demo-project' },
    );
    const [binTrigger, emptyTrigger, strictJsonTrigger] = triggers;
    if (
      binTrigger === undefined ||
      emptyTrigger === undefined ||
      strictJsonTrigger === undefined
    ) {
      throw new Error('expected three triggers');
    }

    const rawBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const binOutcome = await executePubSubTrigger(
      binTrigger,
      buildPubSubWireMessage(rawBytes, {
        messageId: 'm-bin',
        publishTime: '2026-11-21T15:15:00.000Z',
      }),
      {
        id: 'ce-bin',
        time: '2026-11-21T15:15:00.000Z',
        projectId: 'demo-project',
        topicId: 'binary-stream',
        location: 'us-central1',
      },
    );
    expect(binOutcome.status).toBe('fulfilled');
    expect(decodedBinary).toEqual(rawBytes);

    const emptyOutcome = await executePubSubTrigger(
      emptyTrigger,
      buildPubSubWireMessage(undefined, {
        messageId: 'm-empty',
        publishTime: '2026-11-21T15:15:01.000Z',
      }),
      {
        id: 'ce-empty',
        time: '2026-11-21T15:15:01.000Z',
        projectId: 'demo-project',
        topicId: 'empty-ping',
        location: 'us-central1',
      },
    );
    expect(emptyOutcome.status).toBe('fulfilled');
    expect(emptyDataValue).toBe('');

    const invalidJsonOutcome = await executePubSubTrigger(
      strictJsonTrigger,
      buildPubSubWireMessage(Buffer.from('{malformed-json', 'utf8'), {
        messageId: 'm-bad-json',
        publishTime: '2026-11-21T15:15:02.000Z',
      }),
      {
        id: 'ce-bad-json',
        time: '2026-11-21T15:15:02.000Z',
        projectId: 'demo-project',
        topicId: 'strict-json',
        location: 'us-central1',
      },
    );
    expect(invalidJsonOutcome.status).toBe('rejected');
    if (invalidJsonOutcome.status === 'rejected') {
      expect(invalidJsonOutcome.error).toBeInstanceOf(Error);
      expect((invalidJsonOutcome.error as Error).message).toContain(
        'Unable to parse Pub/Sub message data as JSON:',
      );
    }

    const emptyJsonOutcome = await executePubSubTrigger(
      strictJsonTrigger,
      buildPubSubWireMessage(undefined, {
        messageId: 'm-empty-json',
        publishTime: '2026-11-21T15:15:03.000Z',
      }),
      {
        id: 'ce-empty-json',
        time: '2026-11-21T15:15:03.000Z',
        projectId: 'demo-project',
        topicId: 'strict-json',
        location: 'us-central1',
      },
    );
    expect(emptyJsonOutcome.status).toBe('rejected');
    if (emptyJsonOutcome.status === 'rejected') {
      expect((emptyJsonOutcome.error as Error).message).toContain(
        'Unable to parse Pub/Sub message data as JSON:',
      );
    }
  });

  test('buildPubSubCloudEvent creates isolated per-subscriber message and attribute copies', () => {
    const wire = buildPubSubWireMessage(
      { ok: true },
      {
        messageId: 'msg-iso',
        publishTime: '2026-11-21T15:20:00.000Z',
        attributes: { role: 'primary' },
      },
    );

    const first = buildPubSubCloudEvent(wire, {
      id: 'ce-1',
      time: '2026-11-21T15:20:00.000Z',
      projectId: 'demo-project',
      topicId: 'events',
      location: 'us-central1',
      exportName: 'subOne',
    });
    const second = buildPubSubCloudEvent(wire, {
      id: 'ce-2',
      time: '2026-11-21T15:20:00.000Z',
      projectId: 'demo-project',
      topicId: 'events',
      location: 'us-central1',
      exportName: 'subTwo',
    });

    const firstData = first.data as {
      subscription: string;
      message: { attributes: Record<string, string> };
    };
    const secondData = second.data as {
      subscription: string;
      message: { attributes: Record<string, string> };
    };
    firstData.message.attributes.role = 'mutated';

    expect(secondData.message.attributes.role).toBe('primary');
    expect(firstData.subscription).not.toBe(secondData.subscription);
  });
});
