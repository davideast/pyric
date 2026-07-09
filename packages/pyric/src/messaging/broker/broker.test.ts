/**
 * Unit tests for the sandbox messaging broker — the in-process degenerate
 * case. These run in the BLOCKING suite (no PYRIC_CLIMB flag): they import
 * relatively from src and never touch the climb-gated mirror entry points.
 *
 * Where an assertion pins an envelope, the EXPECTED side is loaded from the
 * committed oracle observation JSON (never re-derived by hand), the same
 * discipline the conformance suites use.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { initializeSandbox } from '../../sandbox/index.js';
import type { SandboxEvent, ServiceMutationEvent } from '../../sandbox/types.js';
import { MessagingBroker } from './broker.js';
import { getMessagingBroker } from './index.js';
import { BrokerSendError } from './envelopes.js';
import { EMPIRICAL_DATA_CAP_BYTES, parseCondition } from './validate.js';

const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', '..', 'scripts', 'oracle', 'observations');

function obs(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')).behavior;
}

/** The captured envelope subset the broker mirrors: `{ status, error }`. */
function capturedEnvelope(name: string): { status: number; error: Record<string, unknown> } {
  const b = obs(name);
  return { status: b.status, error: b.error };
}

function rejectionOf(fn: () => unknown): BrokerSendError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerSendError);
    return error as BrokerSendError;
  }
  throw new Error('expected the call to throw');
}

describe('messaging broker — token lifecycle', () => {
  it('mints the captured token shape class, stable per registration', () => {
    const broker = new MessagingBroker();
    const shape = obs('messaging-web-token-shape');
    const token = broker.getTokenFor('reg-1');
    expect(token.length).toBe(shape.length);
    expect(token.includes(':')).toBe(shape.colonSeparated);
    expect(token.split(':')[1]!.startsWith('APA91b')).toBe(shape.suffixAfterColonStartsWithAPA91b);
    expect(/^[A-Za-z0-9_:-]+$/.test(token)).toBe(shape.urlSafe);
    // Stability (oracle: messaging-web-token-stability) + distinct registrations differ.
    expect(broker.getTokenFor('reg-1')).toBe(token);
    expect(broker.getTokenFor('reg-2')).not.toBe(token);
  });

  it('deleteToken invalidates: dead-token sends produce the captured UNREGISTERED envelope', () => {
    const broker = new MessagingBroker();
    const o = obs('messaging-web-deletetoken-unregistered');
    const token = broker.getTokenFor('reg-1');
    expect(broker.deleteTokenFor('reg-1')).toBe(o.deleteTokenResolvedTruthy);

    const err = rejectionOf(() => broker.send({ token }));
    expect(err.envelope.status).toBe(o.unregisteredHttpStatus);
    expect(err.envelope.error.status).toBe(o.unregisteredErrorStatus);
    expect(err.envelope.error.code).toBe(o.unregisteredErrorCodeTop);
    expect(err.envelope.error.message.length > 0).toBe(o.unregisteredMessagePresent);
    expect(err.envelope.error.details!.map((d) => d['@type'])).toEqual(o.unregisteredDetailTypes);
    expect(err.errorCode).toBe(o.fcmErrorCode);
    // No delivery on either route after deletion.
    let delivered = 0;
    broker.onForegroundMessage(() => delivered++);
    broker.onBackgroundMessage(() => delivered++);
    rejectionOf(() => broker.send({ token }));
    expect(delivered).toBe(0);
  });
});

describe('messaging broker — intake validation (captured envelopes, byte-matched)', () => {
  const cases: Array<{ observation: string; message: Record<string, unknown> }> = [
    { observation: 'messaging-send-no-target-error-envelope', message: {} },
    { observation: 'messaging-send-invalid-token-error-envelope', message: { token: 'not-a-valid-fcm-token' } },
    {
      observation: 'messaging-send-invalid-topic-name-error-envelope',
      message: { topic: 'bad#topic!name', notification: { title: 't' } },
    },
    {
      observation: 'messaging-send-invalid-condition-error-envelope',
      message: { condition: "'a' in topics &&", data: { k: 'v' } },
    },
    {
      observation: 'messaging-send-webpush-invalid-ttl-error-envelope',
      message: { topic: 'oracle-topic', webpush: { headers: { TTL: 'not-a-number' } } },
    },
    {
      observation: 'messaging-send-oversized-payload-error-envelope',
      message: { topic: 'pyric-oracle-messaging-probe', data: { p: 'x'.repeat(8192) } },
    },
  ];

  for (const { observation, message } of cases) {
    it(`byte-matches ${observation} (including per-case detail ordering)`, () => {
      const broker = new MessagingBroker();
      const captured = capturedEnvelope(observation);
      const err = rejectionOf(() => broker.send(message));
      expect(err.envelope.status).toBe(captured.status);
      expect(err.envelope.error).toEqual(captured.error as any);
      // validate_only parity: the dryRun path rejects with the identical envelope.
      const dry = rejectionOf(() => broker.send(message, { validateOnly: true }));
      expect(dry.envelope).toEqual(err.envelope);
    });
  }

  it('enforces the bisected payload boundary (4505 accepted / 4506 rejected for the probe shape)', () => {
    const broker = new MessagingBroker();
    const o = obs('messaging-send-oversized-payload-error-envelope');
    const mk = (len: number) => ({ topic: 'pyric-oracle-messaging-probe', data: { p: 'x'.repeat(len) } });
    expect(() => broker.send(mk(o.largestAcceptedDataValueLen), { validateOnly: true })).not.toThrow();
    rejectionOf(() => broker.send(mk(o.smallestRejectedDataValueLen), { validateOnly: true }));
    // The model constant is the probe key byte + the accepted value length.
    expect(EMPIRICAL_DATA_CAP_BYTES).toBe(1 + o.largestAcceptedDataValueLen);
  });

  it('accepts topic/condition/notification-only/data-only/webpush sends with per-target id formats', () => {
    const broker = new MessagingBroker();
    const topicSend = broker.send({ topic: 'oracle-topic', notification: { title: 't', body: 'b' } });
    expect(topicSend.name).toMatch(/^projects\/pyric-sandbox\/messages\/\d+$/);
    const conditionSend = broker.send({ condition: "'a' in topics && 'b' in topics", data: { k: 'v' } });
    expect(conditionSend.name).toMatch(/^projects\/pyric-sandbox\/messages\/\d+$/);
    broker.send({ topic: 'oracle-topic', notification: { title: 't' } });
    broker.send({ topic: 'oracle-topic', data: { k: 'v' } });
    broker.send({
      topic: 'oracle-topic',
      webpush: { headers: { TTL: '3600' }, fcmOptions: { link: 'https://example.com/oracle' } },
    });
    // Token target → UUID-form message id.
    const token = broker.getTokenFor('reg-1');
    const tokenSend = broker.send({ token, data: { k: 'v' } });
    expect(tokenSend.name).toMatch(
      /^projects\/pyric-sandbox\/messages\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // dryRun returns the SAME shape (fake id).
    const dry = broker.send({ topic: 'oracle-topic', data: { k: 'v' } }, { validateOnly: true });
    expect(dry.name).toMatch(/^projects\/pyric-sandbox\/messages\/\d+$/);
  });

  it('parses the captured-valid condition grammar and rejects dangling operators', () => {
    expect(parseCondition("'a' in topics && 'b' in topics")).toEqual({ topics: ['a', 'b'] });
    expect(parseCondition("'a' in topics || ('b' in topics && !('c' in topics))")).toEqual({
      topics: ['a', 'b', 'c'],
    });
    expect(parseCondition("'a' in topics &&")).toBeNull();
    expect(parseCondition('a in topics')).toBeNull();
  });
});

describe('messaging broker — delivery routing (the captured visibility rule)', () => {
  it('routes foreground iff any visible client, else background — exclusively', () => {
    const broker = new MessagingBroker();
    const routing = obs('messaging-web-visibility-routing');
    const foreground: unknown[] = [];
    const background: unknown[] = [];
    broker.onForegroundMessage((p) => foreground.push(p));
    broker.onBackgroundMessage((p) => background.push(p));

    broker.setClientVisibility('window-0', 'visible');
    const visible = broker.deliver({ notification: { title: 't', body: 'b' }, data: { demo: '1' } });
    expect(visible.route).toBe(routing.visibleClient.deliveredTo === 'onMessage' ? 'foreground' : 'background');
    expect(foreground.length).toBe(1);
    expect(background.length).toBe(0);

    broker.setClientVisibility('window-0', 'hidden');
    const hidden = broker.deliver({ data: { demo: '1' } });
    expect(hidden.route).toBe(routing.noVisibleClient.deliveredTo === 'onBackgroundMessage' ? 'background' : 'foreground');
    expect(foreground.length).toBe(1);
    expect(background.length).toBe(1);
  });

  it('delivers the captured envelope keys; data-only carries no notification key', () => {
    const broker = new MessagingBroker();
    const fg = obs('messaging-web-onmessage-foreground');
    const dataOnly = obs('messaging-web-data-only-background');
    const received: any[] = [];
    broker.onForegroundMessage((p) => received.push(p));
    broker.setClientVisibility('window-0', 'visible');
    broker.deliver({ notification: { title: 't', body: 'b' }, data: { demo: '1', source: 's', tag: 'g' } });
    expect(Object.keys(received[0]).sort()).toEqual([...fg.topLevelKeys].sort());
    expect(received[0].from).toBe(broker.senderId);

    const bg: any[] = [];
    broker.onBackgroundMessage((p) => bg.push(p));
    broker.setClientVisibility('window-0', 'hidden');
    broker.deliver({ data: { demo: '1', source: 's', tag: 'g' } });
    expect(Object.keys(bg[0]).sort()).toEqual([...dataOnly.topLevelKeys].sort());
    expect('notification' in bg[0]).toBe(dataOnly.hasNotificationKey);
  });

  it('routes an accepted topic send to subscribed active tokens (send→deliver loop)', () => {
    const broker = new MessagingBroker();
    const token = broker.getTokenFor('reg-1');
    broker.subscribeToTopic([token], 'news');
    const received: any[] = [];
    broker.onBackgroundMessage((p) => received.push(p));
    broker.send({ topic: 'news', data: { k: 'v' } });
    expect(received.length).toBe(1);
    // Unsubscribed topic → accepted, nothing delivered.
    broker.send({ topic: 'other', data: { k: 'v' } });
    expect(received.length).toBe(1);
    // Condition matches the token's topic set.
    broker.send({ condition: "'news' in topics && !('other' in topics)", data: { k: 'v' } });
    expect(received.length).toBe(2);
  });
});

describe('messaging broker — typed sandbox events (tracing consumes the stream)', () => {
  it('emits the full op vocabulary onto the sandbox onEvent stream', () => {
    const sandbox = initializeSandbox();
    const broker = getMessagingBroker(sandbox);
    expect(getMessagingBroker(sandbox)).toBe(broker); // one broker per sandbox

    const events: ServiceMutationEvent[] = [];
    sandbox.onEvent((event: SandboxEvent) => {
      if (event.kind === 'service_mutation' && event.service === 'messaging') events.push(event);
    });

    const token = broker.getTokenFor('reg-1');
    broker.subscribeToTopic([token], 'news');
    broker.setClientVisibility('window-0', 'hidden');
    broker.send({ topic: 'news', data: { k: 'v' } });
    try {
      broker.send({});
    } catch {
      // expected rejection
    }
    broker.deleteTokenFor('reg-1');

    const ops = events.map((e) => e.op);
    expect(ops).toEqual([
      'token_minted',
      'subscription_changed',
      'message_accepted',
      'delivery_routed',
      'message_delivered',
      'message_rejected',
      'token_deleted',
    ]);
    // Events carry the service discriminator both on the body and provenance.
    for (const event of events) expect(event.service).toBe('messaging');
  });
});
