/** Worker-backed Firebase Messaging client/SW receive planes. */
import type {
  GetTokenOptions,
  MessagePayload,
  NextFn,
  Observer,
  Unsubscribe,
} from 'pyric/messaging';
import { closeSubscription, nextId, nextSubId, openSnapshotSubscription, rpc } from './core.js';
import type { ClientDb, ClientPort } from './handles.js';

type ClientVisibilityState = 'visible' | 'hidden';

const DEFAULT_REGISTRATION_ID = 'swreg-port-default';
const registrationIds = new WeakMap<object, string>();
let registrationCounter = 0;

function registrationIdOf(registration: object | undefined): string {
  if (registration === undefined) return DEFAULT_REGISTRATION_ID;
  const existing = registrationIds.get(registration);
  if (existing) return existing;
  const id = `swreg-page-${++registrationCounter}`;
  registrationIds.set(registration, id);
  return id;
}

export interface ClientMessaging {
  readonly __kind: 'client-messaging';
  readonly port: ClientPort;
  activeRegistrationId: string;
}

export function messagingGetMessaging(db: ClientDb): ClientMessaging {
  return {
    __kind: 'client-messaging',
    port: db.port,
    activeRegistrationId: DEFAULT_REGISTRATION_ID,
  };
}

export async function messagingGetToken(
  messaging: ClientMessaging,
  options?: GetTokenOptions,
): Promise<string> {
  const registrationId = registrationIdOf(options?.serviceWorkerRegistration);
  messaging.activeRegistrationId = registrationId;
  const result = await rpc(messaging.port, {
    t: 'op',
    id: nextId(),
    method: 'messaging.getToken',
    registrationId,
  }) as { token: string };
  return result.token;
}

export async function messagingDeleteToken(messaging: ClientMessaging): Promise<boolean> {
  return await rpc(messaging.port, {
    t: 'op',
    id: nextId(),
    method: 'messaging.deleteToken',
    registrationId: messaging.activeRegistrationId,
  }) as boolean;
}

export async function messagingSetVisibility(
  messaging: ClientMessaging,
  state: ClientVisibilityState,
): Promise<void> {
  await rpc(messaging.port, {
    t: 'op',
    id: nextId(),
    method: 'messaging.setVisibility',
    state,
  });
}

export function messagingSubscribe(
  messaging: ClientMessaging,
  target: 'messaging.foreground' | 'messaging.background',
  nextOrObserver: NextFn<MessagePayload> | Observer<MessagePayload>,
): Unsubscribe {
  const next = typeof nextOrObserver === 'function'
    ? nextOrObserver
    : nextOrObserver.next.bind(nextOrObserver);
  const error = typeof nextOrObserver === 'function'
    ? undefined
    : (value: unknown) => nextOrObserver.error(
        value instanceof Error ? value : new Error(String(value)),
      );
  const subId = nextSubId();
  openSnapshotSubscription(
    messaging.port,
    subId,
    { port: messaging.port, next: (value) => next(value as MessagePayload), error },
    { t: 'sub', subId, target },
  );
  return () => closeSubscription(messaging.port, subId);
}
