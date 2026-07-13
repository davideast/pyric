/**
 * `pyric-admin/messaging` — error-class fidelity.
 *
 * The mirror re-exports firebase-admin's OWN `FirebaseMessagingError` and
 * `MessagingClientErrorCode` verbatim, so `instanceof`, `constructor.name`,
 * `.code`, and the static `{ code, message }` members match production exactly.
 * This suite pins that identity (the re-exports ARE firebase-admin's exports),
 * the thrown-error class fidelity across the send and topic planes, and the
 * client error-code shapes.
 *
 * Blocking unit suite (no PYRIC_CLIMB flag): real broker, real sandbox app.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getMessagingBroker } from 'pyric/messaging/internal';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import {
  FirebaseMessagingError,
  MessagingClientErrorCode,
  getMessaging,
  type Messaging,
} from '../../src/messaging/index.js';

afterEach(async () => {
  for (const app of getApps()) await deleteApp(app);
});

function freshMessaging(): { svc: Messaging; broker: ReturnType<typeof getMessagingBroker> } {
  const sandbox = initializeSandbox();
  const app = initializeApp({ sandbox }, `err-${Math.random().toString(36).slice(2)}`);
  return { svc: getMessaging(app), broker: getMessagingBroker(sandbox) };
}

describe('MessagingClientErrorCode static members', () => {
  it('exposes { code, message } members whose codes match production', () => {
    const invalid = MessagingClientErrorCode.INVALID_ARGUMENT as unknown as { code: string; message: string };
    const unregistered = MessagingClientErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED as unknown as {
      code: string;
    };
    const invalidToken = MessagingClientErrorCode.INVALID_REGISTRATION_TOKEN as unknown as { code: string };
    expect(invalid.code).toBe('invalid-argument');
    expect(typeof invalid.message).toBe('string');
    expect(unregistered.code).toBe('registration-token-not-registered');
    expect(invalidToken.code).toBe('invalid-registration-token');
  });
});

describe('thrown-error fidelity — send plane', () => {
  it('a rejection is instanceof FirebaseMessagingError with an admin-namespaced code', async () => {
    const { svc } = freshMessaging();
    let err: unknown;
    try {
      await svc.send({} as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FirebaseMessagingError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).constructor.name).toBe('FirebaseMessagingError');
    // The admin code is `messaging/<clientErrorCode>`.
    expect((err as { code: string }).code).toBe('messaging/invalid-argument');
  });

  it('preserves the captured wire message text through the wrap', async () => {
    const { svc } = freshMessaging();
    let err: unknown;
    try {
      await svc.send({} as never);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe('Recipient of the message is not set.');
  });
});

describe('thrown-error fidelity — topic plane', () => {
  it('per-token errors carry FirebaseMessagingError instances with admin codes', async () => {
    const { svc, broker } = freshMessaging();
    const res = await svc.subscribeToTopic([broker.getTokenFor('a'), 'bad token'], 'news');
    const entry = res.errors[0]!;
    expect(entry.error).toBeInstanceOf(FirebaseMessagingError);
    expect((entry.error as FirebaseMessagingError).code).toBe('messaging/invalid-registration-token');
  });
});
