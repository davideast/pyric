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
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import type { Sandbox, SandboxContext } from '../sandbox/index.js';
import {
  bindFidRegistrationListener,
  defaultRegistration,
  deliverToMessaging,
  hasOnRegisteredHandler,
  registrationIdOf,
  resolveMessaging,
  ownMessagingSubscription,
  stateOf,
  type DeliverSpec,
  type Messaging,
  type SimulatedServiceWorkerRegistration,
} from './instance.js';
import type { DeliveredPayload, DeliveryResult } from './broker/index.js';
import type { RegisterOptions } from './types.js';

export type { Messaging, RegisterOptions };

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
export function getMessaging(target?: FirebaseApp | Sandbox | SandboxContext): Messaging {
  return resolveMessaging('window', target);
}

/**
 * Subscribe the instance to push and resolve its registration token.
 * Sandbox semantics per the captured contract: the minted token matches the
 * production shape class (142 chars, colon-separated, URL-safe, `APA91b`
 * suffix class) and is STABLE across repeated calls on the same
 * (simulated) service-worker registration — no per-call rotation.
 * Notification permission is modeled as granted in the sandbox.
 */
function isValidSwRegistration(registration: unknown): registration is object {
  if (registration === null || typeof registration !== 'object') {
    return false;
  }
  const globalSwCtor = (globalThis as { ServiceWorkerRegistration?: unknown })
    .ServiceWorkerRegistration;
  if (typeof globalSwCtor === 'function' && registration instanceof globalSwCtor) {
    return true;
  }
  const candidate = registration as { scope?: unknown };
  return typeof candidate.scope === 'string';
}

function throwPermissionBlocked(): never {
  throw new FirebaseError(
    'messaging/permission-blocked',
    'Messaging: The notification permission was not granted and blocked instead. (messaging/permission-blocked).',
  );
}

function assertValidSwRegistrationOption(options?: GetTokenOptions): void {
  const registration = options?.serviceWorkerRegistration;
  if (registration !== undefined && !isValidSwRegistration(registration)) {
    throw new FirebaseError(
      'messaging/invalid-sw-registration',
      'Messaging: The input to useServiceWorker() must be a ServiceWorkerRegistration. (messaging/invalid-sw-registration).',
    );
  }
}

async function verifyNativeNotificationPermission(
  permissions: object,
  queryPermissions: (permDesc: { name: string }) => Promise<{ state?: unknown }>,
  options?: GetTokenOptions,
): Promise<void> {
  let blocked = true;
  try {
    const status = await queryPermissions.call(permissions, { name: 'notifications' });
    blocked = status?.state === 'denied';
  } catch {
    blocked = true;
  }
  if (blocked) {
    throwPermissionBlocked();
  }
  assertValidSwRegistrationOption(options);
}

export function assertGetTokenPreconditions(options?: GetTokenOptions): void | Promise<void> {
  const globalNotification = (globalThis as { Notification?: { permission?: unknown } })
    .Notification;
  if (globalNotification?.permission !== 'denied') {
    assertValidSwRegistrationOption(options);
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalNotification, 'permission');
  if (typeof globalNotification !== 'function' || typeof descriptor?.get !== 'function') {
    throwPermissionBlocked();
  }
  const globalNavigator = (
    globalThis as {
      navigator?: {
        permissions?: {
          query?: (permDesc: { name: string }) => Promise<{ state?: unknown }>;
        };
      };
    }
  ).navigator;
  const permissions = globalNavigator?.permissions;
  const queryPermissions = permissions?.query;
  if (permissions === undefined || typeof queryPermissions !== 'function') {
    throwPermissionBlocked();
  }
  return verifyNativeNotificationPermission(permissions, queryPermissions, options);
}

export function throwInvalidOnRegisteredHandler(): never {
  throw new FirebaseError(
    'messaging/invalid-on-registered-handler',
    'Messaging: No onRegistered callback handler was provided or registered. Implement onRegistered() before register(). (messaging/invalid-on-registered-handler).',
  );
}

async function verifyNativeNotificationPermissionForRegister(
  permissions: object,
  queryPermissions: (permDesc: { name: string }) => Promise<{ state?: unknown }>,
  hasRegisteredHandler: () => boolean,
  options?: RegisterOptions,
): Promise<void> {
  let blocked = true;
  try {
    const status = await queryPermissions.call(permissions, { name: 'notifications' });
    blocked = status?.state === 'denied';
  } catch (err) {
    void err;
    blocked = true;
  }
  if (blocked) {
    throwPermissionBlocked();
  }
  if (!hasRegisteredHandler()) {
    throwInvalidOnRegisteredHandler();
  }
  assertValidSwRegistrationOption(options);
}

export function assertRegisterPreconditions(
  hasRegisteredHandler: () => boolean,
  options?: RegisterOptions,
): void | Promise<void> {
  const globalNotification = (globalThis as { Notification?: { permission?: unknown } })
    .Notification;
  if (globalNotification?.permission !== 'denied') {
    if (!hasRegisteredHandler()) {
      throwInvalidOnRegisteredHandler();
    }
    assertValidSwRegistrationOption(options);
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalNotification, 'permission');
  if (typeof globalNotification !== 'function' || typeof descriptor?.get !== 'function') {
    throwPermissionBlocked();
  }
  const globalNavigator = (
    globalThis as {
      navigator?: {
        permissions?: {
          query?: (permDesc: { name: string }) => Promise<{ state?: unknown }>;
        };
      };
    }
  ).navigator;
  const permissions = globalNavigator?.permissions;
  const queryPermissions = permissions?.query;
  if (permissions === undefined || typeof queryPermissions !== 'function') {
    throwPermissionBlocked();
  }
  return verifyNativeNotificationPermissionForRegister(
    permissions,
    queryPermissions,
    hasRegisteredHandler,
    options,
  );
}

export async function getToken(messaging: Messaging, options?: GetTokenOptions): Promise<string> {
  const state = stateOf(messaging);
  await assertGetTokenPreconditions(options);
  const registration = options?.serviceWorkerRegistration ?? defaultRegistration();
  const registrationId = registrationIdOf(registration);
  state.activeRegistrationId = registrationId;
  return state.broker.getTokenFor(registrationId);
}

/**
 * Delete the active registration token (or FID registration when no legacy
 * token is stored, notifying `onUnregistered` with the removed FID).
 */
export async function deleteToken(messaging: Messaging): Promise<boolean> {
  const state = stateOf(messaging);
  return state.broker.deleteTokenFor(state.activeRegistrationId);
}

/**
 * Register the app instance with FCM using its Firebase Installation ID (FID).
 * Delivers the FID via `onRegistered` on each call and resolves `undefined`.
 * Rejects with `messaging/invalid-on-registered-handler` if `onRegistered` was
 * not registered beforehand (`@firebase/messaging` 0.13.3).
 */
export async function register(messaging: Messaging, options?: RegisterOptions): Promise<void> {
  const state = stateOf(messaging);
  await assertRegisterPreconditions(() => hasOnRegisteredHandler(messaging), options);
  const registration = options?.serviceWorkerRegistration ?? defaultRegistration();
  const registrationId = registrationIdOf(registration);
  state.activeRegistrationId = registrationId;
  if (!hasOnRegisteredHandler(messaging)) {
    throwInvalidOnRegisteredHandler();
  }
  state.broker.registerFor(registrationId);
}

/**
 * Unregister the app instance's FID-based FCM registration and notify
 * `onUnregistered` (if set) with the unregistered FID.
 */
export async function unregister(messaging: Messaging): Promise<void> {
  const state = stateOf(messaging);
  state.broker.unregisterFor(state.activeRegistrationId);
}

/**
 * Subscribe to Firebase Installation ID registration events (`register()`).
 * Single-slot per `Messaging` instance, matching `@firebase/messaging` 0.13.3.
 */
export function onRegistered(
  messaging: Messaging,
  nextOrObserver: NextFn<string> | Observer<string>,
): Unsubscribe {
  return bindFidRegistrationListener(messaging, 'registered', nextOrObserver);
}

/**
 * Subscribe to Firebase Installation ID unregistration events (`unregister()`
 * or `deleteToken()` when an FID registration is stored).
 */
export function onUnregistered(
  messaging: Messaging,
  nextOrObserver: NextFn<string> | Observer<string>,
): Unsubscribe {
  return bindFidRegistrationListener(messaging, 'unregistered', nextOrObserver);
}

/**
 * Listen for messages delivered while a window client is VISIBLE — routing
 * keys on visibility, never focus (oracle: `messaging-web-visibility-routing`).
 */
export function onMessage(
  messaging: Messaging,
  nextOrObserver: NextFn<MessagePayload> | Observer<MessagePayload>,
): Unsubscribe {
  return ownMessagingSubscription(messaging, (state) =>
    state.broker.onForegroundMessage((payload: DeliveredPayload) => {
      const message = payload as unknown as MessagePayload;
      if (typeof nextOrObserver === 'function') {
        nextOrObserver(message);
        return;
      }
      nextOrObserver.next(message);
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
