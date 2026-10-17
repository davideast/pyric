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
import { _snapSubs, closeSubscription, nextId, nextSubId, registerSnapshotSubscription, retargetMessagingSubscriptions, rpc } from './core.js';
import type { InboundMessage, OpMessage } from '../protocol.js';
import type { ClientDb, ClientPort } from './handles.js';
import { reserveSend, type SendReservation } from './send-order.js';

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
  /** The registration id once it has settled; an op then sends at its call. */
  settledRegistrationId?: string;
  /** Ops issued before the registration id settled, in call order. */
  readonly waiting: WaitingOp[];
}

/**
 * Who issued a Messaging op decides what it is ordered against (D1). An op the
 * app issues before the registration id settles reserves its place against
 * every service on the port. The visibility sync the client issues on its own
 * is ordered only against Messaging ops: it rides in the place of the next app
 * Messaging op, or goes once the id settles, and never holds other services.
 */
type Issuer = 'app' | 'client';

interface WaitingOp {
  /** Present for an app op: its place in the port's call order. */
  reservation?: SendReservation;
  send(registrationId: string, place: SendReservation | undefined): void;
  fail(error: unknown): void;
}

export function messagingGetMessaging(db: ClientDb, registrationForScope = async (_scope?: string) => DEFAULT_REGISTRATION_ID): ClientMessaging {
  const messaging: ClientMessaging = {
    __kind: 'client-messaging',
    port: db.port,
    registrationForScope,
    registrationId: registrationForScope(),
    waiting: [],
  };
  const registration = messaging.registrationId;
  registration.then(
    registrationId => settleRegistration(messaging, registration, registrationId),
    error => failWaiting(messaging, error),
  );
  return messaging;
}

/** Sends every waiting op in call order; client ops ride in the next app op's place. */
function settleRegistration(messaging: ClientMessaging, registration: Promise<string>, registrationId: string): void {
  const isCurrent = messaging.registrationId === registration;
  if (isCurrent) messaging.settledRegistrationId = registrationId;
  let carried: WaitingOp[] = [];
  for (const op of messaging.waiting.splice(0)) {
    const place = op.reservation;
    const isClientOp = place === undefined;
    if (isClientOp) { carried.push(op); continue; }
    for (const clientOp of carried) clientOp.send(registrationId, place);
    carried = [];
    op.send(registrationId, place);
  }
  for (const clientOp of carried) clientOp.send(registrationId, undefined);
}

function failWaiting(messaging: ClientMessaging, error: unknown): void {
  for (const op of messaging.waiting.splice(0)) op.fail(error);
}

function useRegistration(messaging: ClientMessaging, registrationId: string): void {
  messaging.registrationId = Promise.resolve(registrationId);
  messaging.settledRegistrationId = registrationId;
}

/** Sends a Messaging op at its call when the registration id is known, else in call order once it settles. */
function messagingRpc(
  messaging: ClientMessaging,
  issuer: Issuer,
  build: (registrationId: string) => OpMessage,
): Promise<unknown> {
  const known = messaging.settledRegistrationId;
  const isKnown = known !== undefined;
  if (isKnown) return rpc(messaging.port, build(known));
  return new Promise<unknown>((resolve, reject) => {
    const reservation = issuer === 'app' ? reserveSend(messaging.port) : undefined;
    messaging.waiting.push({
      reservation,
      send(registrationId, place) {
        rpc(messaging.port, build(registrationId), place).then(resolve, reject);
        reservation?.release();
      },
      fail(error) {
        reservation?.release();
        reject(error);
      },
    });
  });
}

function tokenMessage(registrationId: string): OpMessage {
  return { t: 'op', id: nextId(), method: 'messaging.getToken', registrationId, recipientId: registrationId };
}

function visibilityMessage(messaging: ClientMessaging, recipientId: string, state: ClientVisibilityState): OpMessage {
  const message = { t: 'op', id: nextId(), method: 'messaging.setVisibility', recipientId, state } satisfies OpMessage;
  messaging.port.messagingVisibility = message;
  return message;
}

export async function messagingGetToken(
  messaging: ClientMessaging,
  options?: GetTokenOptions,
): Promise<string> {
  const registration = options?.serviceWorkerRegistration;
  const hasRegistration = registration !== undefined;
  if (hasRegistration) return getTokenForRegistration(messaging, registrationScope(registration));
  const result = await messagingRpc(messaging, 'app', tokenMessage) as { token: string };
  return result.token;
}

/**
 * `getToken` with a Service Worker registration resolves that scope's id
 * first, so it reserves its place at the call. Client ops still waiting for
 * the previous id ride in that place ahead of it.
 */
async function getTokenForRegistration(messaging: ClientMessaging, scope: string | undefined): Promise<string> {
  const reservation = reserveSend(messaging.port);
  const noReply = (): void => { /* The token request's own reply reports a failure. */ };
  const isSettled = messaging.settledRegistrationId !== undefined;
  if (!isSettled) messaging.waiting.push({ reservation, send() {}, fail: noReply });
  try {
    const previous = await messaging.registrationId;
    const registrationId = await messaging.registrationForScope(scope);
    useRegistration(messaging, registrationId);
    const changedRegistration = previous !== registrationId;
    const visibility = messaging.visibility;
    if (changedRegistration) {
      retargetMessagingSubscriptions(messaging.port, registrationId, message => reservation.send(message, noReply));
    }
    const resendsVisibility = changedRegistration && visibility !== undefined;
    const visibilityReply = resendsVisibility
      ? rpc(messaging.port, visibilityMessage(messaging, registrationId, visibility), reservation)
      : undefined;
    const tokenReply = rpc(messaging.port, tokenMessage(registrationId), reservation);
    reservation.release();
    await visibilityReply;
    const result = await tokenReply as { token: string };
    return result.token;
  } finally {
    reservation.release();
  }
}

export async function messagingDeleteToken(messaging: ClientMessaging): Promise<boolean> {
  return await messagingRpc(messaging, 'app', registrationId => ({
    t: 'op',
    id: nextId(),
    method: 'messaging.deleteToken',
    registrationId,
  })) as boolean;
}

/** The client's own visibility sync: ordered against Messaging ops only. */
export async function messagingSetVisibility(
  messaging: ClientMessaging,
  state: ClientVisibilityState,
): Promise<void> {
  messaging.visibility = state;
  await messagingRpc(messaging, 'client', recipientId => visibilityMessage(messaging, recipientId, state));
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
  return await messagingRpc(messaging, 'app', recipientId => ({
    t: 'op',
    id: nextId(),
    method: 'messaging.deliver',
    recipientId,
    spec,
  })) as DeliveryResult;
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
  const port = messaging.port;
  // In the routing table before this returns (D7); the frame waits for the
  // registration id in its place in the call order, so an op the app issues
  // next cannot pass it.
  const registered = registerSnapshotSubscription(port, subId, { port, next: (value) => {
    const payload = value as MessagePayload;
    const report = (stage: DeliveryStage): void => {
      void rpc(port, {
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
  }, error });
  const isDeleted = registered === undefined;
  if (isDeleted) return () => {};
  const subscription = (recipientId: string): InboundMessage => ({ t: 'sub', subId, target, recipientId });
  const known = messaging.settledRegistrationId;
  const isKnown = known !== undefined;
  if (isKnown) {
    registered.send(subscription(known));
    return () => closeSubscription(port, subId);
  }
  const reservation = reserveSend(port);
  void messaging.registrationId.then(recipientId => registered.send(subscription(recipientId), reservation)).catch(cause => {
    const isOpen = _snapSubs.has(subId);
    if (!isOpen) return;
    // Never sent, so closing it sends nothing.
    closeSubscription(port, subId);
    if (error) error(cause);
    else console.error('Messaging subscription failed:', cause);
  }).finally(() => reservation.release());
  return () => closeSubscription(port, subId);
}
