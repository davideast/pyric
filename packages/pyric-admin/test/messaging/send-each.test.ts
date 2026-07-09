/**
 * `pyric-admin/messaging` — `sendEach` / `sendEachForMulticast` aggregate shapes.
 *
 * Covers the `BatchResponse` contract: `responses` ordered one-per-input,
 * `successCount` / `failureCount` summing the batch, per-entry
 * `{ success, messageId }` vs `{ success, error }`, partial failures mixing
 * valid and invalid targets, dryRun parity, the empty / oversized guards, and
 * the multicast fan-out over `tokens`.
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
  const app = initializeApp({ sandbox }, `each-${Math.random().toString(36).slice(2)}`);
  return { svc: getMessaging(app), broker: getMessagingBroker(sandbox) };
}

describe('sendEach — aggregate shape', () => {
  it('all-success: successCount = length, failureCount = 0, one messageId per input in order', async () => {
    const { svc } = freshMessaging();
    const res = await svc.sendEach([{ topic: 'a' }, { topic: 'b' }, { condition: "'c' in topics" }]);
    expect(res.responses).toHaveLength(3);
    expect(res.successCount).toBe(3);
    expect(res.failureCount).toBe(0);
    for (const r of res.responses) {
      expect(r.success).toBe(true);
      expect(typeof r.messageId).toBe('string');
      expect(r.error).toBeUndefined();
    }
  });

  it('partial failure: responses preserve input order and mix success / error entries', async () => {
    const { svc, broker } = freshMessaging();
    const token = broker.getTokenFor('reg-ok');
    // Index 0 valid topic, 1 invalid token, 2 valid token → success, fail, success.
    const res = await svc.sendEach([{ topic: 'a' }, { token: 'not-a-valid-fcm-token' }, { token }]);
    expect(res.successCount).toBe(2);
    expect(res.failureCount).toBe(1);
    expect(res.responses.map((r) => r.success)).toEqual([true, false, true]);
    expect(res.responses[0]!.messageId).toBeDefined();
    expect(res.responses[2]!.messageId).toBeDefined();

    const failed = res.responses[1]!;
    expect(failed.messageId).toBeUndefined();
    expect(failed.error).toBeInstanceOf(FirebaseMessagingError);
    expect((failed.error as FirebaseMessagingError).code).toBe('messaging/invalid-argument');
  });

  it('surfaces distinct wrapped codes per failing entry', async () => {
    const { svc } = freshMessaging();
    // Malformed token → invalid-argument; well-formed unminted token → UNREGISTERED.
    const res = await svc.sendEach([{ token: 'not-a-valid-fcm-token' }, { token: 'aaaa:APA91bGHOST' }]);
    expect(res.successCount).toBe(0);
    expect(res.failureCount).toBe(2);
    expect((res.responses[0]!.error as FirebaseMessagingError).code).toBe('messaging/invalid-argument');
    expect((res.responses[1]!.error as FirebaseMessagingError).code).toBe(
      'messaging/registration-token-not-registered',
    );
  });

  it('dryRun returns the same aggregate shape without changing counts', async () => {
    const { svc } = freshMessaging();
    const res = await svc.sendEach([{ topic: 'a' }, { topic: 'b' }], true);
    expect(res.successCount).toBe(2);
    expect(res.failureCount).toBe(0);
    for (const r of res.responses) expect(r.messageId).toBeDefined();
  });

  it('rejects an empty batch with invalid-argument (not an empty BatchResponse)', async () => {
    const { svc } = freshMessaging();
    let err: unknown;
    try {
      await svc.sendEach([]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FirebaseMessagingError);
    expect((err as FirebaseMessagingError).code).toBe('messaging/invalid-argument');
    expect((err as Error).message).toMatch(/non-empty/);
  });

  it('rejects a batch larger than 500', async () => {
    const { svc } = freshMessaging();
    const messages = Array.from({ length: 501 }, (_, i) => ({ topic: `t${i}` }));
    let err: unknown;
    try {
      await svc.sendEach(messages);
    } catch (e) {
      err = e;
    }
    expect((err as FirebaseMessagingError).code).toBe('messaging/invalid-argument');
    expect((err as Error).message).toMatch(/500/);
  });
});

describe('sendEachForMulticast — fan-out', () => {
  it('fans the shared base over every token, one response per token in order', async () => {
    const { svc, broker } = freshMessaging();
    const t1 = broker.getTokenFor('m1');
    const t2 = broker.getTokenFor('m2');
    const res = await svc.sendEachForMulticast({ tokens: [t1, t2], notification: { title: 'x' } });
    expect(res.responses).toHaveLength(2);
    expect(res.successCount).toBe(2);
    expect(res.failureCount).toBe(0);
  });

  it('partial failure across a token list preserves order', async () => {
    const { svc, broker } = freshMessaging();
    const good = broker.getTokenFor('m1');
    const res = await svc.sendEachForMulticast({
      tokens: [good, 'not-a-valid-fcm-token', 'aaaa:APA91bGHOST'],
      data: { k: 'v' },
    });
    expect(res.responses.map((r) => r.success)).toEqual([true, false, false]);
    expect(res.successCount).toBe(1);
    expect(res.failureCount).toBe(2);
    expect((res.responses[1]!.error as FirebaseMessagingError).code).toBe('messaging/invalid-argument');
    expect((res.responses[2]!.error as FirebaseMessagingError).code).toBe(
      'messaging/registration-token-not-registered',
    );
  });

  it('rejects an empty token list with invalid-argument', async () => {
    const { svc } = freshMessaging();
    let err: unknown;
    try {
      await svc.sendEachForMulticast({ tokens: [] });
    } catch (e) {
      err = e;
    }
    expect((err as FirebaseMessagingError).code).toBe('messaging/invalid-argument');
    expect((err as Error).message).toMatch(/non-empty/);
  });

  it('rejects a token list larger than 500', async () => {
    const { svc } = freshMessaging();
    const tokens = Array.from({ length: 501 }, (_, i) => `aaaa:APA91b${i}`);
    let err: unknown;
    try {
      await svc.sendEachForMulticast({ tokens });
    } catch (e) {
      err = e;
    }
    expect((err as FirebaseMessagingError).code).toBe('messaging/invalid-argument');
    expect((err as Error).message).toMatch(/500/);
  });
});
