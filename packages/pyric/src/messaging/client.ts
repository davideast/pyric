/**
 * Window-client implementation for the `firebase/messaging` mirror over
 * the sandbox {@link MessagingBroker}. Surface `messaging`, rows
 * `messaging#1`–`messaging#12` in `packages/conformance/registry/messaging.ts`.
 *
 * MODULE BOUNDARY (row messaging#17): this entry exports `getToken` /
 * `deleteToken` / `onMessage` and does NOT export `onBackgroundMessage` or
 * the BigQuery metrics toggle — those live in `pyric/messaging/sw`, the
 * mirror image. The client `ErrorCode` enum is `@internal` upstream and is
 * deliberately NOT exported here (row messaging#12).
 *
 * The `sandbox` namespace is the pyric-only headless driver (delivery
 * injection + the simulated service-worker registration); it has no
 * upstream counterpart and is additive to the mirrored surface.
 */
import type { FirebaseApp } from '../app/types.js';
import {
  defaultRegistration,
  deliverToMessaging,
  registrationIdOf,
  resolveMessaging,
  ownMessagingSubscription,
  stateOf,
  type DeliverSpec,
  type Messaging,
  type SimulatedServiceWorkerRegistration,
} from './instance.js';
import type { DeliveredPayload, DeliveryResult } from './broker/index.js';

export type { Messaging };

// ── Shared receive-plane types (upstream `@firebase/messaging` public-types) ─

/** Display-notification block inside a {@link MessagePayload}. */
export interface NotificationPayload {
  title?: string;
  body?: string;
  image?: string;
  icon?: string;
}

/** Options carried on a client {@link MessagePayload}. */
export interface FcmOptions {
  link?: string;
  analyticsLabel?: string;
}

/**
 * Received message envelope delivered to `onMessage` / `onBackgroundMessage`.
 * `from` / `collapseKey` / `messageId` are typed required (upstream parity);
 * captured production deliveries carry top-level keys
 * `data` / `from` / `messageId` (+ `notification`) — `collapseKey` was not
 * observed on the wire and the sandbox likewise omits it at runtime.
 */
export interface MessagePayload {
  notification?: NotificationPayload;
  data?: { [key: string]: string };
  fcmOptions?: FcmOptions;
  from: string;
  collapseKey: string;
  messageId: string;
}

/**
 * Callback / observer / teardown shapes — structurally identical to the
 * `@firebase/util` types the upstream entry re-exports (declared locally
 * because `@firebase/util` is not a direct dependency of `pyric`; the
 * tier-2 assignability census closes exact type parity).
 */
export type NextFn<T> = (value: T) => void;
export interface Observer<T> {
  next: NextFn<T>;
  error: (error: Error) => void;
  complete: () => void;
}
export type Unsubscribe = () => void;

/** Options for {@link getToken}. */
export interface GetTokenOptions {
  vapidKey?: string;
  /** A (simulated) service-worker registration; token stability keys on its identity. */
  serviceWorkerRegistration?: object;
}

// ── The mirrored client surface ──────────────────────────────────────────────

/**
 * Return the FCM `Messaging` instance for the given (or default) app —
 * window-client plane (upstream component name `messaging`).
 */
export function getMessaging(app?: FirebaseApp): Messaging {
  return resolveMessaging('window', app);
}

/**
 * Subscribe the instance to push and resolve its registration token.
 * Sandbox semantics per the captured contract: the minted token matches the
 * production shape class (142 chars, colon-separated, URL-safe, `APA91b`
 * suffix class) and is STABLE across repeated calls on the same
 * (simulated) service-worker registration — no per-call rotation.
 * Notification permission is modeled as granted in the sandbox.
 */
export async function getToken(messaging: Messaging, options?: GetTokenOptions): Promise<string> {
  const state = stateOf(messaging);
  const registration = options?.serviceWorkerRegistration ?? defaultRegistration();
  const registrationId = registrationIdOf(registration);
  state.activeRegistrationId = registrationId;
  return state.broker.getTokenFor(registrationId);
}

/**
 * Delete the active registration token. Resolves truthy; afterwards no
 * message reaches the client on either route and a send to the dead token
 * surfaces the captured UNREGISTERED envelope on the send plane
 * (oracle: `messaging-web-deletetoken-unregistered`).
 */
export async function deleteToken(messaging: Messaging): Promise<boolean> {
  const state = stateOf(messaging);
  return state.broker.deleteTokenFor(state.activeRegistrationId);
}

/**
 * Listen for messages delivered while a window client is VISIBLE — routing
 * keys on visibility, never focus (oracle: `messaging-web-visibility-routing`).
 */
export function onMessage(
  messaging: Messaging,
  nextOrObserver: NextFn<MessagePayload> | Observer<MessagePayload>,
): Unsubscribe {
  const next = typeof nextOrObserver === 'function' ? nextOrObserver : nextOrObserver.next;
  return ownMessagingSubscription(messaging, (state) =>
    state.broker.onForegroundMessage((payload: DeliveredPayload) => {
      next(payload as unknown as MessagePayload);
    }));
}

/** Whether every API FCM requires exists here — always true in the sandbox. */
export async function isSupported(): Promise<boolean> {
  return true;
}

// ── Sandbox-only driver namespace (no upstream counterpart) ──────────────────

export const sandbox = {
  /**
   * Inject a delivery into the client plane, optionally setting the
   * simulated window client's visibility first. Routes through the broker's
   * captured visibility rule, so a `visible` spec lands on `onMessage`
   * handlers and a `hidden` spec on `onBackgroundMessage` handlers.
   */
  deliver(messaging: Messaging, spec: DeliverSpec): Promise<DeliveryResult> {
    return deliverToMessaging(messaging, spec);
  },
  /** The module-default simulated service-worker registration. */
  registration(): SimulatedServiceWorkerRegistration {
    return defaultRegistration();
  },
};

export type { DeliverSpec, DeliveryResult, SimulatedServiceWorkerRegistration };
