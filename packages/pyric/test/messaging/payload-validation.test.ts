import { describe, expect, it } from 'bun:test';
import {
  BrokerSendError,
  getMessagingBroker,
  validateClientMessage,
  validateMessage,
  type BrokerMessage,
} from 'pyric/messaging/internal';
import { initializeSandbox } from 'pyric/sandbox';

function expectInvalidPayload(fn: () => void, expectedSubstring: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BrokerSendError);
  const sendError = caught as BrokerSendError;
  expect(sendError.errorCode).toBe('INVALID_PAYLOAD');
  expect(sendError.message).toContain(expectedSubstring);
}

describe('payload-validation', () => {
  it('rejects non-object messages and invalid option blocks at client preflight', () => {
    expectInvalidPayload(
      () => validateClientMessage(null as unknown as BrokerMessage),
      'Message must be a non-null object',
    );
    expectInvalidPayload(
      () => validateClientMessage([] as unknown as BrokerMessage),
      'Message must be a non-null object',
    );
    expectInvalidPayload(
      () => validateClientMessage({ topic: 'alerts', notification: null as never }),
      'notification must be a non-null object',
    );
    expectInvalidPayload(
      () => validateClientMessage({ topic: 'alerts', notification: { imageUrl: 'not-a-url' } }),
      'notification.imageUrl must be a valid URL string',
    );
    expectInvalidPayload(
      () => validateClientMessage({ topic: 'alerts', webpush: { headers: { TTL: 3600 as never } } }),
      'webpush.headers must only contain string values',
    );
    expectInvalidPayload(
      () => validateClientMessage({ topic: 'alerts', webpush: { data: { count: 1 as never } } }),
      'webpush.data must only contain string values',
    );
    expectInvalidPayload(
      () => validateClientMessage({ topic: 'alerts', android: { ttl: -1 } as never }),
      'TTL must be a non-negative duration in milliseconds',
    );
    expectInvalidPayload(
      () => validateClientMessage({ topic: 'alerts', apns: { liveActivityToken: '' } as never }),
      'apns.liveActivityToken must be a non-empty string',
    );
    expectInvalidPayload(
      () => validateClientMessage({ topic: 'alerts', fcmOptions: { analyticsLabel: 42 as never } }),
      'analyticsLabel must be a string value',
    );
  });

  it('leaves wire-level target and condition syntax to validateMessage', () => {
    expect(() => validateClientMessage({} as BrokerMessage)).not.toThrow();
    expect(() => validateClientMessage({ condition: "'t0'intopics" })).not.toThrow();
    expect(() => validateMessage({} as BrokerMessage)).toThrow(BrokerSendError);
    expect(() => validateMessage({ condition: "'t0'intopics" })).toThrow(BrokerSendError);
  });

  it('accepts valid notification, webpush, android, apns, and fcmOptions blocks', () => {
    const validMessage: BrokerMessage = {
      topic: 'alerts',
      data: { item: '1' },
      notification: { title: 'Alert', imageUrl: 'https://example.com/item.png' },
      webpush: { headers: { TTL: '3600' }, data: { item: '1' } },
      android: {
        ttl: 60_000,
        data: { item: '1' },
        notification: { color: '#112233', imageUrl: 'https://example.com/item.png' },
        fcmOptions: { analyticsLabel: 'campaign' },
      },
      apns: {
        liveActivityToken: 'live-tok',
        headers: { 'apns-priority': '10' },
        payload: { aps: { alert: 'hi' } },
        fcmOptions: { analyticsLabel: 'campaign', imageUrl: 'https://example.com/item.png' },
      },
      fcmOptions: { analyticsLabel: 'campaign' },
    };
    expect(() => validateClientMessage(validMessage)).not.toThrow();
    expect(validateMessage(validMessage)).toEqual({ kind: 'topic', topic: 'alerts' });
  });

  it('validates lowercase and mixed-case webpush.headers.ttl and reports canonical message.webpush.headers.TTL', () => {
    const sandbox = initializeSandbox();
    const broker = getMessagingBroker(sandbox);

    const acceptedReal = broker.send({ topic: 'alerts', webpush: { headers: { ttl: '60' } } });
    const acceptedDry = broker.send(
      { topic: 'alerts', webpush: { headers: { ttl: '60' } } },
      { validateOnly: true },
    );
    expect(acceptedReal.name).toMatch(/^projects\/pyric-sandbox\/messages\/\d+$/);
    expect(acceptedDry.name).toMatch(/^projects\/pyric-sandbox\/messages\/\d+$/);

    const expectedEnvelope = {
      status: 400,
      error: {
        code: 400,
        message: 'TTL must be a non-negative integer.',
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [
              {
                field: 'message.webpush.headers.TTL',
                description: 'TTL must be a non-negative integer.',
              },
            ],
          },
          {
            '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
            errorCode: 'INVALID_ARGUMENT',
          },
        ],
      },
    };

    for (const headers of [
      { ttl: '-1' },
      { ttl: 'abc' },
      { Ttl: '-1' },
      { TTL: '60', ttl: '-1' },
    ]) {
      for (const validateOnly of [false, true]) {
        let caught: unknown;
        try {
          broker.send({ topic: 'alerts', webpush: { headers } }, { validateOnly });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(BrokerSendError);
        expect((caught as BrokerSendError).envelope).toEqual(expectedEnvelope);
      }
    }
  });
});
