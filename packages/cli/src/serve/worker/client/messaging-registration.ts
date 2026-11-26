/**
 * Worker-backed Firebase Installation ID (FID) registration operations and
 * listeners (`register`, `unregister`, `onRegistered`, `onUnregistered`).
 */
import type { NextFn, Observer, RegisterOptions, Unsubscribe } from 'pyric/messaging';
import {
  assertRegisterPreconditions,
  throwInvalidOnRegisteredHandler,
} from 'pyric/messaging/internal';
import type { InboundMessage, OpMessage } from '../protocol.js';
import {
  _snapSubs,
  closeSubscription,
  nextId,
  nextSubId,
  registerSnapshotSubscription,
} from './core.js';
import {
  messagingRpc,
  messagingRpcForScope,
  registrationScope,
  type ClientMessaging,
} from './messaging.js';
import { reserveSend, type SendReservation } from './send-order.js';

type FidSubTarget = 'messaging.registered' | 'messaging.unregistered';

function registerOpMessage(registrationId: string): OpMessage {
  return {
    t: 'op',
    id: nextId(),
    method: 'messaging.register',
    registrationId,
    recipientId: registrationId,
  };
}

function invokeFidCallback(
  handler: NextFn<string> | Observer<string> | null | undefined,
  fid: string,
): void {
  if (!handler) {
    return;
  }
  if (typeof handler === 'function') {
    handler(fid);
    return;
  }
  handler.next(fid);
}

function forwardFidError(
  handler: NextFn<string> | Observer<string> | null | undefined,
  cause: unknown,
): void {
  if (!handler || typeof handler === 'function') {
    console.error('Messaging registration subscription failed:', cause);
    return;
  }
  handler.error(cause instanceof Error ? cause : new Error(String(cause)));
}

function subscribeFidEvents(
  messaging: ClientMessaging,
  target: FidSubTarget,
  getCurrentHandler: () => NextFn<string> | Observer<string> | null | undefined,
): Unsubscribe {
  const subId = nextSubId();
  const port = messaging.port;
  const registered = registerSnapshotSubscription(port, subId, {
    port,
    next: (value) => {
      if (typeof value === 'string') {
        invokeFidCallback(getCurrentHandler(), value);
      }
    },
    error: (err) => forwardFidError(getCurrentHandler(), err),
  });
  if (registered === undefined) {
    return () => {};
  }
  const buildSub = (recipientId: string): InboundMessage => ({
    t: 'sub',
    subId,
    target,
    recipientId,
  });
  const known = messaging.settledRegistrationId;
  if (known !== undefined) {
    registered.send(buildSub(known));
    return () => closeSubscription(port, subId);
  }
  const reservation = reserveSend(port);
  void messaging.registrationId
    .then((recipientId) => registered.send(buildSub(recipientId), reservation))
    .catch((cause) => {
      if (!_snapSubs.has(subId)) {
        return;
      }
      closeSubscription(port, subId);
      forwardFidError(getCurrentHandler(), cause);
    })
    .finally(() => reservation.release());
  return () => closeSubscription(port, subId);
}

async function messagingRegisterAfterPrecheck(
  messaging: ClientMessaging,
  precheck: Promise<void>,
  options: RegisterOptions | undefined,
  reservation: SendReservation,
): Promise<void> {
  try {
    await precheck;
  } catch (error) {
    reservation.release();
    throw error;
  }
  if (options?.serviceWorkerRegistration !== undefined) {
    await messagingRpcForScope(
      messaging,
      registrationScope(options.serviceWorkerRegistration),
      registerOpMessage,
      reservation,
    );
  } else {
    await messagingRpc(messaging, 'app', registerOpMessage, reservation);
  }
  if (!messaging.onRegisteredHandler) {
    throwInvalidOnRegisteredHandler();
  }
}

export async function messagingRegister(
  messaging: ClientMessaging,
  options?: RegisterOptions,
): Promise<void> {
  const precheck = assertRegisterPreconditions(
    () => Boolean(messaging.onRegisteredHandler),
    options,
  );
  if (precheck !== undefined) {
    const reservation = reserveSend(messaging.port);
    return messagingRegisterAfterPrecheck(messaging, precheck, options, reservation);
  }
  if (options?.serviceWorkerRegistration !== undefined) {
    await messagingRpcForScope(
      messaging,
      registrationScope(options.serviceWorkerRegistration),
      registerOpMessage,
    );
  } else {
    await messagingRpc(messaging, 'app', registerOpMessage);
  }
  if (!messaging.onRegisteredHandler) {
    throwInvalidOnRegisteredHandler();
  }
}

export async function messagingUnregister(messaging: ClientMessaging): Promise<void> {
  await messagingRpc(messaging, 'app', (registrationId) => ({
    t: 'op',
    id: nextId(),
    method: 'messaging.unregister',
    registrationId,
    recipientId: registrationId,
  }));
}

export function messagingOnRegistered(
  messaging: ClientMessaging,
  nextOrObserver: NextFn<string> | Observer<string>,
): Unsubscribe {
  messaging.onRegisteredHandler = nextOrObserver;
  if (!messaging.onRegisteredUnsub) {
    messaging.onRegisteredUnsub = subscribeFidEvents(
      messaging,
      'messaging.registered',
      () => messaging.onRegisteredHandler,
    );
  }
  return () => {
    if (messaging.onRegisteredHandler === nextOrObserver) {
      messaging.onRegisteredHandler = null;
      messaging.onRegisteredUnsub?.();
      messaging.onRegisteredUnsub = null;
    }
  };
}

export function messagingOnUnregistered(
  messaging: ClientMessaging,
  nextOrObserver: NextFn<string> | Observer<string>,
): Unsubscribe {
  messaging.onUnregisteredHandler = nextOrObserver;
  if (!messaging.onUnregisteredUnsub) {
    messaging.onUnregisteredUnsub = subscribeFidEvents(
      messaging,
      'messaging.unregistered',
      () => messaging.onUnregisteredHandler,
    );
  }
  return () => {
    if (messaging.onUnregisteredHandler === nextOrObserver) {
      messaging.onUnregisteredHandler = null;
      messaging.onUnregisteredUnsub?.();
      messaging.onUnregisteredUnsub = null;
    }
  };
}
