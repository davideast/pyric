/**
 * `pyric-admin/messaging` -- error-class and error-code fidelity (`v14.5.1`).
 *
 * Verifies `MessagingErrorCode` key/value parity against `firebase-admin/messaging`,
 * `FirebaseMessagingError` inheritance (`PrefixedFirebaseError`, `hasCode`,
 * `toJSON`), and thrown/returned error fidelity across the send and topic planes.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  FirebaseMessagingError as UpstreamFirebaseMessagingError,
  MessagingErrorCode as UpstreamMessagingErrorCode,
} from 'firebase-admin/messaging';
import { initializeSandbox } from 'pyric/sandbox';
import { getMessagingBroker } from 'pyric/messaging/internal';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { PrefixedFirebaseError } from '../../src/app/firebase-error.js';
import {
  FirebaseMessagingError,
  MessagingErrorCode,
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

describe('MessagingErrorCode constant object', () => {
  it('matches every key and string code in firebase-admin/messaging', () => {
    expect(typeof MessagingErrorCode).toBe('object');
    expect(typeof UpstreamMessagingErrorCode).toBe('object');
    expect(MessagingErrorCode).toEqual(UpstreamMessagingErrorCode);
    expect(Object.keys(MessagingErrorCode).length).toBe(21);
    expect(MessagingErrorCode.INVALID_ARGUMENT).toBe('invalid-argument');
    expect(MessagingErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED).toBe(
      'registration-token-not-registered',
    );
    expect(MessagingErrorCode.INSTALLATION_ID_NOT_REGISTERED).toBe(
      'installation-id-not-registered',
    );
    expect(MessagingErrorCode.TOPICS_SUBSCRIPTION_RATE_EXCEEDED).toBe(
      'topics-subscription-rate-exceeded',
    );
  });
});

describe('FirebaseMessagingError -- PrefixedFirebaseError inheritance', () => {
  it('extends PrefixedFirebaseError and implements toJSON() and hasCode() matching upstream', () => {
    const info = {
      code: MessagingErrorCode.INVALID_ARGUMENT,
      message: 'Invalid argument provided.',
    };
    const err = new FirebaseMessagingError(info, 'Bad field');
    const upstreamErr = new (UpstreamFirebaseMessagingError as unknown as new (
      i: { code: string; message: string },
      m?: string,
    ) => FirebaseMessagingError)(info, 'Bad field');
    expect(err).toBeInstanceOf(FirebaseMessagingError);
    expect(err).toBeInstanceOf(PrefixedFirebaseError);
    expect(err).toBeInstanceOf(Error);
    expect(err.codePrefix).toBe('messaging');
    expect(err.code).toBe('messaging/invalid-argument');
    expect(err.hasCode('invalid-argument')).toBe(upstreamErr.hasCode('invalid-argument'));
    expect(err.hasCode('messaging/invalid-argument')).toBe(
      upstreamErr.hasCode('messaging/invalid-argument'),
    );
    expect(err.hasCode('unknown-error')).toBe(false);
    expect(err.toJSON()).toEqual(upstreamErr.toJSON());
  });
});

describe('thrown-error fidelity -- send plane', () => {
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

describe('thrown-error fidelity -- topic plane', () => {
  it('per-token errors carry FirebaseMessagingError instances with admin codes', async () => {
    const { svc, broker } = freshMessaging();
    const res = await svc.subscribeToTopic([broker.getTokenFor('a'), 'bad token'], 'news');
    const entry = res.errors[0];
    expect(entry).toBeDefined();
    expect(entry?.error).toBeInstanceOf(FirebaseMessagingError);
    expect((entry?.error as FirebaseMessagingError).code).toBe(
      'messaging/invalid-registration-token',
    );
  });
});
