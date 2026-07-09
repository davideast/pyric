/**
 * `pyric-admin/messaging` — single `send(message, dryRun?)` on the sandbox arm.
 *
 * Covers the send-plane accept shapes (topic/condition numeric resource name,
 * token UUID-form resource name), dryRun-vs-real parity through the broker
 * (identical shape, identical validation — a rejected message rejects the same
 * way under dryRun), and the wrapped rejection envelopes for every captured
 * fault family, mapped to firebase-admin's client error codes.
 *
 * Blocking unit suite (no PYRIC_CLIMB flag): drives the real broker over a
 * real sandbox admin app, offline.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getMessagingBroker } from 'pyric/messaging/internal';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { FirebaseMessagingError, getMessaging, type Messaging } from '../../src/messaging/index.js';

/** `projects/<projectId>/messages/<id>` — numeric id for topic/condition. */
const NUMERIC_NAME = /^projects\/pyric-sandbox\/messages\/\d+$/;
/** Token targets mint a UUID-form id, not a numeric one. */
const UUID_NAME = /^projects\/pyric-sandbox\/messages\/[0-9a-f-]{36}$/;

// The registry is module-global (mirror of firebase-admin's defaultAppStore);
// leave it empty for the next file.
afterEach(async () => {
  for (const app of getApps()) await deleteApp(app);
});

function freshMessaging(): { svc: Messaging; broker: ReturnType<typeof getMessagingBroker> } {
  const sandbox = initializeSandbox();
  const app = initializeApp({ sandbox }, `send-${Math.random().toString(36).slice(2)}`);
  return { svc: getMessaging(app), broker: getMessagingBroker(sandbox) };
}

describe('send — accept shapes', () => {
  it('topic target resolves a numeric FCM resource name', async () => {
    const { svc } = freshMessaging();
    const name = await svc.send({ topic: 'oracle-topic', notification: { title: 't', body: 'b' } });
    expect(NUMERIC_NAME.test(name)).toBe(true);
  });

  it('condition target resolves a numeric FCM resource name', async () => {
    const { svc } = freshMessaging();
    const name = await svc.send({ condition: "'a' in topics && 'b' in topics", data: { k: 'v' } });
    expect(NUMERIC_NAME.test(name)).toBe(true);
  });

  it('token target resolves a UUID-form resource name', async () => {
    const { svc, broker } = freshMessaging();
    const token = broker.getTokenFor('reg-1');
    const name = await svc.send({ token });
    expect(UUID_NAME.test(name)).toBe(true);
  });

  it('accepts notification-only and data-only messages', async () => {
    const { svc } = freshMessaging();
    expect(NUMERIC_NAME.test(await svc.send({ topic: 'oracle-topic', notification: { title: 't' } }))).toBe(true);
    expect(NUMERIC_NAME.test(await svc.send({ topic: 'oracle-topic', data: { k: 'v' } }))).toBe(true);
  });

  it('accepts a webpush config with headers.TTL and fcmOptions.link', async () => {
    const { svc } = freshMessaging();
    const name = await svc.send({
      topic: 'oracle-topic',
      webpush: { headers: { TTL: '3600' }, fcmOptions: { link: 'https://example.com/oracle' } },
    });
    expect(NUMERIC_NAME.test(name)).toBe(true);
  });
});

describe('send — dryRun vs real parity', () => {
  it('dryRun returns the SAME shape as a real send (topic → numeric)', async () => {
    const { svc } = freshMessaging();
    const real = await svc.send({ topic: 'oracle-topic' });
    const dry = await svc.send({ topic: 'oracle-topic' }, true);
    expect(NUMERIC_NAME.test(real)).toBe(true);
    expect(NUMERIC_NAME.test(dry)).toBe(true);
  });

  it('dryRun returns the SAME shape as a real send (token → UUID)', async () => {
    const { svc, broker } = freshMessaging();
    const token = broker.getTokenFor('reg-1');
    expect(UUID_NAME.test(await svc.send({ token }))).toBe(true);
    expect(UUID_NAME.test(await svc.send({ token }, true))).toBe(true);
  });

  it('dryRun runs the identical validation path — a bad message rejects under dryRun too', async () => {
    const { svc } = freshMessaging();
    let real: unknown;
    let dry: unknown;
    try {
      await svc.send({ token: 'not-a-valid-fcm-token' });
    } catch (e) {
      real = e;
    }
    try {
      await svc.send({ token: 'not-a-valid-fcm-token' }, true);
    } catch (e) {
      dry = e;
    }
    expect((real as { code: string }).code).toBe('messaging/invalid-argument');
    expect((dry as { code: string }).code).toBe('messaging/invalid-argument');
  });
});

describe('send — wrapped rejection envelopes', () => {
  async function rejectionOf(message: Record<string, unknown>): Promise<FirebaseMessagingError> {
    const { svc } = freshMessaging();
    let err: unknown;
    try {
      await svc.send(message as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FirebaseMessagingError);
    return err as FirebaseMessagingError;
  }

  it('no target → invalid-argument, with the captured "Recipient" message', async () => {
    const err = await rejectionOf({});
    expect(err.code).toBe('messaging/invalid-argument');
    expect(err.message).toBe('Recipient of the message is not set.');
  });

  it('multiple targets → invalid-argument', async () => {
    const err = await rejectionOf({ token: 'a:APA91bZ', topic: 'oracle-topic' });
    expect(err.code).toBe('messaging/invalid-argument');
  });

  it('malformed token → invalid-argument', async () => {
    const err = await rejectionOf({ token: 'not-a-valid-fcm-token' });
    expect(err.code).toBe('messaging/invalid-argument');
  });

  it('well-formed unregistered token → registration-token-not-registered (the UNREGISTERED map)', async () => {
    const err = await rejectionOf({ token: 'aaaa:APA91bNEVERMINTED' });
    expect(err.code).toBe('messaging/registration-token-not-registered');
  });

  it('a minted-then-deleted token → registration-token-not-registered', async () => {
    const { svc, broker } = freshMessaging();
    const token = broker.getTokenFor('reg-dead');
    broker.deleteTokenFor('reg-dead');
    let err: unknown;
    try {
      await svc.send({ token });
    } catch (e) {
      err = e;
    }
    expect((err as FirebaseMessagingError).code).toBe('messaging/registration-token-not-registered');
  });

  it('invalid topic name → invalid-argument', async () => {
    const err = await rejectionOf({ topic: 'bad#topic!name', notification: { title: 't' } });
    expect(err.code).toBe('messaging/invalid-argument');
  });

  it('malformed condition → invalid-argument', async () => {
    const err = await rejectionOf({ condition: "'a' in topics &&", data: { k: 'v' } });
    expect(err.code).toBe('messaging/invalid-argument');
  });

  it('non-numeric webpush TTL → invalid-argument', async () => {
    const err = await rejectionOf({ topic: 'oracle-topic', webpush: { headers: { TTL: 'not-a-number' } } });
    expect(err.code).toBe('messaging/invalid-argument');
  });

  it('oversized data payload → invalid-argument', async () => {
    // The broker's empirical enforcement boundary is 4506 summed data bytes.
    const err = await rejectionOf({ topic: 'oracle-topic', data: { p: 'x'.repeat(4506) } });
    expect(err.code).toBe('messaging/invalid-argument');
  });
});
