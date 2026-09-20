import type { DeliveryStage } from 'pyric/messaging/internal';
import { observeMessageDisplay } from './messaging-display.js';
/** Worker-backed Firebase Messaging client/SW receive planes. */
import type {
  DeliverSpec,
  DeliveryResult,
  GetTokenOptions,
  MessagePayload,
  NextFn,
  Observer,
  Unsubscribe,
} from 'pyric/messaging';
import { closeSubscription, nextId, nextSubId, openSnapshotSubscription, retargetMessagingSubscriptions, rpc } from './core.js';
import type { OpMessage } from '../protocol.js';
import type { ClientDb, ClientPort } from './handles.js';

type ClientVisibilityState = 'visible' | 'hidden';

const DEFAULT_REGISTRATION_ID = 'swreg-port-default';
function registrationScope(registration: object | undefined): string | undefined {
  const hasScope = registration !== undefined && 'scope' in registration;
  if (!hasScope) return undefined;
  const scope = registration.scope;
  return typeof scope === 'string' ? scope : undefined;
}

export interface ClientMessaging {
  readonly __kind: 'client-messaging';
  readonly port: ClientPort;
  registrationId: Promise<string>;
  registrationForScope: (scope?: string) => Promise<string>;
  visibility?: ClientVisibilityState;
}

export function messagingGetMessaging(db: ClientDb, registrationForScope = async (_scope?: string) => DEFAULT_REGISTRATION_ID): ClientMessaging {
  return {
    __kind: 'client-messaging',
    port: db.port,
    registrationForScope,
    registrationId: registrationForScope(),
  };
}

export async function messagingGetToken(
  messaging: ClientMessaging,
  options?: GetTokenOptions,
): Promise<string> {
  const previous = await messaging.registrationId;
  const registration = options?.serviceWorkerRegistration;
  const hasRegistration = registration !== undefined;
  const registrationId = hasRegistration
    ? await messaging.registrationForScope(registrationScope(registration))
    : previous;
  messaging.registrationId = Promise.resolve(registrationId);
  const changedRegistration = previous !== registrationId;
  if (changedRegistration) {
    retargetMessagingSubscriptions(messaging.port, registrationId);
    const visibility = messaging.visibility;
    const hasVisibility = visibility !== undefined;
    if (hasVisibility) await messagingSetVisibility(messaging, visibility);
  }
  const result = await rpc(messaging.port, {
    t: 'op',
    id: nextId(),
    method: 'messaging.getToken',
    registrationId,
    recipientId: registrationId,
  }) as { token: string };
  return result.token;
}

export async function messagingDeleteToken(messaging: ClientMessaging): Promise<boolean> {
  return await rpc(messaging.port, {
    t: 'op',
    id: nextId(),
    method: 'messaging.deleteToken',
    registrationId: await messaging.registrationId,
  }) as boolean;
}

export async function messagingSetVisibility(
  messaging: ClientMessaging,
  state: ClientVisibilityState,
): Promise<void> {
  messaging.visibility = state;
  const message = {
    t: 'op',
    id: nextId(),
    method: 'messaging.setVisibility',
    recipientId: await messaging.registrationId,
    state,
  } satisfies OpMessage;
  messaging.port.messagingVisibility = message;
  await rpc(messaging.port, message);
}

/**
 * The worker transport for `pyric/messaging`'s `sandbox.deliver` — injects a
 * simulated delivery into the app's real (worker-hosted) broker. The full
 * {@link DeliverSpec} crosses the wire; the host sets this port's client
 * visibility from `spec.visibilityState` before routing, so `visible` reaches
 * `onMessage` and `hidden` reaches `onBackgroundMessage`.
 */
export async function messagingDeliver(
  messaging: ClientMessaging,
  spec: DeliverSpec,
): Promise<DeliveryResult> {
  return await rpc(messaging.port, {
    t: 'op',
    id: nextId(),
    method: 'messaging.deliver',
    recipientId: await messaging.registrationId,
    spec,
  }) as DeliveryResult;
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
  let stopped = false;
  void messaging.registrationId.then(recipientId => {
    if (stopped) return;
    openSnapshotSubscription(
      messaging.port,
      subId,
      { port: messaging.port, next: (value) => {
        const payload = value as MessagePayload;
        const report = (stage: DeliveryStage): void => {
          void rpc(messaging.port, {
            t: 'op', id: nextId(), method: 'messaging.acknowledge',
            subId, messageId: payload.messageId, stage,
          }).catch(() => { /* Evidence is best effort, never replay delivery after reconnect. */ });
        };
        report('received');
        const stopObserving = observeMessageDisplay(payload.messageId, report);
        try {
          const completed = next(payload);
          void Promise.resolve(completed).then(
            () => report('handler-completed'),
            () => report('handler-rejected'),
          ).finally(stopObserving);
        } catch (cause) {
          report('handler-rejected');
          stopObserving();
          throw cause;
        }
      }, error },
      { t: 'sub', subId, target, recipientId },
    );
  }).catch(cause => {
    if (stopped) return;
    if (error) error(cause);
    else console.error('Messaging subscription failed:', cause);
  });
  return () => {
    stopped = true;
    closeSubscription(messaging.port, subId);
  };
}
