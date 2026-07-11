/**
 * `pyric-admin/messaging` — `subscribeToTopic` / `unsubscribeFromTopic`.
 *
 * Covers the `MessagingTopicManagementResponse` shape
 * (`{ successCount, failureCount, errors: [{ index, error }] }`), single-string
 * vs array token inputs, idempotency (re-subscribe and re-unsubscribe stay
 * green), the per-token error entries with index preserved and the reason →
 * error-code mapping (invalid-token → invalid-registration-token,
 * unregistered-token → registration-token-not-registered), and the
 * invalid-topic / empty-input rejections.
 *
 * Blocking unit suite (no PYRIC_CLIMB flag): real broker, real sandbox app.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getMessagingBroker } from 'pyric/messaging/internal';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { FirebaseMessagingError, getMessaging, type Messaging } from '../../src/messaging/index.js';

afterEach(async () => {
  for (const app of getApps()) await deleteApp(app);
});

function freshMessaging(): { svc: Messaging; broker: ReturnType<typeof getMessagingBroker> } {
  const sandbox = initializeSandbox();
  const app = initializeApp({ sandbox }, `topic-${Math.random().toString(36).slice(2)}`);
  return { svc: getMessaging(app), broker: getMessagingBroker(sandbox) };
}

describe('subscribeToTopic / unsubscribeFromTopic — response shape', () => {
  it('a single-string token subscribes with successCount 1 and no errors', async () => {
    const { svc, broker } = freshMessaging();
    const token = broker.getTokenFor('reg-1');
    const res = await svc.subscribeToTopic(token, 'news');
    expect(res).toEqual({ successCount: 1, failureCount: 0, errors: [] });
  });

  it('a token array subscribes all with the same aggregate shape', async () => {
    const { svc, broker } = freshMessaging();
    const tokens = [broker.getTokenFor('a'), broker.getTokenFor('b'), broker.getTokenFor('c')];
    const res = await svc.subscribeToTopic(tokens, 'news');
    expect(res.successCount).toBe(3);
    expect(res.failureCount).toBe(0);
    expect(res.errors).toEqual([]);
  });

  it('accepts a /topics/-prefixed topic name (admin SDK strips it)', async () => {
    const { svc, broker } = freshMessaging();
    const res = await svc.subscribeToTopic(broker.getTokenFor('a'), '/topics/news');
    expect(res.successCount).toBe(1);
  });
});

describe('topic management — idempotency', () => {
  it('re-subscribing the same token stays successful (set semantics)', async () => {
    const { svc, broker } = freshMessaging();
    const token = broker.getTokenFor('reg-1');
    expect((await svc.subscribeToTopic(token, 'news')).successCount).toBe(1);
    const again = await svc.subscribeToTopic(token, 'news');
    expect(again.successCount).toBe(1);
    expect(again.failureCount).toBe(0);
  });

  it('unsubscribing an already-absent token stays successful', async () => {
    const { svc, broker } = freshMessaging();
    const token = broker.getTokenFor('reg-1');
    expect((await svc.unsubscribeFromTopic(token, 'news')).successCount).toBe(1);
    const again = await svc.unsubscribeFromTopic(token, 'news');
    expect(again.successCount).toBe(1);
    expect(again.failureCount).toBe(0);
  });
});

describe('topic management — per-token error entries', () => {
  it('a malformed token yields an errors entry with its index and INVALID_REGISTRATION_TOKEN', async () => {
    const { svc, broker } = freshMessaging();
    const good = broker.getTokenFor('reg-1');
    const res = await svc.subscribeToTopic([good, 'bad token'], 'news');
    expect(res.successCount).toBe(1);
    expect(res.failureCount).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.index).toBe(1);
    expect(res.errors[0]!.error).toBeInstanceOf(FirebaseMessagingError);
    expect((res.errors[0]!.error as FirebaseMessagingError).code).toBe('messaging/invalid-registration-token');
  });

  it('a minted-then-deleted token yields REGISTRATION_TOKEN_NOT_REGISTERED', async () => {
    const { svc, broker } = freshMessaging();
    const token = broker.getTokenFor('reg-dead');
    broker.deleteTokenFor('reg-dead');
    const res = await svc.subscribeToTopic(token, 'news');
    expect(res.successCount).toBe(0);
    expect(res.failureCount).toBe(1);
    expect(res.errors[0]!.index).toBe(0);
    expect((res.errors[0]!.error as FirebaseMessagingError).code).toBe(
      'messaging/registration-token-not-registered',
    );
  });
});

describe('topic management — rejections', () => {
  it('an invalid topic name rejects the whole call with invalid-argument', async () => {
    const { svc, broker } = freshMessaging();
    let err: unknown;
    try {
      await svc.subscribeToTopic(broker.getTokenFor('a'), 'bad topic!');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FirebaseMessagingError);
    expect((err as FirebaseMessagingError).code).toBe('messaging/invalid-argument');
  });

  it('an empty token array rejects with invalid-argument', async () => {
    const { svc } = freshMessaging();
    let err: unknown;
    try {
      await svc.subscribeToTopic([], 'news');
    } catch (e) {
      err = e;
    }
    expect((err as FirebaseMessagingError).code).toBe('messaging/invalid-argument');
    expect((err as Error).message).toMatch(/non-empty/);
  });
});
